// @ts-check
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { loadMergedQaEnv } from './origin-guard.mjs';
import {
  GATE_KERNEL_VERSION,
  analyzeHealerDiffText,
  analyzeSourceAst,
  auditResultsJson,
  classifyAssertionStatement,
  compareSpecSourcesAst,
  computeProtectedFileHashes,
  computeWorkspaceInputHash,
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  loadAndValidateWaivers,
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
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  loadAndValidateWaivers,
  resolveDefaultDiffBase,
  resolveGitRoot,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
  verifyLedgerBindingInQaDir,
};

export async function runAuditCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未在 ${target} 找到 QA 目录` : `QA directory not found at ${target}`);
    return 1;
  }

  const mergedEnv = loadMergedQaEnv(qaDir);
  const allowMutation = mergedEnv.TEST_ALLOW_MUTATION === '1' || mergedEnv.TEST_ALLOW_MUTATION === 'true';

  // Fail-closed: never allow MCP child processes to bypass Run Ledger binding (`T-03`)
  const allowUnbound =
    process.env.AITEST_MCP_CHILD === '1' ? false : Boolean(options.allowUnboundResults);

  const res = runAuditForQaDir(qaDir, {
    resultsPath: options.results,
    waiversPath: options.waivers,
    expectedRunId: options.expectedRunId,
    checkSpecs: Boolean(options.checkSpecs),
    requireE2e: Boolean(options.requireE2e),
    staticOnly: Boolean(options.staticOnly),
    allowUnboundResults: allowUnbound,
    ...(options.requireCompilers !== undefined ? { requireCompilers: Boolean(options.requireCompilers) } : {}),
    maxFlaky: options.maxFlaky,
    maxSkipped: options.maxSkipped,
    diffBase: options.diffBase,
    allowMutation,
  });

  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.outcome === 'blocked' ? 2 : res.ok ? 0 : 1;
  }

  console.log(
    `\n=== ${lang === 'zh' ? '四层防假绿质量门禁审计 (audit v5.1)' : '4-Layer Anti-Fake-Green Quality Gate (audit v5.1)'} ===`
  );
  console.log(`Outcome: ${String(res.outcome || (res.ok ? 'pass' : 'fail')).toUpperCase()} · TrustTier: ${res.trustTier || 'T0'}`);
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
    return res.outcome === 'blocked' ? 2 : 1;
  }
  console.log(`[OK] ${lang === 'zh' ? '四层防假绿质量门禁全部通过' : 'All 4 quality gate layers passed'}.\n`);
  return 0;
}
