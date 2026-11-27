// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { runAuditForQaDir } from './audit.mjs';
import { syncLivingCodeMap } from './codemap.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult, outcomeToExitCode } from './core/outcome.mjs';
import { resolvePlaywrightCli } from './core/playwright-resolve.mjs';
import { flattenPlaywrightResults } from './core/playwright-results.mjs';
import { runPlaywright } from './core/proc.mjs';
import { redactSecrets } from './core/redact.mjs';
import { isLoopbackHttpUrl, loadRuntimeConfig } from './core/runtime-config.mjs';
import { syncQuarantineFromLedger } from './flaky.mjs';
import { computeImpact } from './impact.mjs';
import { beginRunLedger, finalizeRunLedger } from './ledger.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import {
  buildPlaywrightChildEnv,
  buildSuitePlaywrightArgs,
  extractRunnerFailedSpecs,
  resolveExplicitFileTargets,
  summarizePlaywrightResultsFile,
} from './runner/env-and-failures.mjs';

export { buildPlaywrightChildEnv, buildSuitePlaywrightArgs, resolveExplicitFileTargets };

/**
 * Pure structured core execution for Playwright suites + Run Ledger + optional 4-layer Audit.
 * Never hijacks console; returns rich structured data for both CLI and MCP.
 * @param {Record<string, any>} [options]
 */
export async function executeSuiteCore(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    return {
      ok: false,
      exitCode: 1,
      error: lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option',
    };
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir || !resolvePlaywrightCli(qaDir)) {
    return {
      ok: false,
      exitCode: 1,
      error:
        lang === 'zh'
          ? `未在 ${target} 找到已安装依赖的 Playwright QA 目录，请先运行 init。`
          : `Playwright QA directory with installed dependencies not found under ${target}. Run init first.`,
    };
  }

  const wbCfg = loadWorkbenchConfig({ qaDir });
  if (!wbCfg.ok) {
    return {
      ok: false,
      exitCode: 2,
      outcome: 'blocked',
      errors: wbCfg.errors,
      error: wbCfg.errors.map((e) => `[Config Blocked] ${e}`).join('\n'),
    };
  }
  const suite = (options.suite || 'smoke').toLowerCase();
  const VALID_SUITES = new Set(['smoke', 'e2e', 'api', 'a11y', 'critical', 'seed', 'impact', 'all']);
  if (!VALID_SUITES.has(suite)) {
    return {
      ok: false,
      exitCode: 64,
      outcome: 'usage',
      error: `Unknown suite "${options.suite}". Valid suites: smoke, e2e, api, a11y, critical, seed, impact, all.`,
    };
  }
  const runtimeCfgRes = loadRuntimeConfig(qaDir);
  if (runtimeCfgRes.exists && !runtimeCfgRes.ok) {
    return {
      ok: false,
      exitCode: 2,
      outcome: 'blocked',
      errors: runtimeCfgRes.errors,
      error: runtimeCfgRes.errors.map((e) => `[Runtime Config Blocked] ${e}`).join('\n'),
    };
  }
  /** @type {Record<string, string>} */
  const overrides = {};
  if (options.baseUrl) {
    overrides.TEST_BASE_URL = options.baseUrl;
  } else if (!process.env.TEST_BASE_URL && runtimeCfgRes.ok && runtimeCfgRes.config?.baseURL) {
    overrides.TEST_BASE_URL = runtimeCfgRes.config.baseURL;
  }
  if (options.allowMutation === true) overrides.TEST_ALLOW_MUTATION = '1';
  else if (options.allowMutation === false) overrides.TEST_ALLOW_MUTATION = '0';

  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  const safety = evaluateTargetSafety(mergedEnv);

  if (!safety.ok) {
    return {
      ok: false,
      exitCode: 2,
      errors: safety.errors,
      error: safety.errors.map((e) => `[Target Guard Blocked] ${e}`).join('\n'),
    };
  }

  const needsOnlineUrl = ['e2e', 'api', 'seed', 'all'].includes(suite);
  if (needsOnlineUrl && !safety.baseURL) {
    return {
      ok: false,
      exitCode: 2,
      error:
        lang === 'zh'
          ? `[配置错误] 运行套件 "${suite}" 必须配置合法的 TEST_BASE_URL（或传入 --base-url），禁止未配 URL 整套 skip 冒充通过。`
          : `[Config Error] Suite "${suite}" requires a valid TEST_BASE_URL (or --base-url); refusing to silently skip.`,
    };
  }

  let pwArgs = [];
  let impactResult = null;
  const fileTargets = resolveExplicitFileTargets(options.files, options.line);

  if (fileTargets.length > 0) {
    pwArgs = ['test', ...fileTargets];
  } else if (suite === 'impact') {
    impactResult = options.precomputedImpact || (await computeImpact(target, { qaDir: options.qaDir, base: options.base }));
    if (impactResult.mode === 'targeted') {
      pwArgs.push('test', 'tests/smoke', ...impactResult.specs, '--project=smoke');
      if (safety.baseURL) {
        pwArgs.push('--project=e2e', '--project=api');
      }
    } else if (impactResult.mode === 'only-changed' && impactResult.baseRef) {
      pwArgs.push('test', `--only-changed=${impactResult.baseRef}`, '--project=smoke');
      if (safety.baseURL) pwArgs.push('--project=e2e', '--project=api');
    } else {
      pwArgs.push('test', '--project=smoke');
      if (safety.baseURL) pwArgs.push('--project=e2e', '--project=api');
    }
  } else {
    pwArgs = ['test', ...buildSuitePlaywrightArgs(suite, { hasBaseUrl: Boolean(safety.baseURL) })];
  }

  if (options.grep) pwArgs.push(`--grep=${options.grep}`);
  if (!safety.allowMutation && suite !== 'seed') {
    pwArgs.push('--grep-invert=@mutation');
  }
  if (options.lastFailed) pwArgs.push('--last-failed');
  if (options.failOnFlaky || options.audit) pwArgs.push('--fail-on-flaky-tests');
  if (options.workers !== undefined) pwArgs.push(`--workers=${options.workers}`);
  if (options.retries !== undefined) pwArgs.push(`--retries=${options.retries}`);
  if (options.headed) pwArgs.push('--headed');
  if (options.ui) pwArgs.push('--ui');
  if (options.debug) pwArgs.push('--debug');
  if (Array.isArray(options.extraArgs) && options.extraArgs.length > 0) {
    pwArgs.push(...options.extraArgs);
  }

  const repoDir = path.resolve(target) === path.resolve(qaDir) ? path.dirname(qaDir) : path.resolve(target);
  const safePartialId = options.partialHealSessionId
    ? String(options.partialHealSessionId).replace(/[^a-zA-Z0-9_-]/g, '')
    : '';
  const isolatedResultsAbs = options.isolatedResultsPath
    ? path.resolve(qaDir, options.isolatedResultsPath)
    : safePartialId
      ? path.join(qaDir, '.aitest', 'heals', safePartialId, `attempt-${Date.now()}-results.json`)
      : null;
  const skipGlobalLedgerLatest =
    options.skipGlobalLedgerLatest !== undefined
      ? Boolean(options.skipGlobalLedgerLatest)
      : Boolean(options.partialHealSessionId || options.isolatedResultsPath);

  const defaultResultsPath = path.join(qaDir, 'reports', 'results.json');
  const latestLedgerPath = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  const prevResultsExisted = fs.existsSync(defaultResultsPath);
  const prevResultsRaw = prevResultsExisted ? fs.readFileSync(defaultResultsPath, 'utf8') : null;
  const prevLatestExisted = fs.existsSync(latestLedgerPath);
  const prevLatestRaw = prevLatestExisted ? fs.readFileSync(latestLedgerPath, 'utf8') : null;

  const ledgerBegin = skipGlobalLedgerLatest
    ? { runId: safePartialId ? `heal_${safePartialId}` : `partial_${Date.now()}` }
    : beginRunLedger(qaDir, {
        suite,
        command: `playwright ${pwArgs.join(' ')}`,
        env: mergedEnv,
        repoDir,
      });

  if (isolatedResultsAbs) {
    fs.mkdirSync(path.dirname(isolatedResultsAbs), { recursive: true });
  }

  const runEnv = buildPlaywrightChildEnv(process.env, {
    ...overrides,
    ...(safety.allowMutation ? { TEST_ALLOW_MUTATION: '1' } : {}),
    ...(mergedEnv.TEST_STRICT_READONLY === undefined ? { TEST_STRICT_READONLY: safety.strictReadonly ? '1' : '0' } : {}),
    ...(isolatedResultsAbs
      ? { PLAYWRIGHT_JSON_OUTPUT_FILE: isolatedResultsAbs, PLAYWRIGHT_JSON_OUTPUT_NAME: isolatedResultsAbs }
      : {}),
    AITEST_ACTIVE_SUITE: suite,
    AITEST_RUN_ID: ledgerBegin.runId,
  });

  if (typeof options.onProgress === 'function') {
    options.onProgress({ progress: 10, total: 100, message: `Starting suite "${suite}" (runId=${ledgerBegin.runId})` });
  }

  const inheritStdio = Boolean(options.inheritStdio) && !options.json;
  const timeoutMs = options.timeoutMs !== undefined ? Number(options.timeoutMs) : 45 * 60_000;
  let pwRes;
  try {
    pwRes = await runPlaywright(qaDir, pwArgs, {
      env: runEnv,
      inheritStdio,
      capture: !inheritStdio,
      timeoutMs,
      signal: options.signal,
    });
  } finally {
    if (isolatedResultsAbs) {
      if (!fs.existsSync(isolatedResultsAbs) && fs.existsSync(defaultResultsPath)) {
        try {
          const curDefaultRaw = fs.readFileSync(defaultResultsPath, 'utf8');
          if (!prevResultsExisted || curDefaultRaw !== prevResultsRaw) {
            fs.writeFileSync(isolatedResultsAbs, curDefaultRaw, 'utf8');
          }
        } catch {
          // best-effort isolated results extraction
        }
      }
      if (skipGlobalLedgerLatest) {
        try {
          if (prevResultsExisted && prevResultsRaw !== null) {
            fs.writeFileSync(defaultResultsPath, prevResultsRaw, 'utf8');
          } else if (!prevResultsExisted && fs.existsSync(defaultResultsPath)) {
            fs.unlinkSync(defaultResultsPath);
          }
        } catch {
          // ignore restore failure
        }
      }
    }
    if (skipGlobalLedgerLatest) {
      try {
        if (prevLatestExisted && prevLatestRaw !== null) {
          fs.writeFileSync(latestLedgerPath, prevLatestRaw, 'utf8');
        } else if (!prevLatestExisted && fs.existsSync(latestLedgerPath)) {
          fs.unlinkSync(latestLedgerPath);
        }
      } catch {
        // ignore restore failure
      }
    }
  }

  const ledgerFinal = skipGlobalLedgerLatest
    ? null
    : finalizeRunLedger(qaDir, ledgerBegin.runId, {
        exitCode: pwRes.code,
      });
  const partialSummary = skipGlobalLedgerLatest
    ? summarizePlaywrightResultsFile(isolatedResultsAbs || defaultResultsPath)
    : null;

  if (!skipGlobalLedgerLatest) {
    try {
      syncQuarantineFromLedger(qaDir);
    } catch {
      // non-fatal quarantine telemetry update
    }
  }

  let codeMapSummary = null;
  if (!skipGlobalLedgerLatest && fs.existsSync(path.join(qaDir, 'knowledge', 'code-map.json'))) {
    try {
      codeMapSummary = await syncLivingCodeMap(qaDir, { lang, engine: 'builtin', syncImpact: false, skipWriteIfUnchanged: true });
    } catch {
      // non-fatal knowledge sync warning
    }
  }

  if (typeof options.onProgress === 'function') {
    options.onProgress({ progress: 80, total: 100, message: `Playwright finished (code=${pwRes.code})` });
  }

  let auditOut = null;
  if (options.audit && !skipGlobalLedgerLatest) {
    auditOut = runAuditForQaDir(qaDir, {
      checkSpecs: true,
      requireE2e: suite === 'e2e' || suite === 'all',
      allowMutation: safety.allowMutation,
      expectedRunId: ledgerBegin.runId,
    });
  }

  if (typeof options.onProgress === 'function') {
    options.onProgress({ progress: 100, total: 100, message: 'Completed suite execution & gates' });
  }

  const finalCode =
    pwRes.code !== 0
      ? pwRes.code
      : auditOut && !auditOut.ok
        ? outcomeToExitCode(auditOut.outcome)
        : 0;
  const outcome = auditOut?.outcome || (finalCode === 0 ? 'pass' : finalCode === 2 ? 'blocked' : 'fail');
  const failedSpecs = extractRunnerFailedSpecs(ledgerFinal?.tests || partialSummary?.tests || []);
  const resolvedCounts = ledgerFinal?.manifest?.counts || partialSummary?.counts || auditOut?.stats || null;
  const executedCount = Number(
    resolvedCounts?.executed ??
      Number(resolvedCounts?.passed ?? 0) + Number(resolvedCounts?.failed ?? 0) + Number(resolvedCounts?.flaky ?? 0)
  );
  const hasNonSmokeFiles =
    fileTargets.length > 0 && fileTargets.some((f) => !f.replace(/\\/g, '/').includes('tests/smoke'));
  const ranNonSeedTests =
    suite !== 'seed' &&
    (suite !== 'smoke' || hasNonSmokeFiles) &&
    (executedCount > 0 || (resolvedCounts === null && pwRes.code === 0));
  const isRemoteBusiness = Boolean(safety.baseURL && !isLoopbackHttpUrl(safety.baseURL) && ranNonSeedTests);
  const acceptanceScope =
    isRemoteBusiness || (safety.baseURL && ['e2e', 'api', 'all'].includes(suite))
      ? 'business-e2e'
      : 'local-workbench';

  return {
    ok: finalCode === 0,
    exitCode: finalCode,
    outcome,
    runId: skipGlobalLedgerLatest ? null : ledgerBegin.runId,
    resultsPath: isolatedResultsAbs || defaultResultsPath,
    partialScope: skipGlobalLedgerLatest,
    qaDir,
    suite,
    acceptanceScope,
    impact: impactResult,
    counts: resolvedCounts,
    failures: failedSpecs,
    audit: auditOut
      ? {
          ok: auditOut.ok,
          outcome: auditOut.outcome,
          trustTier: auditOut.trustTier,
          gates: auditOut.gates,
          errors: auditOut.errors,
          warnings: auditOut.warnings,
        }
      : null,
    codeMapRevision: codeMapSummary?.revision ?? null,
    rawStdout: options.verbosity === 'full' ? redactSecrets(pwRes.stdout || '') : undefined,
    rawStderr: pwRes.stderr ? redactSecrets(pwRes.stderr).slice(0, 2000) : undefined,
  };
}

/**
 * @param {Record<string, any>} [options]
 * @returns {Promise<number>}
 */
export async function runSuiteCommand(options = {}) {
  const res = await executeSuiteCore({
    ...options,
    inheritStdio: !options.json,
  });

  if (!options.json) {
    if (!res.runId && res.error) {
      console.error(res.error);
    } else {
      if (res.impact) {
        console.log(`[Impact] ${res.impact.mode.toUpperCase()}: ${res.impact.reason}`);
      }
      console.log(`[Runner] runId=${res.runId} suite=${res.suite} scope=${res.acceptanceScope}`);
      if (res.codeMapRevision !== null) {
        console.log(`[CodeMap] Revision #${res.codeMapRevision}`);
      }
      if (res.audit) {
        if (res.counts) {
          console.log(
            `\n[Audit] runId=${res.runId} passed=${res.counts.passed} failed=${res.counts.failed} flaky=${res.counts.flaky} skipped=${res.counts.skipped}`
          );
        }
        for (const w of res.audit.warnings) console.warn(`[Audit WARN] ${w}`);
        if (!res.audit.ok) {
          for (const e of res.audit.errors) console.error(`[Audit FAIL] ${e}`);
        } else {
          console.log('[Audit OK] All 4 governance, static & runtime quality gates passed.');
        }
      }
    }
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'run',
      outcome: res.exitCode === 64 ? 'usage' : res.exitCode === 2 ? 'blocked' : res.ok ? 'pass' : 'fail',
      ok: Boolean(res.ok),
      exitCode: res.exitCode,
      blockerKind: res.exitCode === 64 ? 'USAGE_ERROR' : res.exitCode === 2 ? 'RUN_BLOCKED' : null,
      summary: res.error
        ? res.error
        : `Suite "${res.suite}" ${res.ok ? 'passed' : 'failed'} (runId=${res.runId || 'none'}, passed=${res.counts?.passed ?? 0}, failed=${res.counts?.failed ?? 0})`,
      data: res,
    }),
    { asJson: Boolean(options.json) }
  );
}
