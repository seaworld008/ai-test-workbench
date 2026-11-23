import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeHealerDiffText, classifyAssertionStatement } from '../src/audit.mjs';
import { extractQueryableTraceId, suggestFailureCategory } from '../src/diagnose.mjs';
import { evaluateExploreRequestSafety } from '../src/explore.mjs';
import {
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  inspectGraphqlPayload,
} from '../src/origin-guard.mjs';
import { redactSecrets } from '../src/proc.mjs';
import {
  extractOpenApiResponseSchema,
  validateJsonSchema,
} from '../templates/playwright-qa/support/schema-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ADV_DIR = path.join(__dirname, 'adversarial');

test('Adversarial Diff Guard Suite: blocks 100% of all 20 cheating healer/config diffs (FGER = 0%)', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'diff-bypasses.cases.json'), 'utf8'));
  assert.ok(cases.length >= 20);

  let escaped = 0;
  for (const c of cases) {
    const res = analyzeHealerDiffText(c.diff);
    if (res.ok) {
      escaped += 1;
      assert.fail(`Cheating diff escaped Semantic Diff Guard: [${c.id}] ${c.description}`);
    }
  }
  assert.equal(escaped, 0);

  // Also test the combined 8-bypass mega-diff from architecture-code-review-2026-11.md verbatim!
  const reviewMegaDiff = [
    'diff --git a/tests/e2e/checkout.spec.ts b/tests/e2e/checkout.spec.ts',
    '--- a/tests/e2e/checkout.spec.ts',
    '+++ b/tests/e2e/checkout.spec.ts',
    '@@ -5,4 +5,8 @@',
    "-  await expect(page.getByRole('status')).toHaveText('Order saved: #1024');",
    "+  await expect(page.locator('body')).toBeVisible();",
    '-  await expect(res.status()).toBe(201);',
    '+  expect(true).toBe(true);',
    '+  test.fail();',
    "+  await page.click('#save').catch(() => null);",
    '+  test.describe.configure({ retries: 5 });',
    "+  await expect.soft(page.getByText('Total')).toHaveText('99');",
    'diff --git a/playwright.config.ts b/playwright.config.ts',
    "+  testIgnore: ['**/checkout.spec.ts'],",
    'diff --git a/eslint.config.mjs b/eslint.config.mjs',
    "+      'playwright/no-skipped-test': 'off',",
  ].join('\n');

  const megaRes = analyzeHealerDiffText(reviewMegaDiff);
  assert.equal(megaRes.ok, false);
  assert.ok(megaRes.violations.length >= 8, `Expected >= 8 distinct violations, got ${megaRes.violations.length}`);

  // Verify legitimate Class-A locator update (preserving exact S5 assertion strength!) passes cleanly
  const legitimateRepairDiff = [
    'diff --git a/tests/e2e/checkout.spec.ts b/tests/e2e/checkout.spec.ts',
    '--- a/tests/e2e/checkout.spec.ts',
    '+++ b/tests/e2e/checkout.spec.ts',
    '@@ -10,1 +10,1 @@',
    "-  await expect(page.getByTestId('order-toast')).toHaveText('Order saved: #1024');",
    "+  await expect(page.getByRole('status')).toHaveText('Order saved: #1024');",
  ].join('\n');
  const legitRes = analyzeHealerDiffText(legitimateRepairDiff);
  assert.equal(legitRes.ok, true, `Legitimate locator fix falsely flagged: ${legitRes.violations.join('; ')}`);

  assert.equal(classifyAssertionStatement('expect(true).toBe(true)').tier, 0);
  assert.equal(classifyAssertionStatement("await expect(loc).toHaveText('Order #1')").tier, 5);
  assert.equal(classifyAssertionStatement('await expect(loc).toBeVisible()').tier, 2);
});

test('Adversarial Redaction v2 Suite: strips 100% of all 35 secret leak vectors (JSON, JWT, tokens, PEM, URLs)', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'redaction.cases.json'), 'utf8'));
  assert.ok(cases.length >= 35);

  for (const c of cases) {
    const clean = redactSecrets(c.input);
    assert.equal(
      clean.includes(c.mustNotContain),
      false,
      `Redaction leaked secret in [${c.id}]: output="${clean}"`
    );
  }
});

test('Adversarial Triage v2 Suite: achieves >= 95% classification accuracy across 45 labeled failure cases & extracts 32-char W3C traceId', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(ADV_DIR, 'triage.cases.json'), 'utf8'));
  assert.ok(cases.length >= 45);

  let correct = 0;
  for (const c of cases) {
    const res = suggestFailureCategory(c.error, c.guard || null);
    if (res.categoryCode === c.expected) {
      correct += 1;
    }
  }
  const accuracy = correct / cases.length;
  assert.ok(accuracy >= 0.95, `Expected triage accuracy >= 0.95, got ${accuracy.toFixed(3)} (${correct}/${cases.length})`);

  // Verify W3C traceparent extraction (`D-02`)
  const traceId = extractQueryableTraceId('traceparent:00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.equal(traceId, '4bf92f3577b34da6a3ce929d0e0e4736');
});

test('Explore Firewall & Egress Allowlist: default-denies POSTs, GraphQL mutations, and non-allowlisted hosts', () => {
  const guardCfg = {
    baseURL: 'http://127.0.0.1:5899',
    allowedHosts: ['127.0.0.1', 'localhost'],
    egressMode: 'allowlist',
    blockedRules: compileBlockedEndpointRules(),
  };

  // S-01: Arbitrary POST (/api/order/cancel, /api/setStatus) blocked by Explore default-deny!
  assert.equal(evaluateExploreRequestSafety('POST', 'http://127.0.0.1:5899/api/order/cancel', '{}', guardCfg).blocked, true);
  assert.equal(evaluateExploreRequestSafety('POST', 'http://127.0.0.1:5899/api/setStatus', '{}', guardCfg).blocked, true);

  // S-01/S-02: GraphQL mutation blocked, pure GraphQL query allowed in Explore when allowGraphqlQuery=true
  const gqlMutBody = JSON.stringify({ query: 'mutation CancelOrder($id: ID!) { cancelOrder(id: $id) { ok } }' });
  const gqlQueryBody = JSON.stringify({ query: 'query GetCourses { courses { id title } }' });
  assert.equal(inspectGraphqlPayload(gqlMutBody).hasMutation, true);
  assert.equal(inspectGraphqlPayload(gqlQueryBody).isPureQuery, true);
  assert.equal(evaluateExploreRequestSafety('POST', 'http://127.0.0.1:5899/graphql', gqlMutBody, guardCfg).blocked, true);
  assert.equal(evaluateExploreRequestSafety('POST', 'http://127.0.0.1:5899/graphql', gqlQueryBody, guardCfg).blocked, false);

  // S-02: Default TEST_STRICT_READONLY blocks /graphql writes now that /graphql was removed from DEFAULT_SAFE_WRITE_PATHS
  assert.equal(
    checkOutgoingRequestSafety('POST', 'http://127.0.0.1:5899/graphql', {
      strictReadonly: true,
      postData: gqlMutBody,
    }).blocked,
    true
  );

  // S-03: Outbound egress allowlist blocks external production domains even if not in TEST_DENIED_ORIGINS!
  const egressBlock = checkOutgoingRequestSafety('GET', 'https://unlisted-production.company.com/api/data', guardCfg);
  assert.equal(egressBlock.blocked, true);
  assert.match(egressBlock.reason || '', /TEST_EGRESS_MODE=allowlist/);
});

test('WCAG 2.0/2.1/2.2 tag lock & JSON Schema / OpenAPI contract validator work cleanly', () => {
  const baseTsText = fs.readFileSync(
    path.resolve(__dirname, '..', 'templates', 'playwright-qa', 'tests', 'fixtures', 'base.ts'),
    'utf8'
  );
  for (const requiredTag of ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']) {
    assert.match(baseTsText, new RegExp(`'${requiredTag}'`), `Missing required axe tag ${requiredTag} in base.ts`);
  }

  const openApiDoc = {
    openapi: '3.0.3',
    paths: {
      '/api/courses': {
        get: {
          responses: {
            '200': {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CoursesReply' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        CoursesReply: {
          type: 'object',
          required: ['courses'],
          additionalProperties: false,
          properties: {
            courses: {
              type: 'array',
              items: {
                type: 'object',
                required: ['id', 'seatsLeft'],
                properties: {
                  id: { type: 'string' },
                  seatsLeft: { type: 'integer', minimum: 0 },
                },
              },
            },
          },
        },
      },
    },
  };

  const schema = extractOpenApiResponseSchema(openApiDoc, '/api/courses', 'get', 200);
  assert.ok(schema);
  assert.equal(
    validateJsonSchema({ courses: [{ id: 'c1', seatsLeft: 5 }] }, schema, { rootDoc: openApiDoc }).ok,
    true
  );
  const drifted = validateJsonSchema(
    { courses: [{ id: 'c1', seatsLeft: -1 }], extraSecret: true },
    schema,
    { rootDoc: openApiDoc }
  );
  assert.equal(drifted.ok, false);
  assert.equal(drifted.errors.length, 2);
});
