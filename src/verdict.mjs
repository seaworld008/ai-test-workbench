// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { GATE_KERNEL_VERSION, runAuditForQaDir, verifyGovernanceLockInQaDir } from './audit.mjs';
import { generateDiagnosticsMarkdown } from './diagnose.mjs';
import { computeImpact } from './impact.mjs';
import { resolveGitHeadSha } from './ledger.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import { resolvePlaywrightCli } from './proc.mjs';
import { executeSuiteCore } from './runner.mjs';
import { buildRequirementTraceMatrix } from './traceability.mjs';
import { SCHEMA_VERSIONS, WORKBENCH_VERSION } from './version.mjs';

function buildSarifReport(verdictObj) {
  const results = [];
  for (const errMsg of verdictObj.gateErrors || []) {
    const codeMatch = /\[(AITEST-G\d+|Governance Tamper Blocked|Stale Results Blocked|Static Check)\]/.exec(errMsg);
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
      ? `## AI Test Workbench 变更可信判决：**${badge}**`
      : `## AI Test Workbench Change Verdict: **${badge}**`,
    '',
    `- **Run ID**: \`${verdict.runId || 'none'}\` · **Git SHA**: \`${verdict.gitSha}\` · **Confidence**: \`${verdict.confidence.level}\``,
    `- **验收口径 (` + 'acceptanceScope' + `)**: **${scopeLabel}** (\`${verdict.acceptanceScope}\`)`,
    `- **测试范围**: mode=\`${verdict.scope.mode}\`, executed=\`${verdict.counts?.executed ?? 0}\` (passed=\`${verdict.counts?.passed ?? 0}\`, failed=\`${verdict.counts?.failed ?? 0}\`, flaky=\`${verdict.counts?.flaky ?? 0}\`)`,
    `- **四层门禁**: governance=\`${verdict.gates.governance}\` · static=\`${verdict.gates.static}\` · runtime=\`${verdict.gates.runtime}\` · semanticDiff=\`${verdict.gates.semanticDiff}\``,
    `- **需求追溯**: \`${verdict.traceability.coveredRequirements}/${verdict.traceability.totalRequirements}\` (${verdict.traceability.coveragePct}%)`,
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
 * One-Call Agent Change Verification Orchestrator (`R1-7`: `aitest_verify_change`).
 * Runs: Layer 0 Governance -> Impact v2 -> Suite Run (Ledger-bound) -> 4-Layer Audit -> Diagnostics v2 -> Attestation + SARIF + PR Summary.
 * @param {Record<string, any>} [options]
 */
export async function verifyChangeCore(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    return { ok: false, exitCode: 1, verdict: 'blocked', error: 'Missing --target option' };
  }

  const target = path.resolve(options.target);
  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    return { ok: false, exitCode: 1, verdict: 'blocked', error: `QA directory not found under ${target}` };
  }

  const repoDir = target === qaDir ? path.dirname(qaDir) : target;
  const baseRef = options.base || 'HEAD';
  const mode = String(options.mode || 'impact').toLowerCase() === 'full' ? 'full' : 'impact';

  // Step 1: Pre-flight Layer 0 Governance Lock Integrity
  const govPre = verifyGovernanceLockInQaDir(qaDir);
  if (!govPre.ok) {
    return {
      schemaVersion: SCHEMA_VERSIONS.verdict,
      ok: false,
      exitCode: 2,
      verdict: 'blocked',
      confidence: { level: 'high', reasons: ['governance-tamper-detected'] },
      runId: null,
      gitSha: resolveGitHeadSha(repoDir),
      acceptanceScope: 'local-workbench',
      scope: { mode, selected: 0, total: 0, why: [] },
      gates: { governance: 'fail', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: govPre.errors,
      failures: [],
      nextActions: [{ action: 'human-cli', command: 'npx ai-test-workbench governance approve --target <repo> --by <human> --reason <why>' }],
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
      confidence: { level: 'high', reasons: ['target-guard-blocked'] },
      runId: null,
      gitSha: resolveGitHeadSha(repoDir),
      acceptanceScope: 'local-workbench',
      scope: { mode, selected: 0, total: 0, why: [] },
      gates: { governance: govPre.enforced ? 'pass' : 'skipped', static: 'skipped', runtime: 'skipped', semanticDiff: 'skipped' },
      gateErrors: safety.errors,
      failures: [],
      nextActions: [],
    };
  }

  const impact = await computeImpact(repoDir, { qaDir: options.qaDir, base: baseRef });
  const hasPlaywright = Boolean(resolvePlaywrightCli(qaDir));
  if (!hasPlaywright) {
    return {
      ok: false,
      exitCode: 1,
      verdict: 'blocked',
      error: `Playwright dependencies not installed in ${qaDir}. Run init first.`,
    };
  }

  const effectiveSuite =
    mode === 'full' ? (safety.baseURL ? 'all' : 'smoke') : safety.baseURL ? 'impact' : 'smoke';

  // Step 3: Execute suite bound to Run Ledger
  const runOut = await executeSuiteCore({
    target,
    qaDir: options.qaDir,
    suite: effectiveSuite,
    baseUrl: options.baseUrl,
    base: baseRef,
    audit: false,
    timeoutMs: options.budgetMs || 15 * 60_000,
    onProgress: options.onProgress,
    signal: options.signal,
  });

  // Step 4: Full 4-Layer Audit (including Semantic Diff Guard when inside git repo)
  const isGitRepo = fs.existsSync(path.join(repoDir, '.git'));
  const auditOut = runAuditForQaDir(qaDir, {
    checkSpecs: true,
    requireE2e: Boolean(safety.baseURL && mode === 'full'),
    allowMutation: safety.allowMutation,
    expectedRunId: runOut.runId,
    diffBase: isGitRepo ? baseRef : null,
  });

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
      traceId: f.traceId,
      traceIds: f.traceIds,
      errorSnippet: f.errorSnippet,
      evidence: runOut.runId ? `aitest://project/${encodeURIComponent(target)}/diagnostics` : null,
    }));
    fs.writeFileSync(path.join(qaDir, 'reports', 'ai-diagnostics.md'), diag.markdown, 'utf8');
  }

  // Step 6: Requirement Traceability Matrix
  const traceMatrix = buildRequirementTraceMatrix(qaDir);

  const allPassed = runOut.exitCode === 0 && auditOut.ok;
  const verdictStatus = allPassed ? 'pass' : 'fail';
  const confidenceReasons = [
    `selection=${mode}(recallEst=${impact.recallEstimate ?? 1})`,
    `gateKernel=${GATE_KERNEL_VERSION}`,
    `acceptanceScope=${runOut.acceptanceScope}`,
  ];

  const nextActions = [];
  if (!allPassed) {
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
  const verdictPayload = {
    schemaVersion: SCHEMA_VERSIONS.verdict,
    ok: allPassed,
    exitCode: allPassed ? 0 : 1,
    verdict: verdictStatus,
    confidence: {
      level: runOut.acceptanceScope === 'business-e2e' ? 'high' : 'medium',
      reasons: confidenceReasons,
    },
    runId: runOut.runId,
    gitSha,
    acceptanceScope: runOut.acceptanceScope,
    counts: runOut.counts,
    scope: {
      mode,
      effectiveSuite,
      selected: impact.specs.length,
      total: impact.totalSpecsCount ?? impact.specs.length,
      why: impact.why || [],
    },
    gates: auditOut.gates,
    gateErrors: auditOut.errors,
    failures: diagFailures,
    traceability: {
      coveredRequirements: traceMatrix.coveredRequirements,
      totalRequirements: traceMatrix.totalRequirements,
      coveragePct: traceMatrix.coveragePct,
    },
    nextActions,
  };

  // Step 7: Write Attestation, PR Markdown Summary & SARIF 2.1.0
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
  if (runOut.runId) {
    const runDir = path.join(qaDir, '.aitest', 'runs', runOut.runId);
    fs.mkdirSync(runDir, { recursive: true });
    attestationPath = path.join(runDir, 'attestation.json');
    const canonicalDigest = crypto
      .createHash('sha256')
      .update(JSON.stringify({ runId: runOut.runId, gitSha, verdict: verdictStatus, gates: auditOut.gates, counts: runOut.counts }))
      .digest('hex');
    fs.writeFileSync(
      attestationPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          attestedAt: new Date().toISOString(),
          toolVersion: WORKBENCH_VERSION,
          gateKernelVersion: GATE_KERNEL_VERSION,
          runId: runOut.runId,
          gitSha,
          verdict: verdictStatus,
          acceptanceScope: runOut.acceptanceScope,
          gates: auditOut.gates,
          attestationDigest: `sha256:${canonicalDigest}`,
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
  }

  return {
    ...verdictPayload,
    artifacts: {
      summaryMdPath,
      sarifPath,
      attestationPath,
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
    `\n[Verify Change] Verdict=${String(res.verdict).toUpperCase()} runId=${res.runId || 'none'} scope=${res.acceptanceScope}`
  );
  if (res.artifacts?.summaryMdPath) {
    console.log(`  Verdict MD   : ${res.artifacts.summaryMdPath}`);
    console.log(`  SARIF Report : ${res.artifacts.sarifPath}`);
    if (res.artifacts.attestationPath) console.log(`  Attestation  : ${res.artifacts.attestationPath}`);
  }
  for (const e of res.gateErrors || []) console.error(`  [GATE FAIL] ${e}`);
  return res.exitCode;
}
