// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { runAuditForQaDir } from './audit.mjs';
import { syncLivingCodeMap } from './codemap.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult, outcomeToExitCode } from './core/outcome.mjs';
import { resolvePlaywrightCli } from './core/playwright-resolve.mjs';
import { runPlaywright } from './core/proc.mjs';
import { redactSecrets } from './core/redact.mjs';
import { loadRuntimeConfig } from './core/runtime-config.mjs';
import { syncQuarantineFromLedger } from './flaky.mjs';
import { computeImpact } from './impact.mjs';
import { beginRunLedger, finalizeRunLedger } from './ledger.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';

const PLAYWRIGHT_ENV_ALLOWLIST_EXACT = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'SystemDrive',
  'WINDIR',
  'windir',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_MESSAGES',
  'TZ',
  'NODE_ENV',
  'NODE_OPTIONS',
  'CI',
  'GITHUB_ACTIONS',
  'GITLAB_CI',
  'BUILDKITE',
  'REQUIRE_TEST_TARGET',
  'DEBUG',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
]);

const PLAYWRIGHT_ENV_ALLOWLIST_PREFIXES = ['PLAYWRIGHT_', 'PW_', 'TEST_', 'E2E_', 'FAIL_ON_'];
const PLAYWRIGHT_ENV_ALLOWLIST_AITEST = new Set(['AITEST_ACTIVE_SUITE', 'AITEST_RUN_ID', 'AITEST_LANG', 'AITEST_DISABLE_WEBSERVER']);

/**
 * Builds a strict allowlisted environment for Playwright & target app processes,
 * stripping `AITEST_HMAC_KEY*`, MCP tokens, cloud credentials, and CI OIDC tokens (`WU-01`).
 * @param {Record<string, string | undefined>} baseEnv
 * @param {Record<string, string | undefined>} [extraEnv]
 * @returns {Record<string, string>}
 */
export function buildPlaywrightChildEnv(baseEnv = process.env, extraEnv = {}) {
  /** @type {Record<string, string>} */
  const clean = {};
  const combined = { ...baseEnv, ...extraEnv };
  for (const [k, v] of Object.entries(combined)) {
    if (v === undefined) continue;
    if (k.startsWith('AITEST_HMAC_KEY') || k.startsWith('AITEST_MCP_') || k.startsWith('ACTIONS_ID_TOKEN_REQUEST_')) {
      continue;
    }
    const allowed =
      PLAYWRIGHT_ENV_ALLOWLIST_EXACT.has(k) ||
      PLAYWRIGHT_ENV_ALLOWLIST_AITEST.has(k) ||
      PLAYWRIGHT_ENV_ALLOWLIST_PREFIXES.some((p) => k.startsWith(p));
    if (allowed) {
      clean[k] = String(v);
    }
  }
  return clean;
}

/**
 * @param {string} suite
 * @param {{ hasBaseUrl?: boolean }} [options]
 * @returns {string[]}
 */
export function buildSuitePlaywrightArgs(suite, options = {}) {
  const s = (suite || 'smoke').toLowerCase();
  const args = [];

  switch (s) {
    case 'smoke':
      args.push('--project=smoke');
      break;
    case 'e2e':
      args.push('--project=e2e');
      break;
    case 'api':
      args.push('--project=api');
      break;
    case 'seed':
      args.push('--project=seed');
      break;
    case 'a11y':
      args.push('--project=smoke');
      if (options.hasBaseUrl) args.push('--project=e2e');
      args.push('--grep=@a11y');
      break;
    case 'critical':
      args.push('--project=smoke');
      if (options.hasBaseUrl) {
        args.push('--project=e2e', '--project=api');
      }
      args.push('--grep=@critical|@smoke');
      break;
    case 'all':
      args.push('--project=smoke', '--project=e2e', '--project=api');
      break;
    default:
      throw new Error(`Unknown suite "${suite}". Valid suites: smoke, e2e, api, a11y, critical, seed, impact, all.`);
  }

  return args;
}

/**
 * Resolves explicit `--files` / `--line` CLI targets for rapid single-file inner loop (`WU-04`).
 * @param {string | string[] | undefined} files
 * @param {number | string | undefined} line
 * @returns {string[]}
 */
export function resolveExplicitFileTargets(files, line) {
  const explicitFiles = Array.isArray(files)
    ? files.map((s) => String(s).trim()).filter(Boolean)
    : typeof files === 'string' && files.trim()
      ? files.split(',').map((s) => s.trim()).filter(Boolean)
      : [];
  const lineNum = Number.isInteger(Number(line)) && Number(line) > 0 ? Number(line) : null;
  if (explicitFiles.length === 0) return [];
  return lineNum && explicitFiles.length === 1 ? [`${explicitFiles[0]}:${lineNum}`] : explicitFiles;
}

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

  loadWorkbenchConfig({ qaDir });
  const suite = (options.suite || 'smoke').toLowerCase();
  const runtimeCfgRes = loadRuntimeConfig(qaDir);
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
  const ledgerBegin = beginRunLedger(qaDir, {
    suite,
    command: `playwright ${pwArgs.join(' ')}`,
    env: mergedEnv,
    repoDir,
  });

  const runEnv = buildPlaywrightChildEnv(process.env, {
    ...overrides,
    ...(safety.allowMutation ? { TEST_ALLOW_MUTATION: '1' } : {}),
    ...(mergedEnv.TEST_STRICT_READONLY === undefined ? { TEST_STRICT_READONLY: safety.strictReadonly ? '1' : '0' } : {}),
    AITEST_ACTIVE_SUITE: suite,
    AITEST_RUN_ID: ledgerBegin.runId,
  });

  if (typeof options.onProgress === 'function') {
    options.onProgress({ progress: 10, total: 100, message: `Starting suite "${suite}" (runId=${ledgerBegin.runId})` });
  }

  const inheritStdio = Boolean(options.inheritStdio) && !options.json;
  const timeoutMs = options.timeoutMs !== undefined ? Number(options.timeoutMs) : 45 * 60_000;
  const pwRes = await runPlaywright(qaDir, pwArgs, {
    env: runEnv,
    inheritStdio,
    capture: !inheritStdio,
    timeoutMs,
    signal: options.signal,
  });

  const ledgerFinal = finalizeRunLedger(qaDir, ledgerBegin.runId, {
    exitCode: pwRes.code,
  });

  try {
    syncQuarantineFromLedger(qaDir);
  } catch {
    // non-fatal quarantine telemetry update
  }

  let codeMapSummary = null;
  if (fs.existsSync(path.join(qaDir, 'knowledge', 'code-map.json'))) {
    try {
      codeMapSummary = syncLivingCodeMap(qaDir, { lang, syncImpact: false, skipWriteIfUnchanged: true });
    } catch {
      // non-fatal knowledge sync warning
    }
  }

  if (typeof options.onProgress === 'function') {
    options.onProgress({ progress: 80, total: 100, message: `Playwright finished (code=${pwRes.code})` });
  }

  let auditOut = null;
  if (options.audit) {
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
  const failedSpecs = (ledgerFinal?.tests || [])
    .filter((t) => t.status === 'unexpected' || t.status === 'flaky')
    .slice(0, 15)
    .map((t) => {
      let errorContextAria = null;
      const ariaAtt = (t.attachments || []).find(
        (/** @type {any} */ a) =>
          (a?.name === 'error-context' || String(a?.path || '').endsWith('.md')) && a?.path && fs.existsSync(a.path)
      );
      if (ariaAtt?.path) {
        try {
          errorContextAria = redactSecrets(fs.readFileSync(ariaAtt.path, 'utf8')).slice(0, 1800);
        } catch {
          errorContextAria = null;
        }
      }
      const errMsg = t.errorSnippet ? redactSecrets(t.errorSnippet) : null;
      const locatorSuggestions = [];
      if (errMsg && /locator|strict mode|getBy/i.test(errMsg)) {
        locatorSuggestions.push('Inspect errorContextAria and bind a unique semantic locator (getByRole / getByLabel / getByTestId).');
      }
      return {
        testId: t.testId,
        file: t.file,
        line: t.line,
        title: redactSecrets(t.title),
        status: t.status,
        error: errMsg,
        ...(errorContextAria ? { errorContextAria } : {}),
        ...(locatorSuggestions.length > 0 ? { locatorSuggestions } : {}),
      };
    });

  return {
    ok: finalCode === 0,
    exitCode: finalCode,
    outcome,
    runId: ledgerBegin.runId,
    qaDir,
    suite,
    acceptanceScope: safety.baseURL && ['e2e', 'api', 'all'].includes(suite) ? 'business-e2e' : 'local-workbench',
    impact: impactResult,
    counts: ledgerFinal?.manifest?.counts || auditOut?.stats || null,
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
      outcome: res.exitCode === 2 ? 'blocked' : res.ok ? 'pass' : 'fail',
      ok: Boolean(res.ok),
      exitCode: res.exitCode,
      summary: res.error
        ? res.error
        : `Suite "${res.suite}" ${res.ok ? 'passed' : 'failed'} (runId=${res.runId || 'none'}, passed=${res.counts?.passed ?? 0}, failed=${res.counts?.failed ?? 0})`,
      data: res,
    }),
    { asJson: Boolean(options.json) }
  );
}
