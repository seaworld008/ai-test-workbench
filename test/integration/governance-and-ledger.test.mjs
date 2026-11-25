import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { loadAndValidateWaivers, runAuditForQaDir } from '../../src/audit.mjs';
import { runCli } from '../../src/cli.mjs';
import { computeFlakyReport, syncQuarantineFromLedger } from '../../src/flaky.mjs';
import { getMcpToolDefinitions } from '../../src/mcp-server.mjs';
import { attemptHealRepair, beginHealSession, concludeHealSession } from '../../src/heal.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';
import { buildRequirementTraceMatrix } from '../../src/traceability.mjs';

test('Layer 0 Governance Lock intercepts all 5 config/waiver/fixture tampering vectors & blocks MCP self-approval', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-gov-'));
  try {
    const initCode = await runCli([
      'init',
      '--name',
      'gov-demo',
      '--target',
      repoDir,
      '--skip-install',
      '--loop',
      'none',
      '--lang',
      'en',
    ]);
    assert.equal(initCode, 0);
    const qaDir = path.join(repoDir, 'qa');

    // Governance approve MUST NEVER be exposed as an MCP tool!
    const mcpToolNames = getMcpToolDefinitions().map((t) => t.name);
    assert.equal(mcpToolNames.some((n) => n.includes('governance')), false);

    // Baseline static-only audit passes when governance.lock is untouched
    assert.equal(runAuditForQaDir(qaDir, { staticOnly: true }).ok, true);

    const tamperTargets = [
      ['playwright.config.ts', "\n// AGENT CHEAT: testIgnore: ['**/*.spec.ts']\n"],
      ['eslint.config.mjs', "\n// AGENT CHEAT: disable lint\n"],
      ['aitest.config.json', JSON.stringify({ maxFlaky: 99, assertFunctionNames: ['expect*'] }, null, 2)],
      [
        'waivers.json',
        JSON.stringify({
          waivers: [
            {
              titlePattern: 'checkout',
              owner: 'dev',
              approvedBy: 'lead',
              issue: 'ISSUE-1',
              reason: 'cheat',
              createdAt: new Date().toISOString(),
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
            },
          ],
        }),
      ],
      ['tests/fixtures/base.ts', '\n// tampered fixture\n'],
    ];

    for (const [relFile, mutation] of tamperTargets) {
      const full = path.join(qaDir, relFile);
      const original = fs.readFileSync(full, 'utf8');
      if (relFile.endsWith('.json')) {
        fs.writeFileSync(full, mutation, 'utf8');
      } else {
        fs.writeFileSync(full, original + mutation, 'utf8');
      }

      const auditAfterTamper = runAuditForQaDir(qaDir, { staticOnly: true });
      assert.equal(auditAfterTamper.ok, false, `Expected governance tamper failure when modifying ${relFile}`);
      assert.match(auditAfterTamper.errors.join('\n'), /Governance Tamper Blocked/);

      // Restore original file
      fs.writeFileSync(full, original, 'utf8');
    }

    // Deleting governance.lock itself is also caught via governance-audit.jsonl!
    const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
    const savedLock = fs.readFileSync(lockPath, 'utf8');
    fs.unlinkSync(lockPath);
    const missingLockAudit = runAuditForQaDir(qaDir, { staticOnly: true });
    assert.equal(missingLockAudit.ok, false);
    assert.match(missingLockAudit.errors.join('\n'), /Missing \.aitest\/governance\.lock/);

    // Stripping mac/macs from default-path governance.lock on T1-sticky host stays blocked (never downgrades to T0)
    const strippedLock = JSON.parse(savedLock);
    delete strippedLock.mac;
    delete strippedLock.macs;
    delete strippedLock.macKeyId;
    fs.writeFileSync(lockPath, `${JSON.stringify(strippedLock, null, 2)}\n`, 'utf8');
    const strippedMacAudit = runAuditForQaDir(qaDir, { staticOnly: true });
    assert.equal(strippedMacAudit.ok, false);
    assert.equal(strippedMacAudit.outcome, 'blocked');
    fs.writeFileSync(lockPath, savedLock, 'utf8');

    // MCP child context or bot approver cannot run `governance approve`
    process.env.AITEST_MCP_CHILD = '1';
    try {
      const mcpBlockedCode = await runCli([
        'governance',
        'approve',
        '--target',
        repoDir,
        '--by',
        'alice',
        '--reason',
        'try from mcp',
      ]);
      assert.equal(mcpBlockedCode, 2);
    } finally {
      delete process.env.AITEST_MCP_CHILD;
    }

    const botBlockedCode = await runCli([
      'governance',
      'approve',
      '--target',
      repoDir,
      '--by',
      'codex',
      '--reason',
      'agent self approve',
    ]);
    assert.equal(botBlockedCode, 2);

    // Legitimate human approval succeeds
    const cfgPath = path.join(qaDir, 'aitest.config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ assertFunctionNames: ['expect*'], maxFlaky: 0 }, null, 2) + '\n', 'utf8');
    const humanOkCode = await runCli([
      'governance',
      'approve',
      '--target',
      repoDir,
      '--by',
      'qa-director-zhang',
      '--reason',
      'Tighten assertFunctionNames to expect* only',
      '--yes',
    ]);
    assert.equal(humanOkCode, 0);
    assert.equal(runAuditForQaDir(qaDir, { staticOnly: true }).ok, true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Waiver validation blocks missing approvedBy, missing issue/traceId, agent approvers, and >14-day TTL', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-strict-waiver-'));
  const nowMs = Date.parse('2026-11-24T00:00:00Z');
  try {
    const wFile = path.join(tmpDir, 'waivers.json');
    fs.writeFileSync(
      wFile,
      JSON.stringify({
        waivers: [
          {
            titlePattern: 'checkout',
            owner: 'alice',
            approvedBy: 'healer',
            reason: 'self-waived',
            createdAt: '2026-11-24T00:00:00Z',
            expiresAt: '2026-12-25T00:00:00Z',
          },
        ],
      }),
      'utf8'
    );
    const bad = loadAndValidateWaivers(wFile, nowMs);
    assert.equal(bad.ok, false);
    assert.equal(bad.errors.length >= 3, true); // bot approvedBy + missing issue/traceId + >14d TTL

    fs.writeFileSync(
      wFile,
      JSON.stringify({
        waivers: [
          {
            titlePattern: 'checkout',
            owner: 'alice',
            approvedBy: 'bob-qa-lead',
            issue: 'JIRA-402',
            reason: 'Staging gateway cert rotation',
            createdAt: '2026-11-24T00:00:00Z',
            expiresAt: '2026-11-30T00:00:00Z',
          },
        ],
      }),
      'utf8'
    );
    const good = loadAndValidateWaivers(wFile, nowMs);
    assert.equal(good.ok, true);
    assert.equal(good.activeWaivers.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Run Ledger binds results.json to runId + worktreeHash and blocks stale green results after code edits', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-ledger-'));
  try {
    await runCli(['init', '--name', 'ledger-app', '--target', repoDir, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(repoDir, 'qa');
    fs.mkdirSync(path.join(repoDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'src', 'cart.ts'), 'export const price = 100;\n', 'utf8');

    const begin = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir });
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        config: { metadata: { runId: begin.runId } },
        suites: [
          {
            title: 'cart',
            file: 'tests/e2e/home.spec.ts',
            specs: [
              {
                title: 'cart total',
                line: 4,
                tests: [{ projectName: 'e2e', status: 'expected', results: [{ duration: 42 }] }],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, begin.runId, { exitCode: 0, resultsPath });

    // Audit immediately after run -> PASS (bound to runId!)
    const freshAudit = runAuditForQaDir(qaDir);
    assert.equal(freshAudit.ok, true);
    assert.equal(freshAudit.runId, begin.runId);

    // Edit host business code WITHOUT re-running tests -> Audit MUST reject stale results.json!
    fs.writeFileSync(path.join(repoDir, 'src', 'cart.ts'), 'export const price = -999; // broken!\n', 'utf8');
    const staleAudit = runAuditForQaDir(qaDir);
    assert.equal(staleAudit.ok, false);
    assert.match(staleAudit.errors.join('\n'), /Stale Results Blocked/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Flaky Quarantine auto-isolates high-flaky non-critical tests and auto-releases after 5 consecutive passes', () => {
  const qaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-flaky-'));
  try {
    const recordSyntheticRun = (status, retryPassed = false) => {
      const b = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir: qaDir });
      const rp = path.join(qaDir, 'reports', 'results.json');
      fs.mkdirSync(path.dirname(rp), { recursive: true });
      fs.writeFileSync(
        rp,
        JSON.stringify({
          suites: [
            {
              file: 'tests/e2e/banner.spec.ts',
              specs: [
                {
                  title: 'animated promo carousel',
                  line: 8,
                  tests: [
                    {
                      projectName: 'e2e',
                      status,
                      results: retryPassed ? [{ duration: 20 }, { duration: 25 }] : [{ duration: 20 }],
                    },
                  ],
                },
              ],
            },
          ],
        }),
        'utf8'
      );
      finalizeRunLedger(qaDir, b.runId, { exitCode: 0, resultsPath: rp });
    };

    recordSyntheticRun('flaky');
    recordSyntheticRun('expected', true);
    recordSyntheticRun('expected', false);

    const q1 = syncQuarantineFromLedger(qaDir);
    assert.equal(q1.activeCount, 1);
    assert.equal(q1.added.length, 1);

    // 4 more clean passes (total streak = 5) -> automatically released from quarantine!
    for (let i = 0; i < 4; i += 1) recordSyntheticRun('expected', false);
    const reportAfter = computeFlakyReport(qaDir);
    assert.equal(reportAfter.allTests[0].consecutivePasses, 5);
    const q2 = syncQuarantineFromLedger(qaDir);
    assert.equal(q2.activeCount, 0);
    assert.equal(q2.released.length, 1);
  } finally {
    fs.rmSync(qaDir, { recursive: true, force: true });
  }
});

test('Heal Session State Machine enforces 0% C-class mis-heal rate, Semantic Diff Guard, and 3-attempt hard cap', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-heal-sm-'));
  try {
    await runCli(['init', '--name', 'heal-sm', '--target', repoDir, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(repoDir, 'qa');
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });

    // 1. Class C failure (5xx backend error) -> attemptHealRepair MUST be hard-blocked!
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        suites: [
          {
            file: 'tests/e2e/home.spec.ts',
            specs: [
              {
                title: 'checkout order',
                file: 'tests/e2e/home.spec.ts',
                line: 5,
                tests: [
                  {
                    projectName: 'e2e',
                    status: 'unexpected',
                    results: [{ error: { message: '[Same-Origin 5xx Guard]\n500 POST /api/orders' } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );

    const beginC = beginHealSession(qaDir);
    assert.equal(beginC.ok, true);
    assert.equal(beginC.session.categoryCode, 'C');
    assert.equal(beginC.session.repairPermitted, false);

    const blockedC = await attemptHealRepair(qaDir, { sessionId: beginC.session.sessionId, skipRun: true });
    assert.equal(blockedC.ok, false);
    assert.equal(blockedC.misHealBlocked, true);

    const concludedC = concludeHealSession(qaDir, {
      sessionId: beginC.session.sessionId,
      outcome: 'reported',
      summary: 'Backend /api/orders returns HTTP 500',
    });
    assert.equal(concludedC.ok, true);
    assert.ok(concludedC.defectTicketPath && fs.existsSync(concludedC.defectTicketPath));

    // 2. Class A failure (locator drift) -> blocks cheating repair, caps at 3 attempts!
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        suites: [
          {
            file: 'tests/e2e/home.spec.ts',
            specs: [
              {
                title: 'landing heading',
                file: 'tests/e2e/home.spec.ts',
                line: 5,
                tests: [
                  {
                    projectName: 'e2e',
                    status: 'unexpected',
                    results: [
                      {
                        error: {
                          message: "TimeoutError: Timeout 15000ms exceeded.\nCall log:\n  - waiting for getByRole('button', { name: 'Old CTA' })",
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );

    const beginA = beginHealSession(qaDir);
    assert.equal(beginA.session.categoryCode, 'A');
    assert.equal(beginA.session.maxAttempts, 3);

    const specPath = path.join(qaDir, 'tests', 'e2e', 'home.spec.ts');
    const origSpec = fs.readFileSync(specPath, 'utf8');

    // Attempt #1: Cheating repair (expect(true).toBe(true)) -> rejected by Semantic Gate!
    fs.writeFileSync(specPath, origSpec + '\n  expect(true).toBe(true);\n', 'utf8');
    const att1 = await attemptHealRepair(qaDir, { sessionId: beginA.session.sessionId, skipRun: true });
    assert.equal(att1.ok, false);
    assert.equal(att1.gateBlocked, true);
    assert.equal(att1.attemptsUsed, 1);

    // Attempt #2 & #3 (failing run simulation)
    fs.writeFileSync(specPath, origSpec, 'utf8');
    const att2 = await attemptHealRepair(qaDir, { sessionId: beginA.session.sessionId, skipRun: true, assumeTestPassed: false });
    assert.equal(att2.attemptsUsed, 2);
    const att3 = await attemptHealRepair(qaDir, { sessionId: beginA.session.sessionId, skipRun: true, assumeTestPassed: false });
    assert.equal(att3.attemptsUsed, 3);
    assert.equal(att3.state, 'escalated');

    // Attempt #4 -> Hard-blocked (already escalated after 3 attempts!)
    const att4 = await attemptHealRepair(qaDir, { sessionId: beginA.session.sessionId, skipRun: true });
    assert.equal(att4.ok, false);
    assert.equal(att4.exitCode, 2);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Requirement Traceability Matrix & Strict CLI flag validation work cleanly', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-req-cli-'));
  try {
    await runCli([
      'init',
      '--name',
      'trace-demo',
      '--target',
      repoDir,
      '--preset',
      'demo-campus',
      '--skip-install',
      '--loop',
      'none',
    ]);
    const matrix = buildRequirementTraceMatrix(path.join(repoDir, 'qa'));
    assert.equal(matrix.totalRequirements, 3);
    assert.equal(matrix.coveredRequirements, 3);
    assert.equal(matrix.coveragePct, 100);

    // Strict CLI unknown flag rejection (`Q-05` / exit 64)
    const badFlagCode = await runCli(['run', '--sute', 'smoke']);
    assert.equal(badFlagCode, 64);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
