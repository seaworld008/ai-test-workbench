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
import { generateDiagnosticsMarkdown } from './diagnose.mjs';
import { computeImpact } from './impact.mjs';
import { resolveGitHeadSha } from './ledger.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import { resolvePlaywrightCli } from './proc.mjs';
import { executeSuiteCore } from './runner.mjs';
import { buildRequirementTraceMatrix } from './traceability.mjs';
import {
  buildInTotoVerdictAttestation,
  resolveVerdictTrustTier,
  tryCosignKeylessSign,
} from './trust.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from './version.mjs';
import {
  listChangedFilesUnderDir,
  resolveGitTreeSha,
  verifyPayloadT1,
} from '../templates/playwright-qa/support/gate-kernel.mjs';

function buildSarifReport(verdictObj) {
  const results = [];
  for (const errMsg of verdictObj.gateErrors || []) {
    const codeMatch = /\[(AITEST-G\d+|Governance Tamper Blocked|Stale Results Blocked|Run Ledger Blocked|Heal Governance Blocked|Static Check)\]/.exec(
      errMsg
    );
    results.push({
      ruleId: codeMatch ? codeMatch[1].replace(/\s+/g, '-') : 'AITEST-GATE-FAILURE',
      level: 'error',
      message: { text: errMsg },
    });
  }
  for (const f of verdictObj.failures || []) {
    results.push({
      ruleId: `AITEST-TEST-CLASS-${f.categoryCode || 'U'}`,
      level: 'error',
      message: { text: `[${f.category}] ${f.title}: ${f.errorSnippet || ''}`.slice(0, 500) },
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: f.file },
            region: { startLine: Math.max(1, Number(f.line || 1)) },
          },
        },
      ],
    });
  }

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'ai-test-workbench',
            version: WORKBENCH_VERSION,
            informationUri: 'https://github.com/seaworld008/ai-test-workbench',
          },
        },
        results,
      },
    ],
  };
}

function buildPrVerdictMarkdown(verdict, lang = 'zh') {
  const isZh = lang === 'zh';
  const badge =
    verdict.verdict === 'pass'
      ? 'PASS'
      : verdict.verdict === 'blocked'
        ? 'BLOCKED'
        : 'FAIL';
  const trustLabel =
    verdict.trustTier === 'T2'
      ? isZh
        ? 'T2 CI 证明（可信绿灯）'
        : 'T2 CI-Attested (Trustworthy Green)'
      : verdict.trustTier === 'T1'
        ? isZh
          ? 'T1 本地防篡改预检（需 CI T2 终审）'
          : 'T1 Local Tamper-Evident Pre-Check (CI T2 required to merge)'
        : isZh
          ? 'T0 本地建议（不可作为可信绿灯）'
          : 'T0 Advisory Only (Not a Trustworthy Green)';
  const scopeLabel =
    verdict.acceptanceScope === 'business-e2e'
      ? isZh
        ? '真实业务 E2E 验收'
        : 'Business E2E Verified'
      : isZh
        ? '本机工作台离线验收（非远端业务 E2E）'
        : 'Local Workbench Verified (Offline Smoke Only)';

  const lines = [
    isZh
      ? `## AI Test Workbench 变更验证判决：**${badge}**（\`${verdict.trustTier}\`）`
      : `## AI Test Workbench Change Verdict: **${badge}** (\`${verdict.trustTier}\`)`,
    '',
    `- **Trust Tier**: **${trustLabel}**`,
    `- **Run ID**: \`${verdict.runId || 'none'}\` · **Git SHA**: \`${verdict.gitSha}\` · **Diff Base**: \`${verdict.base?.resolved || 'none'}\` (${verdict.base?.strategy || 'unknown'})`,
    `- **验收口径 (` + 'acceptanceScope' + `)**: **${scopeLabel}** (\`${verdict.acceptanceScope}\`)`,
    `- **测试范围**: requested=\`${verdict.scope.requested}\`, actual=\`${verdict.scope.actual}\`${verdict.scope.downgraded ? ' **(DOWNGRADED -> T0)**' : ''}, executed=\`${verdict.counts?.executed ?? 0}\` (passed=\`${verdict.counts?.passed ?? 0}\`, failed=\`${verdict.counts?.failed ?? 0}\`, flaky=\`${verdict.counts?.flaky ?? 0}\`)`,
    `- **四层门禁**: governance=\`${verdict.gates.governance}\` · static=\`${verdict.gates.static}\` · runtime=\`${verdict.gates.runtime}\` · semanticDiff=\`${verdict.gates.semanticDiff}\``,
    `- **需求追溯**: \`${verdict.traceability.coveredRequirements}/${verdict.traceability.totalRequirements}\` (${verdict.traceability.coveragePct}%)`,
    `- **AI-BOM**: llmCalls=\`${verdict.ai?.llmCalls ?? 0}\``,
    '',
  ];

  if (verdict.failures.length > 0) {
    lines.push(isZh ? '### 失败定责与根因证据' : '### Failure Triage & Trace Evidence');
    for (const f of verdict.failures) {
      lines.push(
        `- **[${f.categoryCode}]** \`${f.file}:${f.line}\` — ${f.title} (traceId=\`${f.traceId || 'n/a'}\`, confidence=\`${f.confidence}\`)`
      );
    }
    lines.push('');
  }

  if (verdict.gateErrors.length > 0) {
    lines.push(isZh ? '### 门禁拦截明细' : '### Quality Gate Violations');
    for (const e of verdict.gateErrors) lines.push(`- ${e}`);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Checks `.aitest/heals/*.json` against modified specs in the current diff (`T-07`):
 * If an active/unclosed B/C/D heal session exists AND its spec file was edited, block the verdict!
 * Also detects tampered heal session files via T1 HMAC.
 */
function checkHealSessionConflicts(qaDir, baseResolution) {
  const healsDir = path.join(qaDir, '.aitest', 'heals');
  if (!fs.existsSync(healsDir)) return { ok: true, errors: [] };

  const errors = [];
  let changedInsideQa = new Set();

  if (baseResolution.isGitRepo && baseResolution.gitRoot && baseResolution.resolved) {
    const ch = listChangedFilesUnderDir(baseResolution.gitRoot, baseResolution.resolved, qaDir);
    if (ch.ok) {
      for (const item of ch.changed) {
        const rel = path.relative(qaDir, path.join(baseResolution.gitRoot, item.path)).replace(/\\/g, '/');
        changedInsideQa.add(rel);
      }
      for (const u of ch.untracked) {
        const rel = path.relative(qaDir, path.join(baseResolution.gitRoot, u)).replace(/\\/g, '/');
        changedInsideQa.add(rel);
      }
    }
  }

  for (const name of fs.readdirSync(healsDir)) {
    if (!name.endsWith('.json') || name === 'ledger.json') continue;
    const full = path.join(healsDir, name);
    try {
      const session = JSON.parse(fs.readFileSync(full, 'utf8'));
      const macCheck = verifyPayloadT1('heal.session', session, session.mac, {
        qaDir,
        repoDir: path.dirname(qaDir),
        requireMac: Boolean(session.mac),
      });
      if (!macCheck.ok) {
        errors.push(`[Heal Governance Blocked] Tampered heal session "${session.sessionId || name}": ${macCheck.reason}`);
        continue;
      }

      const isNonA = session.categoryCode && session.categoryCode !== 'A';
      const isOpen = session.state !== 'concluded' && session.state !== 'verified';
      const specFile = String(session.specFile || '').replace(/\\/g, '/');
      if (isNonA && isOpen && specFile && changedInsideQa.has(specFile)) {
        errors.push(
          `[Heal Governance Blocked] Spec "${specFile}" was modified while non-repairable Class-${session.categoryCode} heal session "${session.sessionId}" is open. Revert spec edit and conclude as defect/escalation.`
        );
      }
    } catch {
      errors.push(`[Heal Governance Blocked] Corrupted heal session file "${name}".`);
    }
  }

  return { ok: errors.length === 0, errors };
}

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
  const requestedMode = String(options.mode || 'impact').toLowerCase() === 'full' ? 'full' : 'impact';

  // Step 0: Resolve real Git root (monorepo/worktree aware) & safe diff base (`T-05`)
  const baseResolution = resolveDefaultDiffBase(repoDir, options.base || null);

  // Step 1: Pre-flight Layer 0 Governance Lock Integrity (Fail-Closed!)
  const govPre = verifyGovernanceLockInQaDir(qaDir);
  if (!govPre.ok) {
    return {
      schemaVersion: SCHEMA_VERSIONS.verdict,
      ok: false,
      exitCode: 2,
      verdict: 'blocked',
      trustTier: 'T0',
      confidence: { level: 'high', reasons: ['governance-tamper-detected'] },
      runId: null,
      gitSha: resolveGitHeadSha(repoDir),
      base: baseResolution,
      acceptanceScope: 'local-workbench',
      scope: { requested: requestedMode, actual: 'none', downgraded: true, mode: requestedMode, selected: 0, total: 0, why: [] },
      gates: { governance: govPre.status || 'blocked', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: govPre.errors,
      failures: [],
      ai: { llmCalls: 0, models: [], promptHashes: [] },
      nextActions: [{ action: 'human-cli', command: 'npx ai-test-workbench governance approve --target <repo> --by <human> --reason <why>' }],
    };
  }

  // Step 1b: Fail-closed if Git diff base cannot be resolved (unless explicit CLI-only allowNonGit for T0 advisory)
  const allowNonGit = process.env.AITEST_MCP_CHILD !== '1' && Boolean(options.allowNonGit);
  if ((!baseResolution.isGitRepo || !baseResolution.resolved) && !allowNonGit) {
    return {
      schemaVersion: SCHEMA_VERSIONS.verdict,
      ok: false,
      exitCode: 2,
      verdict: 'blocked',
      trustTier: 'T0',
      confidence: { level: 'high', reasons: ['semantic-diff-base-unresolved'] },
      runId: null,
      gitSha: resolveGitHeadSha(repoDir),
      base: baseResolution,
      acceptanceScope: 'local-workbench',
      scope: { requested: requestedMode, actual: 'none', downgraded: true, mode: requestedMode, selected: 0, total: 0, why: [] },
      gates: { governance: govPre.status || 'pass', static: 'skipped', runtime: 'skipped', semanticDiff: 'blocked' },
      gateErrors: [
        `[Verify Change Blocked] ${baseResolution.error || 'Unable to resolve Git diff base for Layer 3 Semantic AST Guard.'} Initialize Git or specify a valid --base commit.`,
      ],
      failures: [],
      ai: { llmCalls: 0, models: [], promptHashes: [] },
      nextActions: [{ action: 'git-check', command: 'git status && git rev-parse --show-toplevel' }],
    };
  }

  // Step 2: Target Safety & Scope Resolution
  const overrides = {};
  if (options.baseUrl) overrides.TEST_BASE_URL = options.baseUrl;
  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  const safety = evaluateTargetSafety(mergedEnv);
  if (!safety.ok) {
    return {
      schemaVersion: SCHEMA_VERSIONS.verdict,
      ok: false,
      exitCode: 2,
      verdict: 'blocked',
      trustTier: 'T0',
      confidence: { level: 'high', reasons: ['target-guard-blocked'] },
      runId: null,
      gitSha: resolveGitHeadSha(repoDir),
      base: baseResolution,
      acceptanceScope: 'local-workbench',
      scope: { requested: requestedMode, actual: 'none', downgraded: true, mode: requestedMode, selected: 0, total: 0, why: [] },
      gates: { governance: govPre.status || 'pass', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: safety.errors,
      failures: [],
      ai: { llmCalls: 0, models: [], promptHashes: [] },
      nextActions: [],
    };
  }

  const effectiveBaseRef = baseResolution.resolved || 'HEAD~1';
  const impact = await computeImpact(repoDir, { qaDir: options.qaDir, base: effectiveBaseRef });
  const hasPlaywright = Boolean(resolvePlaywrightCli(qaDir));
  if (!hasPlaywright) {
    return {
      schemaVersion: SCHEMA_VERSIONS.verdict,
      ok: false,
      exitCode: 2,
      verdict: 'blocked',
      trustTier: 'T0',
      error: `Playwright dependencies not installed in ${qaDir}. Run init first.`,
    };
  }

  const effectiveSuite =
    requestedMode === 'full' ? (safety.baseURL ? 'all' : 'smoke') : safety.baseURL ? 'impact' : 'smoke';
  const scopeDowngraded = !safety.baseURL && (requestedMode === 'full' || requestedMode === 'impact');

  // Step 3: Execute suite bound to Run Ledger (pass precomputedImpact so computeImpact runs ONCE!)
  const runOut = await executeSuiteCore({
    target,
    qaDir: options.qaDir,
    suite: effectiveSuite,
    baseUrl: options.baseUrl,
    base: effectiveBaseRef,
    precomputedImpact: impact,
    audit: false,
    timeoutMs: options.budgetMs || 15 * 60_000,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  // Step 4: Full 4-Layer Fail-Closed AST Audit
  const auditOut = runAuditForQaDir(qaDir, {
    checkSpecs: true,
    requireE2e: Boolean(safety.baseURL && requestedMode === 'full'),
    allowMutation: safety.allowMutation,
    expectedRunId: runOut.runId,
    diffBase: baseResolution.resolved,
    requireDiff: !allowNonGit,
  });

  // Step 4b: Check Heal Session Conflicts (`T-07`)
  const healCheck = checkHealSessionConflicts(qaDir, baseResolution);
  const combinedGateErrors = [...auditOut.errors, ...healCheck.errors];

  // Step 5: Structured Diagnostics on Failures
  const resultsPath = path.join(qaDir, 'reports', 'results.json');
  let diagFailures = [];
  if (fs.existsSync(resultsPath)) {
    const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
    diagFailures = diag.failures.map((f) => ({
      testId: f.testId,
      title: f.title,
      file: f.file,
      line: f.line,
      categoryCode: f.categoryCode,
      category: f.category,
      confidence: f.confidence,
      candidates: f.candidates,
      traceId: f.traceId,
      traceIds: f.traceIds,
      errorSnippet: f.errorSnippet,
      evidence: runOut.runId ? `aitest://project/${encodeURIComponent(target)}/diagnostics` : null,
    }));
    fs.writeFileSync(path.join(qaDir, 'reports', 'ai-diagnostics.md'), diag.markdown, 'utf8');
  }

  // Step 6: Requirement Traceability Matrix
  const traceMatrix = buildRequirementTraceMatrix(qaDir);

  // Step 7: Strict 3-State Verdict (`pass | fail | blocked`) — NEVER turn `skipped`/`blocked` into `pass`!
  const gateValues = Object.values(auditOut.gates || {});
  const hasBlockedGate = auditOut.outcome === 'blocked' || gateValues.includes('blocked') || !healCheck.ok;
  const hasRequiredSkippedGate = !allowNonGit && gateValues.includes('skipped');
  const allPassed =
    runOut.exitCode === 0 &&
    auditOut.ok &&
    healCheck.ok &&
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
        nextActions.push({ tool: 'aitest_heal_begin', args: { target, testId: f.testId } });
      } else {
        nextActions.push({
          tool: 'aitest_heal_begin',
          note: `Category ${f.categoryCode}: open session and conclude as defect/escalation without editing assertions`,
          args: { target, testId: f.testId },
        });
      }
    }
  }

  const gitSha = resolveGitHeadSha(repoDir);
  const treeDigest = resolveGitTreeSha(repoDir);
  const verdictPayload = {
    schemaVersion: SCHEMA_VERSIONS.verdict,
    ok: verdictStatus === 'pass',
    exitCode,
    verdict: verdictStatus,
    trustTier,
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
    gates: auditOut.gates,
    gateErrors: combinedGateErrors,
    evidence: {
      treeDigest,
      resultsDigest: auditOut.evidence?.resultsDigest || null,
      lockDigest: auditOut.evidence?.lockDigest || null,
      ledgerMac: auditOut.evidence?.ledgerMac || null,
    },
    ai: {
      llmCalls: 0,
      models: [],
      promptHashes: [],
    },
    failures: diagFailures,
    traceability: {
      coveredRequirements: traceMatrix.coveredRequirements,
      totalRequirements: traceMatrix.totalRequirements,
      coveragePct: traceMatrix.coveragePct,
    },
    nextActions,
  };

  // Step 8: Write in-toto Statement v1 Attestation, PR Markdown Summary & SARIF 2.1.0
  const reportsDir = path.join(qaDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const mdSummary = buildPrVerdictMarkdown(verdictPayload, lang);
  const sarifObj = buildSarifReport(verdictPayload);
  const summaryMdPath = path.join(reportsDir, 'verdict-summary.md');
  const sarifPath = path.join(reportsDir, 'verdict.sarif.json');
  fs.writeFileSync(summaryMdPath, mdSummary, 'utf8');
  fs.writeFileSync(sarifPath, JSON.stringify(sarifObj, null, 2) + '\n', 'utf8');

  if (process.env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${mdSummary}\n`, 'utf8');
    } catch {
      // ignore CI step summary write failure
    }
  }

  let attestationPath = null;
  let sigstoreBundlePath = null;
  if (runOut.runId) {
    const runDir = path.join(qaDir, '.aitest', 'runs', runOut.runId);
    fs.mkdirSync(runDir, { recursive: true });
    attestationPath = path.join(runDir, 'attestation.json');
    const statement = buildInTotoVerdictAttestation({
      verdictPayload,
      qaDir,
      repoDir,
      treeDigest,
      resultsDigest: auditOut.evidence?.resultsDigest,
      lockDigest: auditOut.evidence?.lockDigest,
      gateKernelVersion: GATE_KERNEL_VERSION,
    });
    fs.writeFileSync(attestationPath, JSON.stringify(statement, null, 2) + '\n', 'utf8');

    const cosignRes = tryCosignKeylessSign(attestationPath);
    if (cosignRes.signed) {
      sigstoreBundlePath = cosignRes.bundlePath;
    }
  }

  return {
    ...verdictPayload,
    artifacts: {
      summaryMdPath,
      sarifPath,
      attestationPath,
      sigstoreBundlePath,
    },
  };
}

export async function runVerifyChangeCommand(options = {}) {
  /** @type {Record<string, any>} */
  const res = await verifyChangeCore(options);
  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.exitCode;
  }
  if (res.error && !res.verdict) {
    console.error(res.error);
    return res.exitCode;
  }
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
  return res.exitCode;
}
