#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GATE_KERNEL_VERSION,
  PROTECTED_GOVERNANCE_REL_FILES,
  analyzeHealerDiffText,
  analyzeSourceAst,
  auditResultsJson,
  classifyAssertionStatement,
  compareSpecSourcesAst,
  computeProtectedFileHashes,
  computeWorkspaceInputHash,
  countMutationSpecsInFiles,
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  loadAndValidateWaivers,
  resolveDefaultDiffBase,
  resolveGitRoot,
  resolveTypeScriptCompiler,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
  verifyLedgerBindingInQaDir,
} from '../support/gate-kernel.mjs';

export {
  GATE_KERNEL_VERSION,
  PROTECTED_GOVERNANCE_REL_FILES,
  analyzeHealerDiffText,
  analyzeSourceAst,
  auditResultsJson,
  classifyAssertionStatement,
  compareSpecSourcesAst,
  computeProtectedFileHashes,
  computeWorkspaceInputHash,
  countMutationSpecsInFiles,
  isCoveredByWaiver,
  isProtectedDiffPath,
  loadAitestConfig,
  loadAndValidateWaivers,
  resolveDefaultDiffBase,
  resolveGitRoot,
  resolveTypeScriptCompiler,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
  verifyGovernanceLockInQaDir,
  verifyLedgerBindingInQaDir,
};

const isDirectMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  const qaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  let resultsArg = 'reports/results.json';
  let checkSpecs = false;
  let requireE2e = false;
  let staticOnly = false;
  let allowUnboundResults = false;
  let maxFlaky;
  let maxSkipped;
  let diffBase = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check-specs') checkSpecs = true;
    else if (a === '--require-e2e') requireE2e = true;
    else if (a === '--static-only') staticOnly = true;
    else if (a === '--allow-unbound-results') allowUnboundResults = true;
    else if (a === '--max-flaky') maxFlaky = Number(argv[++i]);
    else if (a === '--max-skipped') maxSkipped = Number(argv[++i]);
    else if (a === '--diff-base') diffBase = argv[++i];
    else if (!a.startsWith('-')) resultsArg = a;
  }

  const out = runAuditForQaDir(qaRoot, {
    resultsPath: resultsArg,
    checkSpecs,
    requireE2e,
    staticOnly,
    allowUnboundResults,
    maxFlaky,
    maxSkipped,
    diffBase,
  });

  if (out.stats) {
    console.log(
      `[Audit Stats] outcome=${out.outcome} trustTier=${out.trustTier} runId=${out.runId || 'unbound'} passed=${out.stats.passed} failed=${out.stats.failed} flaky=${out.stats.flaky} skipped=${out.stats.skipped} policyExcludedMutation=${out.stats.policyExcludedMutations}`
    );
  }
  for (const p of out.policyExcludedTitles) {
    console.log(`  [Policy Excluded @mutation] ${p}`);
  }
  for (const w of out.warnings) {
    console.warn(`[WARN] ${w}`);
  }
  if (!out.ok) {
    for (const e of out.errors) {
      console.error(`[FAIL] ${e}`);
    }
    process.exit(out.outcome === 'blocked' ? 2 : 1);
  }
  console.log('[OK] 4-layer anti-fake-green quality gate passed.');
}
