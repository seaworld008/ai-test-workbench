import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { compileGlob, matchesAnyGlob, normalizePosixPath } from '../../src/core/glob.mjs';
import { detectLang, t } from '../../src/core/i18n.mjs';
import { resolvePlaywrightCli, resolvePlaywrightPackage } from '../../src/core/playwright-resolve.mjs';
import {
  computeFlakyStats,
  flattenPlaywrightResults,
  groupOutcomesBySpecFile,
  summarizePlaywrightResults,
} from '../../src/core/playwright-results.mjs';
import { redactEnvEntries, redactSecrets, redactStructuredValue } from '../../src/core/redact.mjs';
import { REPO_ROOT, SCHEMA_VERSIONS, WORKBENCH_VERSION } from '../../src/core/version.mjs';

test('core/glob compiles wildcards, double-stars, Windows paths, and regex metacharacters', () => {
  assert.equal(normalizePosixPath('.\\tests\\e2e\\login.spec.ts'), 'tests/e2e/login.spec.ts');
  const re = compileGlob('support/**/*.mjs');
  assert.equal(re.test('support/gate/ast-analyzer.mjs'), true);
  assert.equal(re.test('support/gate-kernel.mjs'), true);
  assert.equal(re.test('tests/gate.spec.ts'), false);

  const literal = compileGlob('foo+bar(1).[ts]');
  assert.equal(literal.test('foo+bar(1).[ts]'), true);
  assert.equal(literal.test('fooXbar(1).t'), false);

  assert.equal(matchesAnyGlob('src\\pages\\checkout.tsx', ['src/pages/*.tsx']), true);
  assert.equal(matchesAnyGlob('src/pages/deep/checkout.tsx', ['src/pages/*.tsx']), false);
});

test('core/playwright-results unifies retryPassed -> flaky across flatten, summarize, and file grouping', () => {
  const sampleResults = {
    suites: [
      {
        title: 'checkout.spec.ts',
        file: 'e2e\\checkout.spec.ts',
        specs: [
          {
            title: 'completes payment @critical',
            file: 'e2e\\checkout.spec.ts',
            line: 12,
            tags: ['smoke'],
            tests: [
              {
                projectName: 'chromium',
                // Playwright reports `expected` with 2 attempts when a retry passed!
                status: 'expected',
                results: [
                  { status: 'failed', duration: 300, error: { message: 'Timeout waiting for button\nstack' } },
                  { status: 'passed', duration: 200 },
                ],
              },
            ],
          },
          {
            title: 'renders empty cart',
            line: 28,
            tests: [
              {
                projectName: 'chromium',
                status: 'expected',
                results: [{ status: 'passed', duration: 100 }],
              },
            ],
          },
          {
            title: 'rejects expired coupon',
            line: 42,
            tests: [
              {
                projectName: 'chromium',
                status: 'unexpected',
                results: [{ status: 'failed', duration: 150, error: { message: 'Expected 400 got 500' } }],
              },
            ],
          },
          {
            title: 'skipped placeholder',
            line: 55,
            tests: [{ projectName: 'chromium', status: 'skipped', results: [] }],
          },
        ],
      },
    ],
  };

  const flat = flattenPlaywrightResults(sampleResults);
  assert.equal(flat.length, 4);
  assert.equal(flat[0].status, 'flaky');
  assert.equal(flat[0].rawStatus, 'expected');
  assert.equal(flat[0].retryPassed, true);
  assert.equal(flat[0].durationMs, 500);
  assert.deepEqual(flat[0].tags.sort(), ['@critical', '@smoke']);
  assert.equal(flat[0].errorSnippet, 'Timeout waiting for button');

  const summary = summarizePlaywrightResults(sampleResults);
  assert.deepEqual(summary.counts, {
    total: 4,
    executed: 3,
    passed: 1,
    failed: 1,
    flaky: 1,
    skipped: 1,
  });

  const byFile = groupOutcomesBySpecFile(sampleResults);
  assert.deepEqual(byFile.get('tests/e2e/checkout.spec.ts'), {
    passed: 1,
    failed: 1,
    flaky: 1,
    skipped: 1,
  });
});

test('core/playwright-results computeFlakyStats matches shared flaky formula and skips skipped runs', () => {
  const stats = computeFlakyStats([
    { status: 'expected', retryPassed: false },
    { status: 'unexpected', retryPassed: false },
    { status: 'skipped', retryPassed: false },
    { status: 'expected', retryPassed: true },
    { status: 'expected', retryPassed: false },
  ]);

  assert.equal(stats.totalRuns, 4);
  assert.equal(stats.passed, 2);
  assert.equal(stats.failed, 1);
  assert.equal(stats.flaky, 1);
  // flakyEvents = 1 (explicit flaky) + min(2, 1) = 2 -> 2 / 4 = 0.5
  assert.equal(stats.flakyEvents, 2);
  assert.equal(stats.flakyRate, 0.5);
  assert.equal(stats.failRate, 0.25);
  assert.equal(stats.consecutivePasses, 1);
});

test('core/redact scrubs credentials while preserving internal workbench IDs', () => {
  const json = JSON.stringify({
    sessionId: 'heal_0123456789abcdef',
    externalSession: { sessionId: 'sid_cookie_secret_999' },
    token: 'ghp_1234567890abcdefghij123456',
  });
  const redactedText = redactSecrets(json);
  assert.match(redactedText, /heal_0123456789abcdef/);
  assert.doesNotMatch(redactedText, /ghp_1234567890/);
  assert.doesNotMatch(redactedText, /sid_cookie_secret_999/);

  const structured = redactStructuredValue({
    sessionId: 'heal_0123456789abcdef',
    apiKey: 'secret-value',
    nested: { sessionId: 'cookie-val-123' },
  });
  assert.equal(structured.sessionId, 'heal_0123456789abcdef');
  assert.equal(structured.apiKey, '[REDACTED]');
  assert.equal(structured.nested.sessionId, '[REDACTED]');

  const envRedacted = redactEnvEntries({
    TEST_ENV: 'staging',
    AUTH_TOKEN: 'super-secret',
    DB_URL: 'postgres://admin:p4ssw0rd@db.internal/app',
  });
  assert.equal(envRedacted.TEST_ENV, 'staging');
  assert.equal(envRedacted.AUTH_TOKEN, '[REDACTED]');
  assert.equal(envRedacted.DB_URL, 'postgres://admin:[REDACTED]@db.internal/app');
});

test('core/playwright-resolve finds CLI and package entrypoints deterministically', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-pw-resolve-'));
  try {
    assert.equal(resolvePlaywrightCli(tmp), null);
    assert.equal(resolvePlaywrightPackage(tmp), null);

    const cliPath = path.join(tmp, 'node_modules', '@playwright', 'test', 'cli.js');
    const pkgPath = path.join(tmp, 'node_modules', 'playwright', 'index.mjs');
    fs.mkdirSync(path.dirname(cliPath), { recursive: true });
    fs.mkdirSync(path.dirname(pkgPath), { recursive: true });
    fs.writeFileSync(cliPath, '', 'utf8');
    fs.writeFileSync(pkgPath, '', 'utf8');

    assert.equal(resolvePlaywrightCli(tmp), cliPath);
    assert.equal(resolvePlaywrightPackage(tmp), pkgPath);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('core/version and core/i18n expose valid package metadata and bilingual localization', () => {
  assert.ok(fs.existsSync(path.join(REPO_ROOT, 'package.json')));
  assert.match(WORKBENCH_VERSION, /^\d+\.\d+\.\d+/);
  assert.equal(SCHEMA_VERSIONS.templateManifest, 1);
  assert.equal(detectLang('zh-CN', {}), 'zh');
  assert.equal(detectLang(undefined, { AITEST_LANG: 'en' }), 'en');
  assert.match(t('en', 'appTitle'), new RegExp(WORKBENCH_VERSION.replace(/\./g, '\\.')));
});
