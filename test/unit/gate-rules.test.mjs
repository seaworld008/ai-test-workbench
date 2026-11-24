import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ALL_GATE_RULES,
  analyzeSourceAst,
  compareSpecSourcesAst,
  getGateRuleByCode,
  isRuleEnabled,
} from '../../src/kernel/gate-kernel.mjs';

test('Gate Rule Registry exposes all 15 canonical rules AITEST-G101..G115 with toggleable config', () => {
  assert.equal(ALL_GATE_RULES.length, 15);
  const codes = ALL_GATE_RULES.map((r) => r.code);
  for (let n = 101; n <= 115; n += 1) {
    const code = `AITEST-G${n}`;
    assert.ok(codes.includes(code), `Missing rule ${code}`);
    const rule = getGateRuleByCode(code);
    assert.ok(rule && typeof rule.evaluate === 'function' && rule.name && rule.description);
    assert.equal(isRuleEnabled(code, {}), true);
  }

  assert.equal(isRuleEnabled('AITEST-G114', { 'AITEST-G114': false }), false);
  assert.equal(isRuleEnabled('AITEST-G114', { 'AITEST-G114': { enabled: false } }), false);
  assert.equal(isRuleEnabled('AITEST-G114', { 'AITEST-G114': { severity: 'off' } }), false);
  assert.equal(isRuleEnabled('AITEST-G114', { 'AITEST-G114': { enabled: true, severity: 'error' } }), true);
});

test('Scope-aware AST parser tracks test titles, browser-evaluate scope, and catch assertions', () => {
  const src = `
    if (!process.env.CI) {
      test('checks focus and error', async ({ page }) => {
        await expect(page.getByRole('button')).toHaveText('Save');
        await page.evaluate(() => {
          try { window.localStorage.getItem('k'); } catch {}
        });
        try {
          await page.click('#bad');
        } catch (err) {
          expect(String(err)).toContain('failed');
        }
      });
    }
  `;
  const sum = analyzeSourceAst('tests/scope.spec.ts', src);
  assert.equal(sum.usedAst, true);
  assert.equal(sum.testBlocks.length, 1);
  assert.equal(sum.testBlocks[0].title, 'checks focus and error');

  const btnAssert = sum.assertions.find((a) => a.matcher === 'toHaveText');
  assert.ok(btnAssert);
  assert.equal(btnAssert.scopeKind, 'test');
  assert.equal(btnAssert.testTitle, 'checks focus and error');
  assert.equal(btnAssert.insideIf, true);
  assert.equal(btnAssert.insideIfInTest, false);

  const browserCatch = sum.events.swallowedCatches.find((c) => c.insideBrowserEvaluate);
  assert.ok(browserCatch, 'Expected browser-evaluate try/catch to be tagged insideBrowserEvaluate=true');

  const assertCatch = sum.events.swallowedCatches.find((c) => !c.insideBrowserEvaluate);
  assert.ok(assertCatch);
  assert.equal(assertCatch.hasAssertionInCatch, true);
});

const RULE_FIXTURES = [
  {
    code: 'AITEST-G101',
    file: 'playwright.config.ts',
    base: 'export default { retries: 0 };',
    malignant: 'export default { retries: 0, testIgnore: ["**/*.spec.ts"] };',
    benignFile: 'tests/e2e/ok.spec.ts',
    benignBase: "test('ok', async ({ page }) => { await expect(page).toHaveTitle('A'); });",
    benignHead: "test('ok', async ({ page }) => { await expect(page).toHaveTitle('B'); });",
  },
  {
    code: 'AITEST-G102',
    file: 'tests/e2e/cart.spec.ts',
    base: "test('cart', async ({ page }) => { await expect(page).toHaveURL('/cart'); await expect(page.getByText('Total')).toHaveText('$10'); });",
    malignant: "test('cart', async ({ page }) => { await expect(page).toHaveURL('/cart'); });",
    benignBase: "test('cart', async ({ page }) => { await expect(page).toHaveURL('/cart'); });",
    benignHead: "test('cart', async ({ page }) => { await expect(page).toHaveURL('/cart'); await expect(page).toHaveTitle('Cart'); });",
  },
  {
    code: 'AITEST-G103',
    file: 'tests/e2e/cart.spec.ts',
    base: "test('cart', async ({ page }) => { await expect(page.getByRole('status')).toHaveText('Paid'); });",
    malignant: "test('cart', async ({ page }) => { await expect(page.getByRole('status')).toBeVisible(); });",
    benignBase: "test('cart', async ({ page }) => { await expect(page.getByRole('status')).toBeVisible(); });",
    benignHead: "test('cart', async ({ page }) => { await expect(page.getByRole('status')).toHaveText('Paid'); });",
  },
  {
    code: 'AITEST-G104',
    file: 'tests/e2e/tautology.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); expect(true).toBe(true); });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); await expect(page).toHaveTitle('Home'); });",
  },
  {
    code: 'AITEST-G105',
    file: 'tests/e2e/skip.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test.skip('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignBase: "test.skip('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
  },
  {
    code: 'AITEST-G106',
    file: 'tests/e2e/soft.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { await expect.soft(page).toHaveURL('/ok'); });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
  },
  {
    code: 'AITEST-G107',
    file: 'tests/e2e/catch.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { try { await expect(page).toHaveURL('/ok'); } catch {} });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { try { await expect(page).toHaveURL('/ok'); } catch (e) { throw e; } });",
  },
  {
    code: 'AITEST-G108',
    file: 'tests/e2e/force.spec.ts',
    base: "test('t', async ({ page }) => { await page.getByRole('button').click(); await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { await page.getByRole('button').click({ force: true }); await expect(page).toHaveURL('/ok'); });",
    benignBase: "test('t', async ({ page }) => { await page.getByRole('button').click(); await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { await page.getByRole('button', { name: 'Submit' }).click(); await expect(page).toHaveURL('/ok'); });",
  },
  {
    code: 'AITEST-G109',
    file: 'tests/e2e/timeout.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { test.setTimeout(120000); await expect(page).toHaveURL('/ok'); });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { test.setTimeout(15000); await expect(page).toHaveURL('/ok'); });",
  },
  {
    code: 'AITEST-G110',
    file: 'tests/e2e/cond.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { if (Math.random() > 0.5) { await expect(page).toHaveURL('/ok'); } });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
  },
  {
    code: 'AITEST-G111',
    file: 'tests/e2e/loc.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText('Hi'); });",
    malignant: "test('t', async ({ page }) => { await expect(page.locator('body')).toHaveText('Hi'); });",
    benignBase: "test('t', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText('Hi'); });",
    benignHead: "test('t', async ({ page }) => { await expect(page.getByTestId('hero-title')).toHaveText('Hi'); });",
  },
  {
    code: 'AITEST-G112',
    file: 'tests/api/orders.spec.ts',
    base: "test('api', async ({ request }) => { const r = await request.get('/api/orders'); expect(r.status()).toBe(200); });",
    malignant: "test('api', async ({ request }) => { const r = await request.get('/api/orders'); expect(r.status()).toBe(500); });",
    benignBase: "test('api', async ({ request }) => { const r = await request.get('/api/orders'); expect(r.status()).toBe(200); });",
    benignHead: "test('api', async ({ request }) => { const r = await request.get('/api/orders'); expect(r.status()).toBe(201); });",
  },
  {
    code: 'AITEST-G113',
    file: 'tests/e2e/helper.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "function verifyOrder() { return true; }\ntest('t', async ({ page }) => { verifyOrder(); await expect(page).toHaveURL('/ok'); });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "async function verifyOrder(p) { await expect(p).toHaveURL('/ok'); }\ntest('t', async ({ page }) => { await verifyOrder(page); });",
  },
  {
    code: 'AITEST-G114',
    file: 'tests/e2e/mock.spec.ts',
    base: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('t', async ({ page }) => { await page.route('**/api/pay', r => r.fulfill({ status: 200, body: '{}' })); await expect(page).toHaveURL('/ok'); });",
    benignBase: "test('t', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('t', async ({ page }) => { await page.route('**/api/pay', r => r.continue()); await expect(page).toHaveURL('/ok'); });",
  },
  {
    code: 'AITEST-G115',
    file: 'tests/e2e/tags.spec.ts',
    base: "test('checkout @critical', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    malignant: "test('checkout', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignBase: "test('checkout @critical', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
    benignHead: "test('checkout flow @critical', async ({ page }) => { await expect(page).toHaveURL('/ok'); });",
  },
];

for (const fx of RULE_FIXTURES) {
  test(`Pluggable GateRule ${fx.code}: blocks malignant fixture, allows benign fixture, honors rulesConfig toggle`, () => {
    const mal = compareSpecSourcesAst(fx.file, fx.base, fx.malignant);
    assert.equal(mal.ok, false, `${fx.code} should block malignant fixture`);
    assert.ok(
      mal.findings.some((f) => f.code === fx.code),
      `${fx.code} should emit structured finding with code ${fx.code}, got: ${JSON.stringify(mal.findings)}`
    );

    // Disabling the specific rule via rulesConfig silences that rule code
    const disabled = compareSpecSourcesAst(fx.file, fx.base, fx.malignant, {
      rulesConfig: { [fx.code]: false },
    });
    assert.equal(
      disabled.findings.some((f) => f.code === fx.code),
      false,
      `${fx.code} should respect rulesConfig["${fx.code}"] = false`
    );

    const ben = compareSpecSourcesAst(fx.benignFile || fx.file, fx.benignBase, fx.benignHead);
    assert.equal(
      ben.findings.some((f) => f.code === fx.code),
      false,
      `${fx.code} should NOT flag benign fixture, got: ${JSON.stringify(ben.findings)}`
    );
  });
}
