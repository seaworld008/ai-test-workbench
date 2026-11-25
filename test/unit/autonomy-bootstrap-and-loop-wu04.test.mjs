import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  attemptHealRepair,
  autoCloseStaleClassBSessions,
  beginHealSession,
  beginRunLedger,
  bootstrapWorkspaceCore,
  checkHealSessionConflicts,
  compareChangesetAst,
  computeImpact,
  concludeHealSession,
  discardHealSession,
  finalizeRunLedger,
  inferRuntimeConfigForRepo,
  openTrustContext,
  runAuditForQaDir,
  runInit,
  runMapCommand,
  verifyChangeCore,
  verifyGovernanceLockInQaDir,
} from '../../src/app/index.mjs';
import { validateRuntimeConfig } from '../../src/core/runtime-config.mjs';
import { correlateFailureWithFrontendDiff } from '../../src/diagnose/diff-correlator.mjs';
import { resolveExplicitFileTargets } from '../../src/runner.mjs';
import { writeInferredApiSchemas } from '../../src/explore/schema-inferrer.mjs';
import { resolveDefaultMutationPolicy } from '../../src/kernel/target-guard.mjs';
import { scanSpecFilesFallback } from '../../src/kernel/gate-kernel.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function initGitRepoWithQa(prefix) {
  const dir = makeTempDir(prefix);
  const keyFile = path.join(dir, '.t1-key.hex');
  fs.writeFileSync(keyFile, 'a'.repeat(64), 'utf8');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'dev@example.com']);
    git(dir, ['config', 'user.name', 'Dev User']);
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'sample-app', scripts: { dev: 'node server.mjs' } }), 'utf8');
    fs.writeFileSync(path.join(dir, 'src', 'Button.tsx'), 'export function Button() { return "<button>Submit</button>"; }\n', 'utf8');
    const code = await runInit({ target: dir, name: 'sample-app', skipInstall: true, skipBrowser: true, loop: 'none', json: true });
    assert.equal(code, 0);
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'chore: initial baseline']);
    return { dir, qaDir: path.join(dir, 'qa'), keyFile };
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
  }
}

test('WU-04 (a): adaptation files are unlocked while referee kernel stays locked and setup direct @playwright/test import is blocked', async () => {
  const { dir, qaDir, keyFile } = await initGitRepoWithQa('aitest-wu04-adapt-');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    // Allowed adaptation writes: perf-budget, auth setup, custom fixture helper, runtime config
    fs.writeFileSync(path.join(qaDir, 'perf-budget.json'), JSON.stringify({ schemaVersion: 1, routes: ['/'] }, null, 2), 'utf8');
    fs.mkdirSync(path.join(qaDir, 'tests', 'setup'), { recursive: true });
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'setup', 'auth.setup.ts'),
      `import { test as setup, expect } from '../fixtures/base';\nsetup('auth @setup', async ({ page }) => { expect(page).toBeDefined(); });\n`,
      'utf8'
    );
    fs.mkdirSync(path.join(qaDir, 'tests', 'fixtures', 'custom'), { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'tests', 'fixtures', 'custom', 'helpers.ts'), 'export const helper = 1;\n', 'utf8');
    fs.writeFileSync(path.join(qaDir, 'aitest.runtime.json'), JSON.stringify({ schemaVersion: 1, baseURL: 'http://127.0.0.1:3000' }), 'utf8');

    const lockRes = verifyGovernanceLockInQaDir(qaDir);
    assert.equal(lockRes.ok, true, `Expected adaptation edits to pass governance lock, got: ${lockRes.errors.join('; ')}`);

    // Direct @playwright/test import in setup file is blocked statically
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'setup', 'bad.setup.ts'),
      `import { test as setup } from '@playwright/test';\nsetup('bad', async () => {});\n`,
      'utf8'
    );
    const staticBad = scanSpecFilesFallback(path.join(qaDir, 'tests'), { qaDir });
    assert.equal(staticBad.ok, false);
    assert.match(staticBad.errors.join('\n'), /fixtures\/base/);

    // Mutating locked base.ts must still fail governance lock
    fs.appendFileSync(path.join(qaDir, 'tests', 'fixtures', 'base.ts'), '\n// bypass\n', 'utf8');
    const lockTamper = verifyGovernanceLockInQaDir(qaDir);
    assert.equal(lockTamper.ok, false);
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WU-04 (b): codemap writes knowledge/impact-map.auto.json and impact unions auto-map + REQ-* + CSS fallback', async () => {
  const { dir, qaDir, keyFile } = await initGitRepoWithQa('aitest-wu04-impact-');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    fs.mkdirSync(path.join(dir, 'src', 'pages'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'pages', 'orders.tsx'), 'export default function Orders() { return "orders"; }\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'src', 'styles', 'theme.css'), 'body { color: #111; }\n', 'utf8');
    fs.mkdirSync(path.join(qaDir, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'specs', 'REQ-ORD-01.md'), '# REQ-ORD-01 Orders\nCovers /orders route.\n', 'utf8');
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'orders.spec.ts'),
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-ORD-01] orders @e2e', async ({ page }) => { await page.goto('/orders'); await expect(page).toHaveURL(/orders/); });\n`,
      'utf8'
    );

    const mapExit = await runMapCommand({ target: dir, json: true });
    assert.equal(mapExit, 0);
    const autoMapPath = path.join(qaDir, 'knowledge', 'impact-map.auto.json');
    assert.equal(fs.existsSync(autoMapPath), true);

    const impRoute = await computeImpact(qaDir, { files: ['src/pages/orders.tsx'] });
    assert.ok(impRoute.specs.some((s) => s.endsWith('orders.spec.ts')), `Expected orders.spec.ts in ${JSON.stringify(impRoute)}`);

    const impCss = await computeImpact(qaDir, { files: ['src/styles/theme.css'] });
    assert.ok(['full', 'e2e'].includes(impCss.mode) || impCss.specs.length > 0);
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WU-04 (c)(d): runtime-config validation rejects non-loopback/metacharacters & loopback CRUD defaults', async () => {
  assert.equal(validateRuntimeConfig({ schemaVersion: 1, baseURL: 'https://staging.example.com' }).ok, false);
  assert.equal(
    validateRuntimeConfig({ schemaVersion: 1, webServer: { command: 'npm run dev && rm -rf /', url: 'http://127.0.0.1:3000' } }).ok,
    false
  );
  assert.equal(
    validateRuntimeConfig({ schemaVersion: 1, webServer: { command: 'npm run dev', url: 'http://127.0.0.1:5173' } }).ok,
    true
  );

  // Mutation policy: local loopback defaults allowMutation=true, remote stays strictReadonly=true
  const localLoop = resolveDefaultMutationPolicy('local', 'http://127.0.0.1:5173', undefined);
  assert.equal(localLoop.allowMutation, true);
  assert.equal(localLoop.strictReadonly, false);
  const remoteStage = resolveDefaultMutationPolicy('staging', 'https://staging.example.com', undefined);
  assert.equal(remoteStage.allowMutation, false);
  assert.equal(remoteStage.strictReadonly, true);

  // inferRuntimeConfigForRepo + bootstrapWorkspaceCore
  const dir = makeTempDir('aitest-wu04-boot-');
  const keyFile = path.join(dir, '.t1-key.hex');
  fs.writeFileSync(keyFile, 'b'.repeat(64), 'utf8');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'vite-app', devDependencies: { vite: '5.0.0' }, scripts: { dev: 'vite' } }), 'utf8');
    const inferred = inferRuntimeConfigForRepo(dir);
    assert.equal(inferred.baseURL, 'http://127.0.0.1:5173');
    const bootRes = await bootstrapWorkspaceCore({ target: dir, skipInstall: true, skipBrowser: true });
    assert.equal(fs.existsSync(path.join(dir, 'qa', 'aitest.runtime.json')), true);
    assert.equal(bootRes.ok, true);
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WU-04 (e): verifyChangeCore refuses silent offline smoke downgrade unless allowOfflineSmoke=true', async () => {
  const { dir, qaDir, keyFile } = await initGitRepoWithQa('aitest-wu04-verdict-');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    const res = await verifyChangeCore({ target: qaDir, mode: 'impact', lang: 'en' });
    assert.equal(res.verdict, 'blocked');
    assert.equal(res.blockerKind, 'server-unreachable');
    assert.equal(res.recoverable, true);
    assert.equal(res.exitCode, 2);
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WU-04 (f): baseline-ref exempts branch-new spec/test iteration from G102/G103/G115 while blocking S0/skip/G101/<S2', async () => {
  const { dir, qaDir, keyFile } = await initGitRepoWithQa('aitest-wu04-base-');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    const baseSha = git(dir, ['rev-parse', 'HEAD']);
    git(dir, ['checkout', '-b', 'feat/new-spec']);

    // Commit 1 on branch: brand-new spec with 2 assertions (S5) + @critical tag
    const newSpecRel = 'tests/e2e/checkout-draft.spec.ts';
    const newSpecAbs = path.join(qaDir, newSpecRel);
    fs.writeFileSync(
      newSpecAbs,
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-CHK-1] draft checkout @critical', async ({ page }) => {\n  await expect(page.getByRole('button', { name: 'Pay' })).toHaveText('Pay');\n  await expect(page).toHaveURL(/checkout/);\n});\n`,
      'utf8'
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'wip: add checkout draft']);

    // Commit 2 on branch: refactor branch-new spec to 1 S3 assertion and remove @critical
    fs.writeFileSync(
      newSpecAbs,
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-CHK-1] draft checkout', async ({ page }) => {\n  await expect(page.getByRole('button', { name: 'Pay' })).toContainText('Pay');\n});\n`,
      'utf8'
    );
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'refactor: simplify draft check']);

    // diffBase = HEAD~1 sees count/tag reduction, but against .aitest/baseline-ref it's branch-new >= S2 -> ALLOWED
    const auditPass = runAuditForQaDir(qaDir, {
      staticOnly: true,
      checkSpecs: false,
      diffBase: 'HEAD~1',
      baselineRef: baseSha,
      requireDiff: true,
    });
    assert.equal(auditPass.ok, true, `Expected branch-new draft refactor to pass, got: ${auditPass.errors.join('; ')}`);

    // Reducing branch-new spec to S0 or < S2 is STILL BLOCKED!
    const badCompare = compareChangesetAst(
      [
        {
          filePath: newSpecRel,
          isBaselineNewSpec: true,
          baseSource: `import { test, expect } from '../fixtures/base';\ntest('draft @critical', async ({ page }) => { await expect(page).toHaveURL(/x/); });`,
          headSource: `import { test, expect } from '../fixtures/base';\ntest('draft', async ({ page }) => { expect(true).toBe(true); });`,
        },
      ],
      { qaDir }
    );
    assert.equal(badCompare.ok, false);
    assert.match(badCompare.violations.join('\n'), /AITEST-G104/);

    const belowS2 = compareChangesetAst(
      [
        {
          filePath: newSpecRel,
          isBaselineNewSpec: true,
          baseSource: `import { test, expect } from '../fixtures/base';\ntest('draft', async ({ page }) => { await expect(page).toHaveURL(/x/); });`,
          headSource: `import { test, expect } from '../fixtures/base';\ntest('draft', async ({ page }) => { expect(page).toBeDefined(); });`,
        },
      ],
      { qaDir }
    );
    assert.equal(belowS2.ok, false);
    assert.match(belowS2.violations.join('\n'), /AITEST-G103/);
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('WU-04 (g)(h)(i): A-UI-Sync diff correlator, heal unbound/--discard/quota-reset/conflicts, explore schema & runner args', async () => {
  const { dir, qaDir, keyFile } = await initGitRepoWithQa('aitest-wu04-heal-');
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    // (g) A-UI-Sync correlation
    fs.writeFileSync(path.join(dir, 'src', 'Button.tsx'), 'export function Button() { return "<button>Checkout Now</button>"; }\n', 'utf8');
    const corr = correlateFailureWithFrontendDiff(
      dir,
      { categoryCode: 'A', candidates: ['C', 'A'] },
      `Error: Timed out waiting for getByRole('button', { name: 'Submit' })`
    );
    assert.equal(corr.matched, true);
    assert.equal(corr.subCategory, 'A-UI-Sync');
    assert.ok(corr.matchedTokens?.includes('Submit'));

    // (h) Unbound forged results rejected by beginHealSession
    const forgedResultsPath = path.join(qaDir, 'reports', 'forged.json');
    fs.mkdirSync(path.dirname(forgedResultsPath), { recursive: true });
    fs.writeFileSync(
      forgedResultsPath,
      JSON.stringify({ suites: [{ file: 'tests/e2e/home.spec.ts', specs: [{ title: 'home', line: 3, tests: [{ status: 'unexpected', results: [{ status: 'failed', error: { message: 'Locator getByRole("Submit") timed out' } }] }] }] }] }),
      'utf8'
    );
    const unboundHeal = beginHealSession(qaDir, { resultsPath: forgedResultsPath });
    assert.equal(unboundHeal.ok, false);
    assert.equal(unboundHeal.exitCode, 2);

    // Legit ledger-bound run + begin + discard (clears activeSessionIds, keeps quota) + quota reset on app change
    const run = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir: dir });
    const realResultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.writeFileSync(
      realResultsPath,
      JSON.stringify({
        config: { metadata: { runId: run.runId } },
        suites: [
          {
            file: 'e2e/home.spec.ts',
            specs: [
              {
                title: 'home locator drift',
                line: 4,
                tests: [
                  {
                    status: 'unexpected',
                    results: [{ status: 'failed', error: { message: "waiting for getByText('Submit') failed" } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, run.runId, { exitCode: 1, resultsPath: realResultsPath });

    const began1 = beginHealSession(qaDir);
    assert.equal(began1.ok, true);
    const sid = began1.session.sessionId;
    const ledgerBeforeDiscard = JSON.parse(fs.readFileSync(path.join(qaDir, '.aitest', 'heals', 'ledger.json'), 'utf8'));
    assert.ok(ledgerBeforeDiscard.activeSessionIds.includes(sid));

    // Exhaust 1 attempt then discard -> activeSessionIds cleared cleanly while attemptsUsed preserved
    const att1 = await attemptHealRepair(qaDir, { sessionId: sid, skipRun: true });
    assert.equal(att1.attemptsUsed, 1);
    const disc = discardHealSession(qaDir, { sessionId: sid, summary: 'Switching approach' });
    assert.equal(disc.ok, true);
    const ledgerAfterDiscard = JSON.parse(fs.readFileSync(path.join(qaDir, '.aitest', 'heals', 'ledger.json'), 'utf8'));
    assert.equal(ledgerAfterDiscard.activeSessionIds.includes(sid), false);

    // Open Class C session + git mv of its spec is detected by checkHealSessionConflicts, until discarded
    const cRun = beginRunLedger(qaDir, { suite: 'api', command: 'playwright test', repoDir: dir });
    fs.writeFileSync(
      realResultsPath,
      JSON.stringify({
        config: { metadata: { runId: cRun.runId } },
        suites: [
          {
            file: 'api/health.spec.ts',
            specs: [
              {
                title: 'health check 500',
                line: 4,
                tests: [
                  {
                    status: 'unexpected',
                    results: [{ status: 'failed', error: { message: 'Expected: 200\nReceived: 500 Internal Server Error' } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, cRun.runId, { exitCode: 1, resultsPath: realResultsPath });
    const cBegin = beginHealSession(qaDir, { testId: 'api/health.spec.ts' });
    assert.equal(cBegin.ok, true);
    assert.equal(cBegin.session.categoryCode, 'C');
    git(dir, ['mv', 'qa/tests/api/health.spec.ts', 'qa/tests/api/health-renamed.spec.ts']);
    const mvConflict = checkHealSessionConflicts(qaDir, { isGitRepo: true, gitRoot: dir, resolved: 'HEAD' });
    assert.equal(mvConflict.ok, false);
    assert.match(mvConflict.errors.join('\n'), /modified while non-repairable Class-C/i);
    discardHealSession(qaDir, { sessionId: cBegin.session.sessionId, summary: 'Discard Class C after test rename revert' });
    assert.equal(checkHealSessionConflicts(qaDir, { isGitRepo: true, gitRoot: dir, resolved: 'HEAD' }).ok, true);

    // New session on same app code sees attemptsUsed=1
    const aRun = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir: dir });
    fs.writeFileSync(
      realResultsPath,
      JSON.stringify({
        config: { metadata: { runId: aRun.runId } },
        suites: [
          {
            file: 'e2e/home.spec.ts',
            specs: [
              {
                title: 'home locator drift',
                line: 4,
                tests: [
                  {
                    status: 'unexpected',
                    results: [{ status: 'failed', error: { message: "waiting for getByText('Submit') failed" } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, aRun.runId, { exitCode: 1, resultsPath: realResultsPath });
    const began2 = beginHealSession(qaDir, { testId: 'e2e/home.spec.ts' });
    assert.equal(began2.ok, true);
    assert.equal(began2.session.attemptsUsed, 1);
    discardHealSession(qaDir, { sessionId: began2.session.sessionId });

    // Edit non-qa product code -> quota resets to 0
    fs.writeFileSync(path.join(dir, 'src', 'Button.tsx'), 'export function Button() { return "<button>Buy Now</button>"; }\n', 'utf8');
    const began3 = beginHealSession(qaDir, { testId: 'e2e/home.spec.ts' });
    assert.equal(began3.ok, true);
    assert.equal(began3.session.attemptsUsed, 0);

    // Deleting active session JSON file triggers fail-closed activeSessionIds tamper error
    fs.unlinkSync(path.join(qaDir, '.aitest', 'heals', `${began3.session.sessionId}.json`));
    const deletedActiveConflict = checkHealSessionConflicts(qaDir, null);
    assert.equal(deletedActiveConflict.ok, false);
    assert.match(deletedActiveConflict.errors.join('\n'), /missing from \.aitest\/heals/i);

    // (i) explore schema inferrer + runner files/line args
    const schemaOut = writeInferredApiSchemas(qaDir, [
      { method: 'GET', pathname: '/api/orders', status: 200, sample: { items: [{ id: 1, total: 9.5 }] } },
    ]);
    assert.equal(schemaOut.count, 1);
    assert.equal(schemaOut.endpoints[0].responseSchema.properties.items.items.properties.id.type, 'integer');
    assert.ok(schemaOut.endpoints[0].testSuggestions.includes('pagination-boundary'));

    const args = resolveExplicitFileTargets('tests/e2e/home.spec.ts', 12);
    assert.ok(args.includes('tests/e2e/home.spec.ts:12'), `Expected file:line arg in ${JSON.stringify(args)}`);

    // autoCloseStaleClassBSessions returns cleanly when no open Class B exists
    assert.equal(autoCloseStaleClassBSessions(qaDir, true).closedCount, 0);
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
