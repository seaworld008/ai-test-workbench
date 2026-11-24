import fs from 'node:fs';
import path from 'node:path';
import { runGitDiffGuard, runStaticSpecChecks } from './ast-analyzer.mjs';
import { computeWorkspaceInputHash } from './git-utils.mjs';
import {
  auditResultsJson,
  countMutationSpecsInFiles,
  verifyLedgerBindingInQaDir,
} from './ledger-verify.mjs';
import {
  loadActiveQuarantine,
  loadAitestConfig,
  loadAndValidateWaivers,
  verifyGovernanceLockInQaDir,
} from './policy.mjs';

export const GATE_KERNEL_VERSION = '5.1.0';

/**
 * Unified 3-State Quality Gate Engine (`pass | fail | blocked`, `X-5` / `A-1`).
 *
 * Invariant:
 * - Any required gate that cannot execute (missing lock, missing ledger, missing results,
 *   broken git base) returns `'blocked'` and NEVER silently passes.
 * - `outcome` is `'blocked'` if any gate is `'blocked'`, `'fail'` if any gate is `'fail'`
 *   or errors exist, and `'pass'` only when zero errors and zero blocked gates exist.
 */
export function runAuditForQaDir(qaDir, options = {}) {
  const resultsPath = options.resultsPath
    ? path.resolve(qaDir, options.resultsPath)
    : path.join(qaDir, 'reports', 'results.json');
  const waiversPath = options.waiversPath
    ? path.resolve(qaDir, options.waiversPath)
    : path.join(qaDir, 'waivers.json');

  const cfg = loadAitestConfig(qaDir);
  const maxFlaky = options.maxFlaky !== undefined ? Number(options.maxFlaky) : cfg.maxFlaky;
  const maxSkipped =
    options.maxSkipped !== undefined ? Number(options.maxSkipped) : cfg.maxSkipped ?? 0;
  const checkSpecs = Boolean(options.checkSpecs);
  const requireE2e = Boolean(options.requireE2e);
  const staticOnly = Boolean(options.staticOnly);
  const diffBase = options.diffBase || null;
  const requireDiff = Boolean(options.requireDiff);
  const allowMutation =
    options.allowMutation !== undefined
      ? Boolean(options.allowMutation)
      : process.env.TEST_ALLOW_MUTATION === '1' || process.env.TEST_ALLOW_MUTATION === 'true';

  const allErrors = [];
  const allWarnings = [];
  let stats = null;
  let policyExcludedTitles = [];
  let boundRunId = null;
  let resultsDigest = null;
  let ledgerMac = null;
  let lockDigest = null;
  let govTrustTier = 'T0';
  let ledgerTrustTier = 'T0';

  // Layer 0: Governance Integrity (Fail-Closed on missing lock!)
  /** @type {'pass' | 'fail' | 'blocked' | 'skipped'} */
  let governanceStatus = 'skipped';
  if (options.skipGovernanceCheck !== true) {
    const govRes = verifyGovernanceLockInQaDir(qaDir, { requireT1Mac: Boolean(options.requireT1Mac) });
    lockDigest = govRes.lockDigest || null;
    govTrustTier = govRes.trustTier || 'T0';
    if (govRes.enforced) {
      governanceStatus = /** @type {any} */ (govRes.status || (govRes.ok ? 'pass' : 'fail'));
      allErrors.push(...govRes.errors);
      allWarnings.push(...govRes.warnings);
    } else {
      governanceStatus = 'pass';
    }
  }

  const waiverCheck = loadAndValidateWaivers(waiversPath, Date.now(), {
    maxWaiverDays: cfg.maxWaiverDays,
    maxWaivers: cfg.maxWaivers,
    legacyCompat: Boolean(options.legacyWaiverCompat),
  });
  if (!waiverCheck.ok) {
    allErrors.push(...waiverCheck.errors);
    if (governanceStatus === 'pass' || governanceStatus === 'skipped') governanceStatus = 'fail';
  }

  const quarantineCheck = loadActiveQuarantine(qaDir);
  if (!quarantineCheck.ok) {
    allErrors.push(...quarantineCheck.errors);
    if (governanceStatus === 'pass' || governanceStatus === 'skipped') governanceStatus = 'fail';
  }

  // Layer 1: Runtime Results + Fail-Closed Run Ledger Binding
  /** @type {'pass' | 'fail' | 'blocked' | 'skipped'} */
  let runtimeStatus = staticOnly ? 'skipped' : 'pass';
  if (!staticOnly) {
    if (!fs.existsSync(resultsPath)) {
      allErrors.push(`Missing test results JSON: ${resultsPath}`);
      runtimeStatus = 'blocked';
    } else {
      try {
        const rawResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        const currentWorktreeHash = computeWorkspaceInputHash(qaDir);
        const binding = verifyLedgerBindingInQaDir(qaDir, resultsPath, rawResults, {
          allowUnboundResults: Boolean(options.allowUnboundResults),
          expectedRunId: options.expectedRunId,
          currentWorktreeHash,
          requireT1Mac: Boolean(options.requireT1Mac),
        });
        boundRunId = binding.runId;
        resultsDigest = binding.resultsDigest || null;
        ledgerMac = binding.ledgerMac || null;
        ledgerTrustTier = binding.trustTier || 'T0';

        if (!binding.ok) {
          allErrors.push(...binding.errors);
          runtimeStatus = binding.status === 'blocked' ? 'blocked' : 'fail';
        }
        allWarnings.push(...binding.warnings);

        const mutationFileHints = !allowMutation ? countMutationSpecsInFiles(path.join(qaDir, 'tests')) : [];
        const resAudit = auditResultsJson(rawResults, {
          activeWaivers: waiverCheck.activeWaivers,
          requireE2e,
          maxFlaky,
          maxSkipped,
          allowMutation,
          excludedMutationHints: mutationFileHints,
          quarantinedTests: quarantineCheck.entries,
        });
        stats = resAudit.stats;
        policyExcludedTitles = resAudit.policyExcludedTitles;
        if (!resAudit.ok && runtimeStatus !== 'blocked') runtimeStatus = 'fail';
        allErrors.push(...resAudit.errors);
        allWarnings.push(...resAudit.warnings);
      } catch (err) {
        allErrors.push(`Failed to parse ${resultsPath}: ${err.message}`);
        runtimeStatus = 'fail';
      }
    }
  }

  // Layer 2: Static Spec Checks (tsc + eslint + TS AST semantic scanner)
  /** @type {'pass' | 'fail' | 'blocked' | 'skipped'} */
  let staticStatus = checkSpecs ? 'pass' : 'skipped';
  if (checkSpecs) {
    const staticRes = runStaticSpecChecks(qaDir, {
      activeWaivers: waiverCheck.activeWaivers,
      requireCompilers: Boolean(options.requireCompilers),
    });
    staticStatus = /** @type {any} */ (staticRes.status);
    allErrors.push(...staticRes.errors);
    allWarnings.push(...staticRes.warnings);
  }

  // Layer 3: Full-File AST Semantic Diff Guard
  /** @type {'pass' | 'fail' | 'blocked' | 'skipped'} */
  let diffStatus = diffBase ? 'pass' : requireDiff ? 'blocked' : 'skipped';
  if (diffBase) {
    const diffRes = runGitDiffGuard(qaDir, diffBase, { activeWaivers: waiverCheck.activeWaivers });
    diffStatus = /** @type {any} */ (diffRes.status || (diffRes.ok ? 'pass' : 'fail'));
    allErrors.push(...diffRes.violations);
  } else if (requireDiff) {
    allErrors.push('[Healer Diff Guard Blocked] Layer 3 Semantic Diff Guard requires a valid Git diffBase; fail-closed.');
  }

  const gateStatuses = [governanceStatus, runtimeStatus, staticStatus, diffStatus];
  const anyBlocked = gateStatuses.includes('blocked');
  const anyFailed = gateStatuses.includes('fail') || allErrors.length > 0;
  /** @type {'pass' | 'fail' | 'blocked'} */
  const outcome = anyBlocked ? 'blocked' : anyFailed ? 'fail' : 'pass';

  const trustTier =
    outcome === 'pass' && govTrustTier === 'T1' && (staticOnly || ledgerTrustTier === 'T1')
      ? 'T1'
      : 'T0';

  return {
    ok: outcome === 'pass',
    outcome,
    trustTier,
    gateKernelVersion: GATE_KERNEL_VERSION,
    runId: boundRunId,
    evidence: {
      lockDigest,
      resultsDigest,
      ledgerMac,
    },
    gates: {
      governance: governanceStatus,
      runtime: runtimeStatus,
      static: staticStatus,
      semanticDiff: diffStatus,
    },
    errors: allErrors,
    warnings: allWarnings,
    stats,
    policyExcludedTitles,
  };
}
