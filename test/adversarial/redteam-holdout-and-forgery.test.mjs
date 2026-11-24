import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli.mjs';
import { suggestFailureCategory } from '../../src/diagnose.mjs';
import { runGovernanceCommand } from '../../src/governance.mjs';
import {
  analyzeHealerDiffText,
  classifyAssertionStatement,
  loadActiveQuarantine,
  resolveDefaultDiffBase,
  runAuditForQaDir,
  unquoteGitPath,
} from '../../src/kernel/gate-kernel.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';
import { buildInTotoVerdictAttestation, verifyAttestationFile } from '../../src/trust.mjs';
import { verifyChangeCore } from '../../src/verdict.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADV_DIR = __dirname;

function gitIn(cwd, args) {
  return spawnSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('Red-Team Holdout Suite (Appendix A): AST Semantic Diff Guard blocks 24/24 out-of-sample cheats (FGER-holdout = 0%) & catches all 7 S0 classifier probes', () => {
  const holdoutCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'holdout-diff-bypasses.cases.json'), 'utf8'));
  assert.equal(holdoutCases.length, 24);

  const escaped = [];
  for (const c of holdoutCases) {
    const res = analyzeHealerDiffText(c.diff);
    if (res.ok) escaped.push(c.id);
  }
  assert.deepEqual(escaped, [], `Holdout cheats escaped AST Diff Guard: ${escaped.join(', ')}`);

  // Verify all 7 assertion classifier probes from Appendix A are classified as S0 (tier === 0)
  const s0Probes = [
    'await expect(page).toHaveURL(() => true);',
    'expect(1 + 1).toBe(2);',
    "expect(Number('1')).toBe(1);",
    'expect([1].length).toBe(1);',
    'expect(await page.evaluate(() => 1)).toBe(1);',
    "expect(true, 'msg').toBe(true);",
    'expect((true)).toBe(true);',
  ];
  for (const stmt of s0Probes) {
    const cls = classifyAssertionStatement(stmt);
    assert.equal(cls.tier, 0, `Expected S0 for probe "${stmt}", got tier=S${cls.tier} (${cls.label})`);
  }

  // Verify Chinese non-ASCII Git path unquoting (`G-07`)
  assert.equal(
    unquoteGitPath('"\\346\\265\\213\\350\\257\\225\\345\\267\\245\\344\\275\\234\\345\\217\\260/qa/playwright.config.ts"'),
    '测试工作台/qa/playwright.config.ts'
  );
});

test('Benign Refactoring Corpus: AST Semantic Diff Guard achieves 0.0% False Positive Rate (12/12 allowed)', () => {
  const benignCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'benign-refactors.cases.json'), 'utf8'));
  assert.ok(benignCases.length >= 12);

  const falsePositives = [];
  for (const bc of benignCases) {
    const res = analyzeHealerDiffText(bc.diff);
    if (!res.ok) falsePositives.push(`${bc.id}: ${res.violations.join('; ')}`);
  }
  assert.deepEqual(falsePositives, [], `Benign refactorings wrongly blocked:\n${falsePositives.join('\n')}`);
});

test('Real Playwright Stack Triage (D-01..D-03): 100% accuracy & 0% C->A misclassification across 12 real stacks', () => {
  const realCases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'real-playwright-triage.cases.json'), 'utf8'));
  assert.equal(realCases.length, 12);

  const wrong = [];
  for (const rc of realCases) {
    const got = suggestFailureCategory(rc.error, rc.guard || null);
    if (got.categoryCode !== rc.expected) {
      wrong.push(`${rc.id}: expected ${rc.expected}, got ${got.categoryCode} (${got.reason})`);
    }
  }
  assert.deepEqual(wrong, [], `Real Playwright stack triage errors:\n${wrong.join('\n')}`);
});

test('End-to-End Forgery Resistance (E1-E6 & T-01..T-06): fail-closed lock/ledger deletion, T1 MAC tamper, self-quarantine, maxSkipped=0, and bot approver', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-forgery-'));
  const t1KeyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-t1key-'));
  const prevKey = process.env.AITEST_HMAC_KEY;
  process.env.AITEST_HMAC_KEY = 'red-team-external-t1-secret-key-0123456789abcdef';

  try {
    await runCli(['init', '--name', 'forgery-app', '--target', repoDir, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(repoDir, 'qa');

    const began = beginRunLedger(qaDir, { suite: 'smoke', command: 'playwright test', repoDir });
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    const writeResults = (specs) =>
      fs.writeFileSync(
        resultsPath,
        JSON.stringify({
          config: { metadata: { runId: began.runId } },
          suites: [{ file: 'tests/smoke/workbench.spec.ts', specs }],
        }),
        'utf8'
      );
    writeResults([{ title: 'ok @smoke', line: 4, tests: [{ status: 'expected', results: [] }] }]);
    finalizeRunLedger(qaDir, began.runId, { exitCode: 0, resultsPath });

    const baseAudit = runAuditForQaDir(qaDir, { requireT1Mac: true });
    assert.equal(baseAudit.ok, true, baseAudit.errors.join('\n'));
    assert.equal(baseAudit.trustTier, 'T1');

    // E1: Forged manifest (tamper resultsSha256 or strip MAC) -> blocked/failed!
    const manifestPath = path.join(qaDir, '.aitest', 'runs', began.runId, 'manifest.json');
    const origManifest = fs.readFileSync(manifestPath, 'utf8');
    const forgedManifest = JSON.parse(origManifest);
    forgedManifest.mac = 'hmac-sha256:0000000000000000000000000000000000000000000000000000000000000000';
    fs.writeFileSync(manifestPath, JSON.stringify(forgedManifest, null, 2), 'utf8');
    const e1 = runAuditForQaDir(qaDir, { requireT1Mac: true });
    assert.equal(e1.ok, false);
    assert.ok(e1.errors.some((e) => /HMAC|MAC|Ledger/i.test(e)));
    fs.writeFileSync(manifestPath, origManifest, 'utf8');

    // E2: Self-quarantine with year 2099 TTL & no ledger flaky evidence & missing MAC -> rejected!
    const qPath = path.join(qaDir, '.aitest', 'quarantine.json');
    fs.writeFileSync(
      qPath,
      JSON.stringify({
        schemaVersion: 1,
        entries: [
          {
            file: 'tests/smoke/workbench.spec.ts',
            title: 'ok @smoke',
            expiresAt: '2099-01-01T00:00:00Z',
            reason: 'agent self-quarantine',
          },
          {
            file: 'tests/e2e/home.spec.ts',
            title: 'landing page',
            expiresAt: '2099-01-01T00:00:00Z',
            reason: 'agent self-quarantine 2099',
          },
        ],
      }),
      'utf8'
    );
    const qCheckMac = loadActiveQuarantine(qaDir, { requireT1Mac: true });
    assert.equal(qCheckMac.ok, false);
    assert.ok(qCheckMac.errors.some((e) => /HMAC|MAC|Quarantine Tamper/i.test(e)));
    assert.ok(qCheckMac.errors.length >= 2);
    fs.unlinkSync(qPath);

    // E3: Mass skipped tests with default maxSkipped=0 -> rejected!
    writeResults([
      { title: 'ok @smoke', line: 4, tests: [{ status: 'expected', results: [] }] },
      { title: 'silently skipped test', line: 10, tests: [{ status: 'skipped', results: [] }] },
    ]);
    finalizeRunLedger(qaDir, began.runId, { exitCode: 0, resultsPath });
    const e3 = runAuditForQaDir(qaDir);
    assert.equal(e3.ok, false);
    assert.ok(e3.errors.some((e) => /skipped test count/i.test(e)));

    writeResults([{ title: 'ok @smoke', line: 4, tests: [{ status: 'expected', results: [] }] }]);
    finalizeRunLedger(qaDir, began.runId, { exitCode: 0, resultsPath });

    // E4: Forged governance.lock (recalculated hashes, wrong/missing T1 MAC) -> blocked!
    const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
    const origLock = fs.readFileSync(lockPath, 'utf8');
    const tamperedLock = JSON.parse(origLock);
    tamperedLock.mac = 'hmac-sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff';
    fs.writeFileSync(lockPath, JSON.stringify(tamperedLock, null, 2), 'utf8');
    const e4 = runAuditForQaDir(qaDir, { requireT1Mac: true });
    assert.equal(e4.ok, false);
    assert.ok(['fail', 'blocked'].includes(e4.outcome));
    assert.ok(e4.errors.some((e) => /HMAC|Tamper/i.test(e)));

    // E5: Deleting BOTH governance.lock AND governance-audit.jsonl -> FAIL-CLOSED blocked!
    fs.unlinkSync(lockPath);
    const auditLogPath = path.join(qaDir, '.aitest', 'governance-audit.jsonl');
    if (fs.existsSync(auditLogPath)) fs.unlinkSync(auditLogPath);
    const e5 = runAuditForQaDir(qaDir);
    assert.equal(e5.ok, false);
    assert.equal(e5.outcome, 'blocked');
    assert.ok(e5.errors.some((e) => /Missing \.aitest\/governance\.lock/i.test(e)));
    fs.writeFileSync(lockPath, origLock, 'utf8');

    // E6: Deleting .aitest/runs ledger directory -> FAIL-CLOSED blocked!
    fs.rmSync(path.join(qaDir, '.aitest', 'runs'), { recursive: true, force: true });
    const e6 = runAuditForQaDir(qaDir);
    assert.equal(e6.ok, false);
    assert.equal(e6.outcome, 'blocked');
    assert.ok(e6.errors.some((e) => /Missing \.aitest\/runs\/latest\.json/i.test(e)));

    // Bot approver variants (`claude-code`, `codex-cli`) blocked by BOT_APPROVER_RE!
    for (const bot of ['claude-code', 'codex-cli', 'ai-agent']) {
      const botCode = await runGovernanceCommand({
        action: 'approve',
        target: repoDir,
        by: bot,
        reason: 'test',
      });
      assert.equal(botCode, 2, `Bot approver "${bot}" should be rejected with exitCode 2`);
    }
  } finally {
    if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY;
    else process.env.AITEST_HMAC_KEY = prevKey;
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(t1KeyDir, { recursive: true, force: true });
  }
});

test('Commit-before-verify diff base resolution (T-05), non-git fail-closed (T-02), and in-toto v1 Attestation verification (T-04)', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-commit-verify-'));
  const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-nongit-'));
  try {
    // 1. Non-git workspace -> verifyChangeCore returns blocked (exitCode=2)
    await runCli(['init', '--name', 'nongit-app', '--target', nonGitDir, '--skip-install', '--loop', 'none']);
    const nonGitVerdict = await verifyChangeCore({ target: nonGitDir, mode: 'impact' });
    assert.equal(nonGitVerdict.ok, false);
    assert.equal(nonGitVerdict.verdict, 'blocked');
    assert.equal(nonGitVerdict.exitCode, 2);

    // 2. Commit-before-verify: agent commits a cheating diff, then asks for default diff base!
    await runCli(['init', '--name', 'git-app', '--target', repoDir, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(repoDir, 'qa');
    gitIn(repoDir, ['init']);
    gitIn(repoDir, ['config', 'user.email', 'dev@example.com']);
    gitIn(repoDir, ['config', 'user.name', 'Dev']);
    gitIn(repoDir, ['add', '.']);
    gitIn(repoDir, ['commit', '-m', 'baseline']);

    const specFile = path.join(qaDir, 'tests', 'smoke', 'workbench.spec.ts');
    const origSpec = fs.readFileSync(specFile, 'utf8');
    fs.writeFileSync(specFile, origSpec.replace(/toHaveText\([^)]+\)/, 'toBeVisible()'), 'utf8');
    gitIn(repoDir, ['add', '.']);
    gitIn(repoDir, ['commit', '-m', 'agent weakens assertion before verify']);

    const resolvedBase = resolveDefaultDiffBase(repoDir);
    assert.equal(resolvedBase.isGitRepo, true);
    assert.equal(resolvedBase.resolved, 'HEAD~1');

    const diffAudit = runAuditForQaDir(qaDir, { staticOnly: true, diffBase: resolvedBase.resolved });
    assert.equal(diffAudit.ok, false);
    assert.ok(diffAudit.errors.some((e) => /AITEST-G103/.test(e)));

    // 3. in-toto Statement v1 Attestation build + tamper detection
    const attPath = path.join(qaDir, 'reports', 'attestation.json');
    fs.mkdirSync(path.dirname(attPath), { recursive: true });
    const statement = buildInTotoVerdictAttestation({
      repoDir,
      qaDir,
      gateKernelVersion: '5.1.0',
      verdictPayload: {
        gitSha: 'deadbeef1234567890',
        verdict: 'pass',
        trustTier: 'T1',
        runId: '01TESTRUNID000000000000000',
        suite: 'smoke',
        base: { requested: 'auto', resolved: 'HEAD~1', strategy: 'clean-tree-parent' },
        scope: { requested: 'impact', actual: 'smoke', downgraded: false },
        gates: { governance: 'pass', static: 'pass', runtime: 'pass', semanticDiff: 'pass' },
        acceptanceScope: 'local-workbench',
        stats: { passed: 3, failed: 0, flaky: 0, skipped: 0 },
        evidence: { diffCheckedFiles: ['tests/smoke/workbench.spec.ts'] },
      },
    });
    assert.equal(statement._type, 'https://in-toto.io/Statement/v1');
    fs.writeFileSync(attPath, JSON.stringify(statement, null, 2), 'utf8');

    const validVerify = verifyAttestationFile(attPath, { allowT1: true });
    assert.equal(validVerify.ok, true, validVerify.errors.join('\n'));
    assert.equal(validVerify.trustLevel, 'T1');

    const strictReject = verifyAttestationFile(attPath);
    assert.equal(strictReject.ok, false);
    assert.equal(strictReject.trustLevel, 'T1');
    assert.equal(strictReject.reasonCode, 'T1_ONLY_NOT_T2');

    const tampered = JSON.parse(fs.readFileSync(attPath, 'utf8'));
    tampered.predicate.verdict = 'pass-forged';
    fs.writeFileSync(attPath, JSON.stringify(tampered, null, 2), 'utf8');
    const badVerify = verifyAttestationFile(attPath, { requireT1Mac: true, allowT1: true });
    assert.equal(badVerify.ok, false);
    assert.equal(badVerify.reasonCode, 'DIGEST_MISMATCH');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(nonGitDir, { recursive: true, force: true });
  }
});
