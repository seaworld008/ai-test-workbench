import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  analyzeHealerDiffText,
  auditResultsJson,
  loadAndValidateWaivers,
  scanSpecFilesFallback,
} from '../../src/audit.mjs';

test('auditResultsJson separates passed, skipped, and policy-excluded @mutation tests', () => {
  const sample = {
    suites: [
      {
        title: 'suite',
        file: 'tests/api/courses.spec.ts',
        specs: [
          {
            title: 'read courses @critical',
            tags: ['@critical'],
            tests: [{ projectName: 'api', status: 'expected', results: [] }],
          },
          {
            title: 'enroll mutation @mutation',
            tags: ['@mutation'],
            tests: [{ projectName: 'api', status: 'skipped', results: [] }],
          },
        ],
      },
    ],
  };

  const out = auditResultsJson(sample, { allowMutation: false });
  assert.equal(out.ok, true);
  assert.equal(out.stats.passed, 1);
  assert.equal(out.stats.skipped, 0);
  assert.equal(out.stats.policyExcludedMutations, 1);
});

test('auditResultsJson fails on unwaived @critical skip and passes with valid unexpired waiver', () => {
  const sample = {
    suites: [
      {
        title: 'e2e',
        file: 'tests/e2e/home.spec.ts',
        specs: [
          {
            title: 'healthy smoke @smoke',
            tags: ['@smoke'],
            tests: [{ projectName: 'smoke', status: 'expected', results: [] }],
          },
          {
            title: 'checkout critical @critical',
            tags: ['@critical'],
            tests: [{ projectName: 'e2e', status: 'skipped', results: [] }],
          },
        ],
      },
    ],
  };

  const failRes = auditResultsJson(sample, { activeWaivers: [] });
  assert.equal(failRes.ok, false);
  assert.match(failRes.errors.join(' '), /@critical\/@smoke test\(s\) were skipped/i);

  const passRes = auditResultsJson(sample, {
    activeWaivers: [
      {
        titlePattern: 'checkout critical',
        owner: 'qa-lead',
        reason: 'Payment sandbox maintenance',
        expiresAt: '2099-01-01T00:00:00Z',
      },
    ],
  });
  assert.equal(passRes.ok, true);
});

test('loadAndValidateWaivers rejects expired or ownerless waivers', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-waiver-'));
  try {
    const waiversFile = path.join(tmpDir, 'waivers.json');
    fs.writeFileSync(
      waiversFile,
      JSON.stringify({
        waivers: [
          {
            titlePattern: 'old skip',
            owner: 'alice',
            reason: 'old',
            expiresAt: '2020-01-01T00:00:00Z',
          },
        ],
      }),
      'utf8'
    );
    const res = loadAndValidateWaivers(waiversFile, Date.parse('2026-11-23T00:00:00Z'));
    assert.equal(res.ok, false);
    assert.match(res.errors.join(' '), /EXPIRED/i);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('scanSpecFilesFallback detects missing assertions, waitForTimeout, and honors custom verify* helpers', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-specscan-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'bad.spec.ts'),
      `import { test } from '@playwright/test';
       test('no assert and sleep', async ({ page }) => {
         await page.waitForTimeout(1000);
         await page.goto('/');
       });`,
      'utf8'
    );
    const badOut = scanSpecFilesFallback(tmpDir);
    assert.equal(badOut.ok, false);
    assert.equal(badOut.errors.length, 2);

    fs.rmSync(path.join(tmpDir, 'bad.spec.ts'));
    fs.writeFileSync(
      path.join(tmpDir, 'custom.spec.ts'),
      `import { test } from '@playwright/test';
       test('uses custom helper', async ({ page }) => {
         await verifyDashboardLoaded(page);
       });`,
      'utf8'
    );
    const goodOut = scanSpecFilesFallback(tmpDir, { assertFunctionNames: ['expect*', 'verify*'] });
    assert.equal(goodOut.ok, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('analyzeHealerDiffText blocks assertion deletion, added fixme, force:true, swallowed catch, and huge timeout', () => {
  const cheatingDiff = [
    'diff --git a/qa/tests/e2e/home.spec.ts b/qa/tests/e2e/home.spec.ts',
    '--- a/qa/tests/e2e/home.spec.ts',
    '+++ b/qa/tests/e2e/home.spec.ts',
    '@@ -5,6 +5,6 @@',
    "-  await expect(page.getByRole('heading')).toHaveText('Smart Campus');",
    "-  await expect(page.getByRole('button')).toBeEnabled();",
    "+  test.fixme(true, 'flaky');",
    "+  await page.getByRole('button').click({ force: true, timeout: 90000 }).catch(() => {});",
  ].join('\n');

  const res = analyzeHealerDiffText(cheatingDiff);
  assert.equal(res.ok, false);
  assert.equal(res.violations.length >= 4, true);
  assert.match(res.violations.join('\n'), /net assertion reduction/i);
  assert.match(res.violations.join('\n'), /skip\/fixme\/only/i);
  assert.match(res.violations.join('\n'), /force: true/i);
  assert.match(res.violations.join('\n'), /catch/i);
});
