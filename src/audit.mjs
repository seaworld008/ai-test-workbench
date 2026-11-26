// @ts-check
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import {
  GATE_KERNEL_VERSION,
  analyzeHealerDiffText,
  analyzeSourceAst,
  auditResultsJson,
  classifyAssertionStatement,
  compareSpecSourcesAst,
  computeProtectedFileHashes,
  computeWorkspaceInputHash,
  evaluateLockstepRules,
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  loadAndValidateWaivers,
  loadVerifiedProjectGateRules,
  openTrustContext,
  resolveDefaultDiffBase,
  resolveGitRoot,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
  verifyLedgerBindingInQaDir,
} from './kernel/gate-kernel.mjs';

export {
  GATE_KERNEL_VERSION,
  analyzeHealerDiffText,
  analyzeSourceAst,
  auditResultsJson,
  classifyAssertionStatement,
  compareSpecSourcesAst,
  computeProtectedFileHashes,
  computeWorkspaceInputHash,
  evaluateLockstepRules,
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  loadAndValidateWaivers,
  loadVerifiedProjectGateRules,
  openTrustContext,
  resolveDefaultDiffBase,
  resolveGitRoot,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
  verifyLedgerBindingInQaDir,
};

/**
 * @param {{
 *   lang?: 'zh' | 'en' | string,
 *   target?: string,
 *   qaDir?: string,
 *   results?: string,
 *   waivers?: string,
 *   expectedRunId?: string,
 *   checkSpecs?: boolean,
 *   requireE2e?: boolean,
 *   staticOnly?: boolean,
 *   allowUnboundResults?: boolean,
 *   requireCompilers?: boolean,
 *   maxFlaky?: number,
 *   maxSkipped?: number,
 *   diffBase?: string,
 *   json?: boolean,
 *   dryRun?: boolean,
 *   force?: boolean,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runAuditCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {number} exitCode @param {string} msg */
  const failAudit = (exitCode, msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'audit',
        outcome: exitCode === 2 ? 'blocked' : 'fail',
        ok: false,
        exitCode,
        summary: msg,
        blockerKind: exitCode === 2 ? 'CONFIG_BLOCKED' : null,
        data: { error: msg },
      }),
      { asJson, compatSpreadData: false }
    );
  };
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    return failAudit(1, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    return failAudit(1, lang === 'zh' ? `未在 ${target} 找到 QA 目录` : `QA directory not found at ${target}`);
  }

  const cfg = loadWorkbenchConfig({ qaDir });
  if (!cfg.ok) {
    return failAudit(2, `[Config Blocked] ${cfg.errors.join('; ') || 'Invalid workbench config.'}`);
  }
  const mergedEnv = loadMergedQaEnv(qaDir);
  const safety = evaluateTargetSafety(mergedEnv);
  const allowMutation =
    mergedEnv.TEST_ALLOW_MUTATION === '1' ||
    mergedEnv.TEST_ALLOW_MUTATION === 'true' ||
    Boolean(safety.allowMutation);

  // Fail-closed: never allow MCP child processes to bypass Run Ledger binding (`T-03`)
  const allowUnbound =
    process.env.AITEST_MCP_CHILD === '1' ? false : Boolean(options.allowUnboundResults);

  const staticOnly = Boolean(options.staticOnly);
  const effectiveCheckSpecs = options.checkSpecs !== undefined ? Boolean(options.checkSpecs) : !staticOnly;
  const repoDir = path.dirname(qaDir);
  const autoDiffBase =
    options.diffBase !== undefined
      ? options.diffBase
      : staticOnly
        ? null
        : resolveDefaultDiffBase(repoDir).resolved;

  const trustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
  const res = runAuditForQaDir(qaDir, {
    resultsPath: options.results,
    waiversPath: options.waivers,
    expectedRunId: options.expectedRunId,
    checkSpecs: effectiveCheckSpecs,
    requireE2e: Boolean(options.requireE2e),
    staticOnly,
    allowUnboundResults: allowUnbound,
    ...(options.requireCompilers !== undefined ? { requireCompilers: Boolean(options.requireCompilers) } : {}),
    maxFlaky: options.maxFlaky,
    maxSkipped: options.maxSkipped,
    diffBase: autoDiffBase,
    allowMutation,
    trustContext,
  });

  const activeLayers = Object.entries(res.gates || {})
    .filter(([, st]) => st !== 'skipped')
    .map(([k]) => k);
  const skippedLayers = Object.entries(res.gates || {})
    .filter(([, st]) => st === 'skipped')
    .map(([k]) => k);

  const exitCode = res.outcome === 'blocked' ? 2 : res.ok ? 0 : 1;
  if (!options.json) {
    console.log(
      `\n=== ${lang === 'zh' ? '四层防假绿质量门禁审计 (audit)' : '4-Layer Anti-Fake-Green Quality Gate (audit)'} ===`
    );
    console.log(
      `Outcome: ${String(res.outcome || (res.ok ? 'pass' : 'fail')).toUpperCase()} · TrustTier: ${res.trustTier || 'T0'} · ActiveLayers: ${activeLayers.join(',') || 'none'}${skippedLayers.length > 0 ? ` (skipped: ${skippedLayers.join(',')})` : ''} · caller=${cfg.caller}`
    );
    if (res.runId) {
      console.log(`Bound Run ID: ${res.runId}`);
    }
    if (res.stats) {
      console.log(
        `Stats: passed=${res.stats.passed}, failed=${res.stats.failed}, flaky=${res.stats.flaky}, quarantined=${res.stats.quarantined || 0}, skipped=${res.stats.skipped}, policyExcluded(@mutation)=${res.stats.policyExcludedMutations}`
      );
    }
    for (const item of res.policyExcludedTitles) {
      console.log(`  [POLICY-EXCLUDED @mutation] ${item}`);
    }
    for (const w of res.warnings) {
      console.warn(`[WARN] ${w}`);
    }
    if (!res.ok) {
      for (const e of res.errors) {
        console.error(`[FAIL] ${e}`);
      }
    } else if (skippedLayers.length > 0) {
      console.log(
        `[OK] ${lang === 'zh' ? `已激活门禁层通过 (${activeLayers.join(', ')})；跳过层: ${skippedLayers.join(', ')}` : `Active gate layers passed (${activeLayers.join(', ')}); skipped: ${skippedLayers.join(', ')}`}.\n`
      );
    } else {
      console.log(`[OK] ${lang === 'zh' ? '四层防假绿质量门禁全部通过' : 'All 4 quality gate layers passed'}.\n`);
    }
  }

  return emitCommandResult(
    buildCommandResult({
      tool: 'audit',
      outcome: res.outcome === 'blocked' ? 'blocked' : res.ok ? 'pass' : 'fail',
      ok: res.ok,
      exitCode,
      summary: res.ok
        ? `Audit passed (${res.trustTier || 'T0'}, activeLayers=${activeLayers.join('+')}, skipped=${skippedLayers.length}, runId=${res.runId || 'none'})`
        : res.errors[0] || `Audit ${res.outcome} (${res.errors.length} error(s))`,
      blockerKind: res.outcome === 'blocked' ? 'AUDIT_GATE_BLOCKED' : null,
      recoverySteps: res.ok ? [] : res.errors.slice(0, 3),
      data: { ...res, activeLayers, skippedLayers },
    }),
    { asJson: Boolean(options.json) }
  );
}
