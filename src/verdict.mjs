// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import {
  GATE_KERNEL_VERSION,
  resolveDefaultDiffBase,
  runAuditForQaDir,
  verifyGovernanceLockInQaDir,
} from './audit.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { loadRuntimeConfig } from './core/runtime-config.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from './core/version.mjs';
import { generateDiagnosticsMarkdown } from './diagnose.mjs';
import { computeImpact } from './impact.mjs';
import { openTrustContext, resolveGitHeadAndTreeSha } from './kernel/gate-kernel.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import { resolvePlaywrightCli } from './proc.mjs';
import { executeSuiteCore } from './runner.mjs';
import { buildRequirementTraceMatrix } from './traceability.mjs';
import {
  TRUST_LEVEL_DEFINITIONS,
  resolveVerdictTrustTier,
} from './trust.mjs';
import { buildBlockedVerdict } from './verdict/blocked.mjs';
import { runVerdictParityHook } from './verdict/parity-hook.mjs';
import {
  buildPrVerdictMarkdown,
  buildSarifReport,
  checkHealSessionConflicts,
  writeVerdictArtifacts,
} from './verdict/reports.mjs';

export { buildPrVerdictMarkdown, buildSarifReport, checkHealSessionConflicts };

/**
 * One-Call Agent Change Verification Orchestrator (`T-04`, `T-05`, `T-07`, `I-09`).
 * Runs: Layer 0 Governance -> Git merge-base resolution -> Impact v2 (single pass) ->
 * Ledger-bound Suite Run -> 4-Layer Fail-Closed AST Audit -> Heal Conflict Check ->
 * Diagnostics v2 -> in-toto Statement v1 Attestation + SARIF + PR Summary.
 *
 * @param {Record<string, any>} [options]
 */
export async function verifyChangeCore(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    return { ok: false, exitCode: 1, verdict: 'blocked', trustTier: 'T0', error: 'Missing --target option' };
  }

  const target = path.resolve(options.target);
  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    return { ok: false, exitCode: 1, verdict: 'blocked', trustTier: 'T0', error: `QA directory not found under ${target}` };
  }

  const repoDir = target === qaDir ? path.dirname(qaDir) : target;
  const rawMode = String(options.mode || options.suite || 'impact').toLowerCase();
  const requestedMode = ['full', 'all', 'smoke', 'impact', 'e2e', 'api', 'a11y', 'critical', 'parity'].includes(rawMode)
    ? rawMode === 'all' ? 'full' : rawMode
    : 'impact';

  const workbenchConfig = loadWorkbenchConfig({ qaDir, repoDir });

  // Step 0: Resolve real Git root (monorepo/worktree aware) & safe diff base (`T-05`)
  const baseResolution = resolveDefaultDiffBase(repoDir, options.base || null);
  /** @type {{ headSha: string, treeSha: string | null } | null} */
  let cachedGitInfo = null;
  const getGitInfo = () => (cachedGitInfo ??= resolveGitHeadAndTreeSha(repoDir));

  if (!workbenchConfig.ok) {
    return buildBlockedVerdict({
      reasonCode: 'invalid-workbench-config',
      gitSha: getGitInfo().headSha,
      base: baseResolution,
      requestedMode,
      gates: { governance: 'blocked', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: workbenchConfig.errors.map((e) => `[Config Blocked] ${e}`),
    });
  }

  // Step 1: Pre-flight Layer 0 Governance Lock Integrity (Fail-Closed!)
  const preTrustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
  const govPre = verifyGovernanceLockInQaDir(qaDir, { trustContext: preTrustContext });
  if (!govPre.ok) {
    return buildBlockedVerdict({
      reasonCode: 'governance-tamper-detected',
      gitSha: getGitInfo().headSha,
      base: baseResolution,
      requestedMode,
      gates: { governance: govPre.status || 'blocked', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: govPre.errors,
      nextActions: [{ action: 'human-cli', command: `npx ai-test-workbench@${WORKBENCH_VERSION} governance approve --target <repo> --by <human> --reason <why>` }],
    });
  }

  // Step 1b: Fail-closed if Git diff base cannot be resolved (unless explicit CLI-only allowNonGit for T0 advisory)
  const allowNonGit = workbenchConfig.caller !== 'mcp-child' && Boolean(options.allowNonGit);
  if ((!baseResolution.isGitRepo || !baseResolution.resolved) && !allowNonGit) {
    return buildBlockedVerdict({
      reasonCode: 'semantic-diff-base-unresolved',
      gitSha: getGitInfo().headSha,
      base: baseResolution,
      requestedMode,
      gates: { governance: govPre.status || 'pass', static: 'skipped', runtime: 'skipped', semanticDiff: 'blocked' },
      gateErrors: [
        `[Verify Change Blocked] ${baseResolution.error || 'Unable to resolve Git diff base for Layer 3 Semantic AST Guard.'} Initialize Git or specify a valid --base commit.`,
      ],
      nextActions: [{ action: 'git-check', command: 'git status && git rev-parse --show-toplevel' }],
    });
  }

  // Step 2: Target Safety & Scope Resolution (`WU-04`: honor aitest.runtime.json & forbid silent offline downgrade)
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
    return buildBlockedVerdict({
      reasonCode: 'target-guard-blocked',
      gitSha: getGitInfo().headSha,
      base: baseResolution,
      requestedMode,
      gates: { governance: govPre.status || 'pass', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: safety.errors,
    });
  }

  const effectiveBaseUrl = safety.baseURL || null;
  const allowOfflineSmoke = Boolean(options.allowOfflineSmoke);
  if (requestedMode !== 'smoke' && !effectiveBaseUrl && !allowOfflineSmoke) {
    return buildBlockedVerdict({
      reasonCode: 'server-unreachable',
      blockerKind: 'server-unreachable',
      recoverable: true,
      recoverySteps: [
        'Run aitest bootstrap --target <repo> (or configure loopback baseURL/webServer in qa/aitest.runtime.json).',
        'Or pass --base-url http://127.0.0.1:<port>, or pass --allow-offline-smoke for offline smoke only.',
      ],
      gitSha: getGitInfo().headSha,
      base: baseResolution,
      requestedMode,
      gates: { governance: govPre.status || 'pass', static: 'skipped', runtime: 'blocked', semanticDiff: 'skipped' },
      gateErrors: [
        `[Verify Change Blocked] Mode "${requestedMode}" requires a live or auto-bootable target server (TEST_BASE_URL or qa/aitest.runtime.json). Refusing to silently downgrade to offline smoke.`,
      ],
      nextActions: [{ tool: 'aitest_bootstrap', args: { target } }],
    });
  }

  const effectiveBaseRef = baseResolution.resolved || 'HEAD~1';
  const impact = await computeImpact(repoDir, { qaDir: options.qaDir, base: effectiveBaseRef });
  const hasPlaywright = Boolean(resolvePlaywrightCli(qaDir));
  if (!hasPlaywright) {
    return buildBlockedVerdict({
      reasonCode: 'playwright-missing',
      blockerKind: 'playwright-missing',
      recoverable: true,
      recoverySteps: ['Run aitest bootstrap --target <repo> or "npm --prefix qa ci" to install Playwright.'],
      gitSha: getGitInfo().headSha,
      base: baseResolution,
      requestedMode,
      gates: { governance: govPre.status || 'pass', static: 'skipped', runtime: 'blocked', semanticDiff: 'skipped' },
      gateErrors: [`Playwright dependencies not installed in ${qaDir}. Run init first.`],
      error: `Playwright dependencies not installed in ${qaDir}. Run init first.`,
    });
  }

  const effectiveSuite =
    requestedMode === 'smoke'
      ? 'smoke'
      : requestedMode === 'full'
        ? effectiveBaseUrl
          ? 'all'
          : 'smoke'
        : ['e2e', 'api', 'a11y', 'critical'].includes(requestedMode)
          ? effectiveBaseUrl
            ? requestedMode
            : 'smoke'
          : effectiveBaseUrl
            ? 'impact'
            : 'smoke';
  const scopeDowngraded = !effectiveBaseUrl && requestedMode !== 'smoke';

  // Step 3: Execute suite bound to Run Ledger (pass precomputedImpact so computeImpact runs ONCE!)
  const runOut = await executeSuiteCore({
    target,
    qaDir: options.qaDir,
    suite: effectiveSuite,
    baseUrl: options.baseUrl || (effectiveBaseUrl ?? undefined),
    allowMutation: options.allowMutation ?? safety.allowMutation,
    base: effectiveBaseRef,
    precomputedImpact: impact,
    audit: false,
    timeoutMs: options.budgetMs || 15 * 60_000,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  // Step 4: Full 4-Layer Fail-Closed AST Audit
  // Security boundary (v6.2.1): explicit `--base` or CI strictly ignores `.aitest/baseline-ref`
  const auditTrustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
  const auditOut = runAuditForQaDir(qaDir, {
    checkSpecs: true,
    requireE2e: Boolean(effectiveBaseUrl && requestedMode === 'full'),
    allowMutation: options.allowMutation ?? safety.allowMutation,
    expectedRunId: runOut.runId,
    diffBase: baseResolution.resolved,
    explicitDiffBase: Boolean(options.base),
    requireDiff: !allowNonGit,
    trustContext: auditTrustContext,
  });

  // Step 4b: Check Heal Session Conflicts (`T-07`) & optional Differential Parity Oracle (`WU-A`)
  const healCheck = checkHealSessionConflicts(qaDir, baseResolution, auditTrustContext);
  const parityCheck = await runVerdictParityHook({
    target,
    qaDir: options.qaDir,
    lang,
    requestedMode,
    effectiveBaseUrl,
    options,
  });
  const combinedGateErrors = [...auditOut.errors, ...healCheck.errors, ...(parityCheck?.errors || [])];

  // Step 5: Structured Diagnostics on Failures
  const resultsPath = path.join(qaDir, 'reports', 'results.json');
  /** @type {Array<{ testId: string, title: string, file: string, line: number, categoryCode: string, category: string, confidence: string, candidates: string[], traceId: string | null, traceIds: string[], errorSnippet: string, evidence: string | null, linkedKnownBlockerId?: string | null, knownBlockerReason?: string | null }>} */
  let diagFailures = [];
  if (fs.existsSync(resultsPath)) {
    const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
    const evUri = runOut.runId ? `aitest://project/${encodeURIComponent(target)}/diagnostics` : null;
    diagFailures = diag.failures.map((f) => ({
      testId: f.testId, title: f.title, file: f.file, line: f.line,
      categoryCode: f.categoryCode, category: f.category, confidence: f.confidence,
      candidates: f.candidates, traceId: f.traceId, traceIds: f.traceIds,
      errorSnippet: f.errorSnippet, evidence: evUri,
      ...(f.linkedKnownBlockerId ? { linkedKnownBlockerId: f.linkedKnownBlockerId, knownBlockerReason: f.knownBlockerReason || null } : {}),
    }));
    fs.writeFileSync(path.join(qaDir, 'reports', 'ai-diagnostics.md'), diag.markdown, 'utf8');
  }

  // Step 6: Requirement Traceability Matrix
  const traceMatrix = buildRequirementTraceMatrix(qaDir);

  // Step 7: Strict 3-State Verdict (`pass | fail | blocked`) — NEVER turn `skipped`/`blocked` into `pass`!
  const effectiveGates = parityCheck ? { ...auditOut.gates, parity: parityCheck.gateStatus } : auditOut.gates;
  const gateValues = Object.values(effectiveGates || {});
  const hasBlockedGate = auditOut.outcome === 'blocked' || gateValues.includes('blocked') || !healCheck.ok || Boolean(parityCheck?.blocked);
  const hasRequiredSkippedGate = !allowNonGit && gateValues.includes('skipped');
  const allPassed =
    runOut.exitCode === 0 &&
    auditOut.ok &&
    healCheck.ok &&
    (!parityCheck || parityCheck.ok) &&
    !hasBlockedGate &&
    !hasRequiredSkippedGate;

  /** @type {'pass' | 'fail' | 'blocked'} */
  const verdictStatus = hasBlockedGate || hasRequiredSkippedGate ? 'blocked' : allPassed ? 'pass' : 'fail';
  const exitCode = verdictStatus === 'pass' ? 0 : verdictStatus === 'blocked' ? 2 : 1;

  if (hasRequiredSkippedGate) {
    combinedGateErrors.push(
      `[Verify Change Blocked] One or more required quality gates were skipped (${JSON.stringify(auditOut.gates)}).`
    );
  }

  const hasAllFourGates =
    auditOut.gates.governance === 'pass' &&
    auditOut.gates.static === 'pass' &&
    auditOut.gates.runtime === 'pass' &&
    auditOut.gates.semanticDiff === 'pass';

  const trustTier = resolveVerdictTrustTier({
    verdict: verdictStatus,
    auditTrustTier: auditOut.trustTier,
    scopeDowngraded,
    hasAllFourGates,
  });

  const confidenceReasons = [
    `trustTier=${trustTier}`,
    `selection=${requestedMode}->${effectiveSuite}${scopeDowngraded ? '(downgraded-no-baseUrl)' : ''}`,
    `base=${baseResolution.strategy}`,
    `gateKernel=${GATE_KERNEL_VERSION}`,
    `acceptanceScope=${runOut.acceptanceScope}`,
  ];

  const nextActions = [];
  if (verdictStatus !== 'pass') {
    for (const f of diagFailures.slice(0, 5)) {
      if (f.categoryCode === 'A') {
        nextActions.push({ tool: 'aitest_heal', args: { action: 'begin', target, testId: f.testId } });
      } else {
        nextActions.push({
          tool: 'aitest_heal',
          note: `Category ${f.categoryCode}: open session and conclude as defect/escalation without editing assertions`,
          args: { action: 'begin', target, testId: f.testId },
        });
      }
    }
  }

  const { headSha: gitSha, treeSha: treeDigest } = getGitInfo();
  const trustDef = TRUST_LEVEL_DEFINITIONS[trustTier] || TRUST_LEVEL_DEFINITIONS.T0;
  const verdictPayload = {
    schemaVersion: SCHEMA_VERSIONS.verdict,
    ok: verdictStatus === 'pass',
    exitCode,
    verdict: verdictStatus,
    trustTier,
    trustLevel: trustTier,
    mergeGradeGreen: trustDef.mergeGradeGreen && verdictStatus === 'pass',
    trustLevelDefinition: { zh: trustDef.zh, en: trustDef.en },
    confidence: {
      level: trustTier === 'T2' ? 'high' : trustTier === 'T1' && runOut.acceptanceScope === 'business-e2e' ? 'medium-high' : 'medium',
      reasons: confidenceReasons,
    },
    runId: runOut.runId,
    gitSha,
    base: {
      requested: baseResolution.requested,
      resolved: baseResolution.resolved,
      strategy: baseResolution.strategy,
      sha: baseResolution.sha,
    },
    acceptanceScope: runOut.acceptanceScope,
    counts: runOut.counts,
    scope: {
      requested: requestedMode,
      actual: effectiveSuite,
      downgraded: scopeDowngraded,
      mode: requestedMode,
      effectiveSuite,
      selected: impact.specs.length,
      total: impact.totalSpecsCount ?? impact.specs.length,
      why: impact.why || [],
    },
    gates: effectiveGates,
    gateErrors: combinedGateErrors,
    ...(parityCheck?.paritySummary ? { paritySummary: parityCheck.paritySummary } : {}),
    evidence: {
      treeDigest,
      resultsDigest: auditOut.evidence?.resultsDigest || null,
      lockDigest: auditOut.evidence?.lockDigest || null,
      ledgerMac: auditOut.evidence?.ledgerMac || null,
    },
    ai: { llmCalls: 0, models: [], promptHashes: [] },
    failures: diagFailures,
    traceability: {
      coveredRequirements: traceMatrix.coveredRequirements,
      totalRequirements: traceMatrix.totalRequirements,
      coveragePct: traceMatrix.coveragePct,
    },
    nextActions,
  };

  // Step 8: Write Human Seam Gatekeeper Card, in-toto Statement v1 Attestation, PR Markdown Summary & SARIF 2.1.0
  const { seamReview, ...artifactPaths } = writeVerdictArtifacts({
    qaDir, repoDir, lang, baseResolution, verdictPayload, treeDigest, auditOut, gateKernelVersion: GATE_KERNEL_VERSION,
  });

  return { ...verdictPayload, seamReview, artifacts: artifactPaths };
}

/**
 * @param {Record<string, any>} [options]
 * @returns {Promise<number>}
 */
export async function runVerifyChangeCommand(options = {}) {
  /** @type {Record<string, any>} */
  const res = await verifyChangeCore(options);
  if (!options.json) {
    if (res.error && !res.verdict) {
      console.error(res.error);
    } else {
      console.log(
        `\n[Verify Change] Verdict=${String(res.verdict).toUpperCase()} trustTier=${res.trustTier || 'T0'} runId=${res.runId || 'none'} scope=${res.acceptanceScope}`
      );
      if (res.artifacts?.summaryMdPath) {
        console.log(`  Verdict MD   : ${res.artifacts.summaryMdPath}`);
        console.log(`  SARIF Report : ${res.artifacts.sarifPath}`);
        if (res.artifacts.attestationPath) console.log(`  Attestation  : ${res.artifacts.attestationPath}`);
        if (res.artifacts.sigstoreBundlePath) console.log(`  Sigstore     : ${res.artifacts.sigstoreBundlePath}`);
      }
      for (const e of res.gateErrors || []) console.error(`  [GATE FAIL] ${e}`);
    }
  }
  const summary =
    res.error && !res.verdict
      ? String(res.error)
      : `Verdict=${String(res.verdict).toUpperCase()} (${res.trustTier || 'T0'}, runId=${res.runId || 'none'}, scope=${res.acceptanceScope})`;
  return emitCommandResult(
    buildCommandResult({
      tool: 'verify-change',
      outcome: res.verdict === 'blocked' || res.exitCode === 2 ? 'blocked' : res.ok ? 'pass' : 'fail',
      ok: Boolean(res.ok),
      exitCode: res.exitCode,
      summary,
      recoverable: Boolean(res.recoverable),
      blockerKind: res.blockerKind || null,
      recoverySteps: Array.isArray(res.recoverySteps) ? res.recoverySteps : [],
      data: res,
    }),
    { asJson: Boolean(options.json) }
  );
}
