import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '../../examples/demo-webapp/server.mjs';
import { runCli } from '../../src/cli.mjs';
import { hasPlaywrightChromium } from '../fixtures/playwright-env.mjs';
import { computeLatencyPercentiles, evaluatePerfBudget, runPerfCommand } from '../../src/perf.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_MODULES = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa', 'node_modules');

test('computeLatencyPercentiles computes accurate P50/P90/P95/P99/avg stats', () => {
  const stats = computeLatencyPercentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
  assert.equal(stats.count, 10);
  assert.equal(stats.minMs, 10);
  assert.equal(stats.p50Ms, 50);
  assert.equal(stats.p90Ms, 90);
  assert.equal(stats.p95Ms, 100);
  assert.equal(stats.maxMs, 100);
  assert.equal(stats.avgMs, 55);
});

test('evaluatePerfBudget flags TTFB, duplicate API waterfalls, and API P95 SLO violations', () => {
  const okEval = evaluatePerfBudget({
    browserMetrics: [{ route: '/', ttfbMs: 120, fcpMs: 300, cls: 0.01, domNodes: 400, duplicateApisCount: 0 }],
    apiBenchmark: { totalRequests: 10, p95Ms: 85, p99Ms: 95, errorRate: 0 },
  });
  assert.equal(okEval.ok, true);

  const badEval = evaluatePerfBudget(
    {
      browserMetrics: [{ route: '/slow', ttfbMs: 2200, duplicateApisCount: 3 }],
      apiBenchmark: { totalRequests: 10, p95Ms: 1800, p99Ms: 2100, errorRate: 0 },
    },
    { browser: { maxTtfbMs: 1500, maxDuplicateApisPerRoute: 1 }, api: { maxP95Ms: 1500 } }
  );
  assert.equal(badEval.ok, false);
  assert.equal(badEval.violations.length, 3);
});

test('runPerfCommand blocks production targets cleanly before launching load or browser', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-perf-prod-'));
  try {
    await runCli(['init', '--name', 'perf-prod', '--target', tmpDir, '--skip-install', '--loop', 'none']);
    fs.writeFileSync(
      path.join(tmpDir, 'qa', '.env'),
      'TEST_ENV=production\nTEST_BASE_URL=https://prod.example.com\nTEST_ALLOWED_HOSTS=prod.example.com\n',
      'utf8'
    );
    const code = await runPerfCommand({ target: tmpDir, lang: 'en' });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI `perf --mode api` benchmarks local demo server and writes perf-report.json + perf-summary.md', async () => {
  const demo = await startDemoServer({ port: 0, host: '127.0.0.1' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-perf-api-'));
  try {
    await runCli(['init', '--name', 'perf-demo', '--target', tmpDir, '--skip-install', '--loop', 'none']);
    fs.writeFileSync(
      path.join(tmpDir, 'qa', '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${demo.baseURL}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\nREQUIRE_TEST_TARGET=1\n`,
      'utf8'
    );

    const code = await runCli([
      'perf',
      '--target',
      tmpDir,
      '--base-url',
      demo.baseURL,
      '--mode',
      'api',
      '--endpoint',
      '/api/courses',
      '--concurrency',
      '2',
      '--iterations',
      '6',
      '--enforce-budget',
      '--lang',
      'en',
    ]);
    assert.equal(code, 0);

    const reportPath = path.join(tmpDir, 'qa', 'reports', 'perf-report.json');
    const summaryPath = path.join(tmpDir, 'qa', 'reports', 'perf-summary.md');
    assert.equal(fs.existsSync(reportPath), true);
    assert.equal(fs.existsSync(summaryPath), true);

    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.equal(report.apiBenchmark.totalRequests, 6);
    assert.equal(report.budgetPassed, true);
  } finally {
    await demo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI `perf --mode browser` captures real non-null LCP via PerformanceObserver (P-01 regression lock)', async (t) => {
  if (!hasPlaywrightChromium(TEMPLATE_MODULES)) {
    t.skip('Playwright Chromium binary not installed in this environment');
    return;
  }

  const demo = await startDemoServer({ port: 0, host: '127.0.0.1' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-perf-lcp-'));
  try {
    await runCli(['init', '--name', 'perf-lcp', '--target', tmpDir, '--skip-install', '--loop', 'none']);
    fs.symlinkSync(TEMPLATE_MODULES, path.join(tmpDir, 'qa', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(
      path.join(tmpDir, 'qa', '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${demo.baseURL}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\nREQUIRE_TEST_TARGET=1\n`,
      'utf8'
    );

    const code = await runCli([
      'perf',
      '--target',
      tmpDir,
      '--base-url',
      demo.baseURL,
      '--mode',
      'browser',
      '--routes',
      '/',
      '--samples',
      '2',
      '--enforce-budget',
      '--lang',
      'en',
    ]);
    assert.equal(code, 0);

    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, 'qa', 'reports', 'perf-report.json'), 'utf8'));
    assert.equal(report.browserMetrics.length, 1);
    const rootMetrics = report.browserMetrics[0];
    assert.equal(typeof rootMetrics.lcpMs, 'number', 'LCP must be a real number captured via PerformanceObserver, never null');
    assert.ok(rootMetrics.lcpMs >= 0);
    assert.equal(typeof rootMetrics.cls, 'number');
  } finally {
    await demo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
