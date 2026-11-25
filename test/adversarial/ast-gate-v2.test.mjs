import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  compareSpecSourcesAst,
  runAuditForQaDir,
  runInit,
  scanSpecFilesFallback,
} from '../../src/app/index.mjs';

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

const BASE_SPEC = `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] order access @critical', async ({ page, request }) => {
  const res = await request.get('/api/orders');
  expect(res.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Orders' })).toHaveText('Orders');
});
`;

function expectBlocked(headSource, expectedCodeRe, label, filePath = 'tests/e2e/orders.spec.ts', baseSource = BASE_SPEC) {
  const cmp = compareSpecSourcesAst(filePath, baseSource, headSource);
  assert.equal(cmp.ok, false, `Expected bypass [${label}] to be blocked, got pass!`);
  assert.match(cmp.violations.join('\n'), expectedCodeRe, `[${label}] violations=${cmp.violations.join(' | ')}`);
}

test('WU-05 AST Gate v2: catches 100% of symbol-table, S0, control-flow, mock, status, and config cheats', () => {
  // 1. const propagation S0
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async () => { const flag = true; expect(flag).toBe(true); });`,
    /AITEST-G104/,
    'const propagation S0'
  );

  // 2. logical short-circuit x || true & x ?? true
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { const v = await page.title(); expect(v || true).toBeTruthy(); });`,
    /AITEST-G104/,
    'x || true tautology'
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { const v = await page.title(); expect(v ?? true).toBe(true); });`,
    /AITEST-G104/,
    'x ?? true tautology'
  );

  // 3. expect.poll constant callback
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async () => { await expect.poll(() => true).toBe(true); });`,
    /AITEST-G104/,
    'expect.poll constant callback'
  );

  // 4. DOM-tainted variable self-reference
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { const loc = page.locator('#title'); const t = await loc.textContent(); await expect(loc).toHaveText(t ?? ''); });`,
    /AITEST-G104/,
    'DOM taint variable self-ref'
  );

  // 5. Semantic empty regex /a?/ & /[\\s\\S]*/ + empty string toContainText('') + 2nd-arg regex toHaveAttribute('x', /.*/)
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText(/a?/); });`,
    /AITEST-G104/,
    'semantic empty regex /a?/'
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await expect(page.getByRole('heading')).toContainText(''); });`,
    /AITEST-G104/,
    'empty string toContainText'
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await expect(page.getByRole('heading')).toHaveAttribute('data-state', /.*/); });`,
    /AITEST-G104/,
    '2nd arg vacuous regex toHaveAttribute'
  );

  // 6. expect.soft & expect.configure aliases
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
const sExpect = expect.configure({ soft: true });
test('[REQ-AUTH-01] @critical', async ({ page }) => { await sExpect(page.getByRole('heading')).toHaveText('Orders'); });`,
    /AITEST-G106/,
    'expect.configure soft alias'
  );

  // 7. toBe(true) on res.status() < 500 capped <= S2 (downgrade from S5)
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ request }) => { const res = await request.get('/api/orders'); expect(res.status() < 500).toBe(true); });`,
    /AITEST-G103|AITEST-G116/,
    'toBe(true) on binary status check'
  );

  // 8. Unresolved custom verifyFake() assigned S1 (downgrade from S5)
  expectBlocked(
    `import { test } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await verifyMagicThing(page); });`,
    /AITEST-G103/,
    'unresolved custom verify* helper'
  );

  // 9. Loop without count guard & page.on event listener expect
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { for (const row of await page.locator('tr').all()) { await expect(row).toHaveText('Orders'); } });`,
    /AITEST-G110/,
    'unguarded dynamic loop expect'
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { page.on('response', (r) => expect(r.status()).toBe(200)); });`,
    /AITEST-G110/,
    'event listener expect'
  );

  // 10. .then(ok, noop) & Promise.allSettled swallow
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText('Orders').then(() => {}, () => {}); });`,
    /AITEST-G107/,
    '2-arg .then swallow'
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await Promise.allSettled([expect(page.getByRole('heading')).toHaveText('Orders')]); });`,
    /AITEST-G107/,
    'Promise.allSettled swallow'
  );

  // 11. 1-hop named page.route handler & routeFromHAR
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
const fakeApi = (route: any) => route.fulfill({ status: 200, body: '{}' });
test('[REQ-AUTH-01] @critical', async ({ page }) => { await page.route('**/api/orders', fakeApi); await expect(page.getByRole('heading')).toHaveText('Orders'); });`,
    /AITEST-G114/,
    '1-hop named page.route handler'
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await page.routeFromHAR('mock.har'); await expect(page.getByRole('heading')).toHaveText('Orders'); });`,
    /AITEST-G114/,
    'routeFromHAR mock'
  );

  // 12. Screenshot maxDiffPixelRatio inflation & G116 HTTP status equivalence shift (403 -> 200)
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page }) => { await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.9 }); });`,
    /AITEST-G103/,
    'screenshot maxDiffPixelRatio inflation',
    'tests/e2e/visual.spec.ts',
    `import { test, expect } from '../fixtures/base';\ntest('[REQ-VIS-01] @critical', async ({ page }) => { await expect(page).toHaveScreenshot({ maxDiffPixelRatio: 0.01 }); });`
  );
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-RBAC-01] @critical', async ({ request }) => { const res = await request.get('/api/admin'); expect(res.status()).toBe(200); });`,
    /AITEST-G116/,
    'HTTP status 403 -> 200 equivalence class shift',
    'tests/api/rbac.spec.ts',
    `import { test, expect } from '../fixtures/base';\ntest('[REQ-RBAC-01] @critical', async ({ request }) => { const res = await request.get('/api/admin'); expect(res.status()).toBe(403); });`
  );

  // 13. playwright.config.ts testDir / testMatch tampering
  expectBlocked(
    `export default { testDir: './empty', projects: [] };`,
    /AITEST-G101/,
    'playwright.config.ts testDir tamper',
    'playwright.config.ts',
    `export default { testDir: './tests', projects: [] };`
  );

  // 14. REQ-* test block gutted while another test block is padded
  expectBlocked(
    `import { test, expect } from '../fixtures/base';
test('[REQ-ONE] first @critical', async () => {});
test('[REQ-TWO] second @critical', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText('A'); await expect(page.getByRole('main')).toBeVisible(); await expect(page.getByRole('nav')).toBeVisible(); });`,
    /AITEST-G102/,
    'REQ-ONE block gutted and REQ-TWO padded',
    'tests/e2e/multi.spec.ts',
    `import { test, expect } from '../fixtures/base';
test('[REQ-ONE] first @critical', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText('One'); });
test('[REQ-TWO] second @critical', async ({ page }) => { await expect(page.getByRole('main')).toBeVisible(); });`
  );
});

test('WU-05 AST Gate v2: 0% FP on benign refactors (L2 503 fault injection, toHaveText array count credit) + G117 Dieselgate & git mv', async () => {
  // 1. toHaveCount(2) + toContainText -> toHaveText(['A', 'B']) passes with implicitCountCredit
  const countRefactor = compareSpecSourcesAst(
    'tests/e2e/list.spec.ts',
    `import { test, expect } from '../fixtures/base';
test('[REQ-LIST-1] list', async ({ page }) => {
  const items = page.getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText('A');
});`,
    `import { test, expect } from '../fixtures/base';
test('[REQ-LIST-1] list', async ({ page }) => {
  const items = page.getByRole('listitem');
  await expect(items).toHaveText(['A', 'B']);
});`
  );
  assert.equal(countRefactor.ok, true, `Unexpected FP on toHaveText array refactor: ${countRefactor.violations.join('; ')}`);

  // 2. Guarded dynamic loop (with preceding toHaveCount) passes cleanly
  const guardedLoop = compareSpecSourcesAst(
    'tests/e2e/rows.spec.ts',
    BASE_SPEC,
    `import { test, expect } from '../fixtures/base';
test('[REQ-AUTH-01] @critical', async ({ page, request }) => {
  const res = await request.get('/api/orders');
  expect(res.status()).toBe(200);
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(2);
  for (const row of await rows.all()) {
    await expect(row).toHaveText('Orders');
  }
});`
  );
  assert.equal(guardedLoop.ok, true, `Unexpected FP on guarded loop: ${guardedLoop.violations.join('; ')}`);

  // 3. Layer 2 static check L2/L3 parity: 503 fault-injection route.fulfill passes Layer 2 cleanly
  const dir = makeTempDir('aitest-wu05-l2-');
  const keyFile = path.join(dir, '.t1-key.hex');
  fs.writeFileSync(keyFile, 'c'.repeat(64), 'utf8');
  const prevKey = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;
  try {
    git(dir, ['init', '-b', 'main']);
    git(dir, ['config', 'user.email', 'dev@example.com']);
    git(dir, ['config', 'user.name', 'Dev User']);
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'app', 'server.mjs'), 'export function handle(req) { return 200; }\n', 'utf8');
    await runInit({ target: dir, name: 'wu05-app', skipInstall: true, skipBrowser: true, loop: 'none', json: true });
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-m', 'chore: baseline']);

    const qaDir = path.join(dir, 'qa');
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'fault.spec.ts'),
      `import { test, expect } from '../fixtures/base';
test('[REQ-FAULT-1] 503 degradation', async ({ page }) => {
  await page.route('**/api/health', (route) => route.fulfill({ status: 503, body: 'unavailable' }));
  await expect(page.getByRole('alert')).toHaveText('Service unavailable');
});\n`,
      'utf8'
    );
    const l2Res = scanSpecFilesFallback(path.join(qaDir, 'tests'), { qaDir });
    assert.equal(l2Res.ok, true, `Expected 503 fault-injection to pass L2 static scan, got: ${l2Res.errors.join('; ')}`);

    // Installed workspace (node_modules + governance.lock) missing tsc/eslint defaults to fail-closed blocked
    fs.mkdirSync(path.join(qaDir, 'node_modules'), { recursive: true });
    const l2MissingCompilers = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: true });
    assert.equal(l2MissingCompilers.outcome, 'blocked');
    assert.match(l2MissingCompilers.errors.join('\n'), /TypeCheck Blocked|Static Check Blocked/i);
    fs.rmSync(path.join(qaDir, 'node_modules'), { recursive: true, force: true });

    // 4. Layer 3 Dieselgate (AITEST-G117): Playwright UA or NODE_ENV === 'test' branch in app/server.mjs is blocked
    fs.writeFileSync(
      path.join(dir, 'app', 'server.mjs'),
      `export function handle(req) {\n  if (/Playwright|HeadlessChrome/i.test(req.headers['user-agent'] || '') || process.env.NODE_ENV === 'test') return 200;\n  return 500;\n}\n`,
      'utf8'
    );
    const dieselAudit = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: false, diffBase: 'HEAD', requireDiff: true });
    assert.equal(dieselAudit.ok, false);
    assert.match(dieselAudit.errors.join('\n'), /AITEST-G117/);

    // 5. G-08: git mv of test spec outside tests/ fails diff guard
    fs.writeFileSync(path.join(dir, 'app', 'server.mjs'), 'export function handle(req) { return 200; }\n', 'utf8');
    fs.mkdirSync(path.join(qaDir, 'archive'), { recursive: true });
    git(dir, ['mv', 'qa/tests/e2e/home.spec.ts', 'qa/archive/home.spec.ts']);
    const mvAudit = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: false, diffBase: 'HEAD', requireDiff: true });
    assert.equal(mvAudit.ok, false);
    assert.match(mvAudit.errors.join('\n'), /moved outside executable tests directory/i);
  } finally {
    if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
