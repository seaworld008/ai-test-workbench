import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  beginHealSession,
  buildSeamGatekeeperCard,
  collectLessonsReport,
  compareChangesetAst,
  distillMemoryProposals,
  evaluateLockstepRules,
  generateDiagnosticsMarkdown,
  handleMcpJsonRpcMessage,
  loadKnownBlockers,
  loadVerifiedProjectGateRules,
  matchKnownBlocker,
  renderSeamGatekeeperMarkdown,
  runAuditForQaDir,
  runCli,
  runRetroactiveSweep,
  verifyGovernanceLockInQaDir,
} from '../../src/app/index.mjs';
import { buildPrVerdictMarkdown } from '../../src/verdict/reports.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function initGitRepo(repoDir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: repoDir, stdio: 'ignore' });
}

async function humanApprove(repoDir, reason) {
  const saved = {
    AITEST_APPROVE_NON_INTERACTIVE: process.env.AITEST_APPROVE_NON_INTERACTIVE,
    AITEST_MCP_CHILD: process.env.AITEST_MCP_CHILD,
    AITEST_MCP_SUBPROCESS: process.env.AITEST_MCP_SUBPROCESS,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_CI: process.env.CODEX_CI,
    CODEX_SANDBOX: process.env.CODEX_SANDBOX,
    CURSOR_TRACE_ID: process.env.CURSOR_TRACE_ID,
    AIDER_MODEL: process.env.AIDER_MODEL,
  };
  process.env.AITEST_APPROVE_NON_INTERACTIVE = '1';
  delete process.env.AITEST_MCP_CHILD;
  delete process.env.AITEST_MCP_SUBPROCESS;
  delete process.env.ANTIGRAVITY_CONVERSATION_ID;
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_CI;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CURSOR_TRACE_ID;
  delete process.env.AIDER_MODEL;
  try {
    const code = await runCli([
      'governance',
      'approve',
      '--target',
      repoDir,
      '--by',
      'alice@example.com',
      '--reason',
      reason,
      '--yes',
      '--json',
    ]);
    assert.equal(code, 0, `Human governance approve should succeed for "${reason}"`);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('v6.4.0 WU-D Known Blockers: qa/known-blockers.json is governance-locked, links shifted derivative fingerprints in diagnose, and hard-blocks duplicate beginHealSession', async () => {
  const tmpRepo = makeTempDir('aitest-v640-blockers-');
  try {
    await runCli(['init', '--name', 'blockers-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // 1. Adding qa/known-blockers.json without human approval is blocked by Layer 0 governance lock
    const blockersPath = path.join(qaDir, 'known-blockers.json');
    fs.writeFileSync(
      blockersPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          blockers: [
            {
              id: 'BLK-WEB-SEARCH',
              title: 'Dynamic tool description service not yet wired in Rust',
              status: 'open',
              categoryCode: 'C',
              routePattern: 'POST /api/v1/messages',
              checkpoint: 'CP2-Body-Shape-And-Value',
              fingerprintIds: ['fp_abcdef123456'],
              reason: 'Upstream tool-description RPC integration scheduled for next sprint',
              trackingIssue: 'ARCH-402',
              approvedBy: 'alice@example.com',
            },
            {
              id: 'BLK-RESOLVED',
              title: 'Already resolved blocker',
              status: 'resolved',
              categoryCode: 'C',
              routePattern: 'GET /api/old',
              reason: 'Fixed',
            },
          ],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    const unlockedGov = verifyGovernanceLockInQaDir(qaDir);
    assert.equal(unlockedGov.ok, false, 'Unapproved qa/known-blockers.json must fail Layer 0 governance lock');
    assert.equal(unlockedGov.status, 'blocked');

    await humanApprove(tmpRepo, 'seal qa/known-blockers.json');
    const sealedGov = verifyGovernanceLockInQaDir(qaDir);
    assert.equal(sealedGov.ok, true, sealedGov.errors.join('\n'));

    const loaded = loadKnownBlockers(qaDir);
    assert.equal(loaded.ok, true);
    assert.equal(loaded.blockers.length, 2);
    assert.equal(loaded.openBlockers.length, 1);

    // Exact fingerprint match AND routePattern derivative match (shifted byte offset)
    assert.equal(matchKnownBlocker({ fingerprintId: 'fp_abcdef123456' }, loaded.openBlockers)?.id, 'BLK-WEB-SEARCH');
    assert.equal(
      matchKnownBlocker(
        { fingerprintId: 'fp_shifted99999', routePattern: 'POST /api/v1/messages', checkpoint: 'CP2-Body-Shape-And-Value' },
        loaded.openBlockers
      )?.id,
      'BLK-WEB-SEARCH'
    );
    assert.equal(
      matchKnownBlocker(
        { fingerprintId: 'fp_other', routePattern: 'POST /api/v1/messages', checkpoint: 'CP1-Status-Headers' },
        loaded.openBlockers
      ),
      null
    );

    // 2. Diagnose automatically annotates failures & clusters matching open blocker, and beginHealSession blocks!
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        suites: [
          {
            file: 'tests/api/messages.spec.ts',
            specs: [
              {
                title: 'POST /api/v1/messages tool description parity',
                line: 14,
                tests: [
                  {
                    projectName: 'api',
                    status: 'unexpected',
                    results: [
                      {
                        status: 'failed',
                        duration: 35,
                        error: {
                          message:
                            'Error: expect(received).toBe(expected)\nPOST /api/v1/messages mismatch\nExpected: "live-desc"\nReceived: "missing"',
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

    const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
    assert.equal(diag.failures.length, 1);
    assert.equal(diag.failures[0].linkedKnownBlockerId, 'BLK-WEB-SEARCH');
    assert.match(diag.failures[0].knownBlockerReason || '', /tool-description RPC/);
    assert.equal(diag.clusters[0].linkedKnownBlockerId, 'BLK-WEB-SEARCH');
    assert.match(diag.markdown, /Known Blocker: BLK-WEB-SEARCH/);

    const healBlocked = beginHealSession(qaDir);
    assert.equal(healBlocked.ok, false);
    assert.equal(healBlocked.exitCode, 2);
    assert.equal(healBlocked.blockerLinked, true);
    assert.equal(healBlocked.linkedKnownBlockerId, 'BLK-WEB-SEARCH');
    assert.match(healBlocked.error || '', /BLK-WEB-SEARCH/);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('v6.4.0 WU-D Memory Loop Distiller, Sealed Declarative project-rules.json, Retroactive Sweep & aitest_report(view=lessons)', async () => {
  const tmpRepo = makeTempDir('aitest-v640-learn-');
  try {
    initGitRepo(tmpRepo);
    await runCli(['init', '--name', 'learn-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Seed multi-source memory signals: escalated heal, misHealBlocked heal, defect ticket, governance audit event, PR reviews (JSON & MD)
    const healsDir = path.join(qaDir, '.aitest', 'heals');
    fs.mkdirSync(healsDir, { recursive: true });
    fs.writeFileSync(
      path.join(healsDir, 'heal_esc1.json'),
      JSON.stringify({
        sessionId: 'heal_esc1',
        state: 'escalated',
        categoryCode: 'A',
        attemptsUsed: 3,
        testId: 'tests/e2e/nav.spec.ts::nav check',
        specFile: 'tests/e2e/nav.spec.ts',
        errorSnippet: 'TimeoutError waiting for locator strict mode violation',
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(healsDir, 'heal_c1.json'),
      JSON.stringify({
        sessionId: 'heal_c1',
        state: 'concluded',
        categoryCode: 'C',
        testId: 'tests/api/orders.spec.ts::dup order',
        specFile: 'tests/api/orders.spec.ts',
        attempts: [{ blockedReason: 'Category C does not permit test modification' }],
        errorSnippet: 'Class C status 500 regression',
      }),
      'utf8'
    );
    const defectsDir = path.join(qaDir, 'reports', 'defects');
    fs.mkdirSync(defectsDir, { recursive: true });
    fs.writeFileSync(
      path.join(defectsDir, 'DEF-001.md'),
      '# DEF-001: Duplicate Order Returns 201 Instead of 409\n- **Spec File**: `tests/api/orders.spec.ts`\n',
      'utf8'
    );
    fs.appendFileSync(
      path.join(qaDir, '.aitest', 'governance-audit.jsonl'),
      `${JSON.stringify({ action: 'tamper-blocked', ok: false, reason: 'Unapproved edit to waivers.json' })}\n`,
      'utf8'
    );

    const reviewsJsonPath = path.join(tmpRepo, 'pr-reviews.json');
    fs.writeFileSync(
      reviewsJsonPath,
      JSON.stringify([
        { author: 'staff-eng', path: 'src/search.ts', body: 'Reject throwaway static copy fallback; call the real search service.' },
        { author: 'staff-eng', path: 'src/parser.ts', body: 'Do not guess Python behavior without checking source code.' },
        { author: 'qa-lead', path: 'src/api.ts', body: 'Another guessed conversion found here — check source!' },
      ]),
      'utf8'
    );

    const reviewsMdPath = path.join(tmpRepo, 'pr-reviews.md');
    fs.writeFileSync(
      reviewsMdPath,
      '- Reject static copy-paste fallback payloads.\n- Keep paired directories synchronized in lockstep.\n',
      'utf8'
    );

    // 1. Run `aitw learn` (distill) — writes ONLY staging proposals, NEVER modifies governance lock!
    const lockBefore = fs.readFileSync(path.join(qaDir, '.aitest', 'governance.lock'), 'utf8');
    const learnExit = await runCli(['learn', '--target', tmpRepo, '--from-reviews', reviewsJsonPath, '--json']);
    assert.equal(learnExit, 0);
    assert.equal(fs.readFileSync(path.join(qaDir, '.aitest', 'governance.lock'), 'utf8'), lockBefore);

    const proposal = distillMemoryProposals(qaDir, { fromReviews: reviewsMdPath, dryRun: true });
    assert.equal(proposal.proposalOnly, true);
    assert.ok(proposal.clusters.length >= 3);
    assert.ok(proposal.managedAgentsMarkdownBlock.includes('<!-- BEGIN:AITEST_PROJECT_MEMORY -->'));
    assert.ok(proposal.candidateRuleSpecs.length >= 2);
    assert.ok(proposal.regressionSpecSkeletons.some((s) => s.defectId === 'DEF-001' && s.testTitle.includes('@regression')));
    assert.equal(fs.existsSync(path.join(qaDir, 'reports', 'learn-proposals.json')), true);
    assert.equal(fs.existsSync(path.join(qaDir, 'reports', 'learn-proposals.md')), true);

    // 2. Read-only `aitest_report(view="lessons")` via CLI and MCP in-process fast path
    const lessonsData = collectLessonsReport(qaDir);
    assert.equal(lessonsData.view, 'lessons');
    assert.ok(lessonsData.clusters.length >= 3);
    const mcpLessons = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 201,
        method: 'tools/call',
        params: { name: 'aitest_report', arguments: { target: tmpRepo, view: 'lessons' } },
      },
      { workspaceRoots: [tmpRepo] }
    );
    assert.equal(mcpLessons.result.isError, false);
    assert.equal(mcpLessons.result.structuredContent.data.view, 'lessons');
    assert.equal(await runCli(['report', '--target', tmpRepo, '--view', 'lessons', '--json']), 0);

    // 3. Declarative `qa/support/project-rules.json`: unapproved -> blocked (exitCode 2); approved -> enforced in audit & sweep!
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'clean.ts'), 'export const ok = true;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'legacy-a.ts'), '// TODO: guess fallback\nexport const a = "STATIC_FALLBACK_COPY";\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'legacy-b.ts'), 'export const b = "STATIC_FALLBACK_COPY";\n', 'utf8');

    const projRulesPath = path.join(qaDir, 'support', 'project-rules.json');
    fs.writeFileSync(
      projRulesPath,
      JSON.stringify(
        {
          schemaVersion: 1,
          rules: [
            {
              id: 'PROJ-R001',
              code: 'PROJ-R001',
              title: 'No static fallback copy',
              pattern: 'STATIC_FALLBACK_COPY',
              flags: 'i',
              scope: 'product',
              remediation: 'Query real upstream service.',
            },
          ],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );

    // Unsealed project-rules.json MUST fail-closed (never loaded!)
    const unsealedLoad = loadVerifiedProjectGateRules(qaDir);
    assert.equal(unsealedLoad.ok, false);
    assert.equal(unsealedLoad.blocked, true);
    const unsealedSweep = runRetroactiveSweep(qaDir, { repoDir: tmpRepo });
    assert.equal(unsealedSweep.ok, false);
    assert.equal(unsealedSweep.exitCode, 2);

    // Seal via human CLI `governance approve` + commit baseline
    await humanApprove(tmpRepo, 'seal declarative project-rules.json');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline with sealed project rules'], { cwd: tmpRepo, stdio: 'ignore' });

    // Retroactive sweep (`aitw learn --sweep`) finds BOTH latent occurrences across repo!
    const sweepExit = await runCli(['learn', '--target', tmpRepo, '--sweep', '--json']);
    assert.equal(sweepExit, 0);
    const sweepRes = runRetroactiveSweep(qaDir, { repoDir: tmpRepo, dryRun: true });
    assert.equal(sweepRes.ok, true);
    assert.equal(sweepRes.activeRuleCount, 1);
    assert.equal(sweepRes.findingCount, 2);
    assert.deepEqual(
      sweepRes.sweepFindings.map((f) => f.file).sort(),
      ['src/legacy-a.ts', 'src/legacy-b.ts']
    );

    // New product file introducing STATIC_FALLBACK_COPY is immediately caught by Layer 3 audit via sealed project-rules.json!
    fs.writeFileSync(path.join(tmpRepo, 'src', 'new-shortcut.ts'), 'export const bad = "STATIC_FALLBACK_COPY";\n', 'utf8');
    const auditHit = runAuditForQaDir(qaDir, {
      staticOnly: true,
      checkSpecs: false,
      diffBase: 'HEAD',
      requireDiff: true,
    });
    assert.equal(auditHit.ok, false);
    assert.equal(auditHit.gates.semanticDiff, 'fail');
    assert.ok(auditHit.errors.some((e) => e.includes('PROJ-R001')));
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('v6.4.0 WU-E AITEST-G118 Lockstep Gate: zero-overhead when unconfigured, blocks unpaired dir edits, passes paired edits, and honors allowWaiver', async () => {
  // 1. Zero-overhead direct evaluation when unconfigured
  assert.deepEqual(evaluateLockstepRules({ lockstepRules: [], repoChangedFiles: ['services/py/a.py'] }), []);

  // 2. Direct changeset evaluation via ruleG118
  const lockstepRules = [
    {
      id: 'py-to-rs-messages',
      whenModified: ['services/messages-py/**'],
      requireModified: ['services/messages-rs/**'],
      allowWaiver: true,
    },
  ];
  const directFail = compareChangesetAst(
    [{ filePath: 'tests/a.spec.ts', baseSource: "test('a', async ({ page }) => { await expect(page).toHaveURL('/a'); });", headSource: "test('a', async ({ page }) => { await expect(page).toHaveURL('/a'); });" }],
    { lockstepRules, repoChangedFiles: ['services/messages-py/handler.py'] }
  );
  assert.equal(directFail.ok, false);
  assert.ok(directFail.findings.some((f) => f.code === 'AITEST-G118'));

  // 3. Real Git repo end-to-end audit (even when ZERO files inside qa/ changed!)
  const tmpRepo = makeTempDir('aitest-v640-g118-');
  try {
    initGitRepo(tmpRepo);
    await runCli(['init', '--name', 'lockstep-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    fs.mkdirSync(path.join(tmpRepo, 'services', 'messages-py'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'services', 'messages-rs'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'services', 'messages-py', 'api.py'), 'def handle(): return 200\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'services', 'messages-rs', 'api.rs'), 'pub fn handle() -> u16 { 200 }\n', 'utf8');

    const cfgPath = path.join(qaDir, 'aitest.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.lockstepRules = lockstepRules;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    await humanApprove(tmpRepo, 'enable py-to-rs lockstep rule');

    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline lockstep'], { cwd: tmpRepo, stdio: 'ignore' });

    // Edit ONLY Python side -> AITEST-G118 blocks!
    fs.writeFileSync(path.join(tmpRepo, 'services', 'messages-py', 'api.py'), 'def handle(): return 201\n', 'utf8');
    const unpairedAudit = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: false, diffBase: 'HEAD', requireDiff: true });
    assert.equal(unpairedAudit.ok, false);
    assert.ok(unpairedAudit.errors.some((e) => e.includes('AITEST-G118') && e.includes('py-to-rs-messages')));

    // Edit paired Rust side -> passes!
    fs.writeFileSync(path.join(tmpRepo, 'services', 'messages-rs', 'api.rs'), 'pub fn handle() -> u16 { 201 }\n', 'utf8');
    const pairedAudit = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: false, diffBase: 'HEAD', requireDiff: true });
    assert.equal(pairedAudit.ok, true, pairedAudit.errors.join('\n'));

    // Revert Rust side and verify explicit diff waiver bypasses when allowWaiver=true
    fs.writeFileSync(path.join(tmpRepo, 'services', 'messages-rs', 'api.rs'), 'pub fn handle() -> u16 { 200 }\n', 'utf8');
    const futureExp = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    const waived = evaluateLockstepRules({
      lockstepRules,
      repoChangedFiles: ['services/messages-py/api.py'],
      activeWaivers: [{ scope: 'diff', titlePattern: 'py-to-rs-messages', owner: 'alice', approvedBy: 'bob', reason: 'staged', expiresAt: futureExp }],
    });
    assert.deepEqual(waived, []);

    // When allowWaiver=false, waiver is ignored and AITEST-G118 still fires!
    const nonWaivable = evaluateLockstepRules({
      lockstepRules: [{ ...lockstepRules[0], allowWaiver: false }],
      repoChangedFiles: ['services/messages-py/api.py'],
      activeWaivers: [{ scope: 'diff', titlePattern: 'py-to-rs-messages', owner: 'alice', approvedBy: 'bob', reason: 'staged', expiresAt: futureExp }],
    });
    assert.equal(nonWaivable.length, 1);
    assert.equal(nonWaivable[0].code, 'AITEST-G118');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('v6.4.0 WU-F Human Seam Gatekeeper Card: surfaces S5->S5 literal shifts, >=300-char static shortcuts, <=3d expiring waivers, known blockers & parity cohorts', async () => {
  const tmpRepo = makeTempDir('aitest-v640-seam-');
  try {
    initGitRepo(tmpRepo);
    await runCli(['init', '--name', 'seam-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Baseline spec with S5 exact literal assertions + baseline product files + expiring waiver (2 days left)
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'api', 'orders.spec.ts'),
      `import { test, expect } from '../fixtures/base';
test('duplicate order and remaining seats', async ({ request }) => {
  const res = await request.post('/api/orders');
  expect(res.status()).toBe(409);
  const body = await res.json();
  expect(body.quota).toBe('0/50');
});
`,
      'utf8'
    );
    fs.mkdirSync(path.join(tmpRepo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'real-service.ts'), 'export async function load() { return fetch("/api/live"); }\n', 'utf8');

    const exp2d = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(
      path.join(qaDir, 'waivers.json'),
      JSON.stringify(
        {
          waivers: [
            {
              filePattern: 'tests/e2e/legacy.spec.ts',
              owner: 'alice',
              approvedBy: 'bob',
              issue: 'ISSUE-99',
              reason: 'Temporary migration waiver',
              createdAt: new Date().toISOString(),
              expiresAt: exp2d,
            },
          ],
        },
        null,
        2
      ) + '\n',
      'utf8'
    );
    await humanApprove(tmpRepo, 'seal seam baseline with expiring waiver');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'seam baseline'], { cwd: tmpRepo, stdio: 'ignore' });

    // 1. Flip S5 -> S5 literals (409 -> 201 and '0/50' -> '1/50')
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'api', 'orders.spec.ts'),
      `import { test, expect } from '../fixtures/base';
test('duplicate order and remaining seats', async ({ request }) => {
  const res = await request.post('/api/orders');
  expect(res.status()).toBe(201);
  const body = await res.json();
  expect(body.quota).toBe('1/50');
});
`,
      'utf8'
    );

    // 2. Add a >= 300-char static-copy shortcut file with NO network/DB calls, AND a control file WITH fetch()
    const bigBlob = JSON.stringify({
      tool: 'web_search',
      description: 'X'.repeat(340),
    });
    fs.writeFileSync(
      path.join(tmpRepo, 'src', 'static-shortcut.ts'),
      `export const COPIED_TOOL_SPEC = ${JSON.stringify(bigBlob)};\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpRepo, 'src', 'real-service.ts'),
      `export const DOC = ${JSON.stringify('Y'.repeat(340))};\nexport async function load() { return fetch("/api/live"); }\n`,
      'utf8'
    );

    const verdictMock = {
      verdict: 'fail',
      trustTier: 'T1',
      trustLevel: 'T1',
      runId: 'RUN_SEAM_1',
      gitSha: 'abc1234',
      base: { resolved: 'HEAD', strategy: 'explicit' },
      acceptanceScope: 'business-e2e',
      scope: { requested: 'parity', actual: 'impact', downgraded: false },
      counts: { executed: 1, passed: 0, failed: 1, flaky: 0 },
      gates: { governance: 'pass', static: 'pass', runtime: 'fail', semanticDiff: 'pass', parity: 'fail' },
      gateErrors: [],
      failures: [
        {
          testId: 'tests/api/orders.spec.ts::duplicate order',
          title: 'duplicate order',
          file: 'tests/api/orders.spec.ts',
          line: 4,
          categoryCode: 'C',
          confidence: 'high',
          traceId: null,
          linkedKnownBlockerId: 'BLK-WEB-SEARCH',
          knownBlockerReason: 'Awaiting upstream RPC',
        },
      ],
      paritySummary: {
        parityPct: 50,
        totalSamples: 2,
        matchedSamples: 1,
        mismatchedSamples: 1,
        clusterCount: 1,
        cohortStats: { orders: { total: 2, matched: 1, mismatched: 1, parityPct: 50 } },
      },
      traceability: { coveredRequirements: 1, totalRequirements: 1, coveragePct: 100 },
      ai: { llmCalls: 0 },
    };

    const seam = buildSeamGatekeeperCard({
      qaDir,
      repoDir: tmpRepo,
      baseResolution: { isGitRepo: true, gitRoot: tmpRepo, resolved: 'HEAD' },
      verdictPayload: verdictMock,
    });

    assert.equal(seam.hasAttentionItems, true);
    assert.equal(seam.s5LiteralShifts.length, 2);
    assert.ok(seam.s5LiteralShifts.some((s) => s.baseExpected === '409' && s.headExpected === '201'));
    assert.ok(seam.s5LiteralShifts.some((s) => s.baseExpected === "'0/50'" && s.headExpected === "'1/50'"));

    assert.equal(seam.suspectedShortcuts.length, 1, 'Must flag static-shortcut.ts and ignore real-service.ts with fetch()');
    assert.equal(seam.suspectedShortcuts[0].file, 'src/static-shortcut.ts');
    assert.ok(seam.suspectedShortcuts[0].charLength >= 300);

    assert.equal(seam.expiringWaivers.length, 1);
    assert.equal(seam.expiringWaivers[0].owner, 'alice');
    assert.equal(seam.linkedKnownBlockers.length, 1);
    assert.equal(seam.linkedKnownBlockers[0].blockerId, 'BLK-WEB-SEARCH');
    assert.equal(seam.parityCohortSummary?.parityPct, 50);

    const zhMd = buildPrVerdictMarkdown({ ...verdictMock, seamReview: seam }, 'zh');
    assert.match(zhMd, /### 内外环交界人工必审焦点 \(Human Seam Gatekeeper Card\)/);
    assert.match(zhMd, /409.*201/);
    assert.match(zhMd, /src\/static-shortcut\.ts/);
    assert.match(zhMd, /BLK-WEB-SEARCH/);
    assert.match(zhMd, /Differential Parity Cohort Summary/);

    const enLines = renderSeamGatekeeperMarkdown(seam, 'en').join('\n');
    assert.match(enLines, /Human Seam Gatekeeper Card/);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
