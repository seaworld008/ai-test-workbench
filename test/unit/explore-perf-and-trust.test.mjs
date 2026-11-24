import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { executeExploreCrawl } from '../../src/explore/crawler.mjs';
import { attachExploreObservers } from '../../src/explore/observers.mjs';
import { buildExploreCliSummary, resolveExploreEntryPath } from '../../src/explore/reporter.mjs';
import { runInit } from '../../src/init.mjs';
import {
  buildPerfMarkdown,
  computeLatencyPercentiles,
  evaluatePerfBudget,
  medianOfNullable,
  p75OfNullable,
} from '../../src/perf/budget.mjs';
import { runReadOnlyApiBenchmark } from '../../src/perf/collectors.mjs';
import {
  buildInTotoVerdictAttestation,
  describeTrustLevel,
  detectCiContext,
  resolveVerdictTrustTier,
} from '../../src/trust/intoto.mjs';
import { runUpgradeCommand, upgradeQaWorkspace } from '../../src/upgrade.mjs';

test('attachExploreObservers enforces WS/HTTP firewalls, filters self-inflicted firewall console noise, and captures 5xx/envelope/query signals', async () => {
  const listeners = new Map();
  let wsHandler = null;
  let routeHandler = null;
  let initFn = null;

  const mockPage = {
    on(evt, fn) {
      listeners.set(evt, fn);
    },
  };
  const mockContext = {
    async routeWebSocket(_pat, fn) {
      wsHandler = fn;
    },
    async addInitScript(fn) {
      initFn = fn;
    },
    async route(_pat, fn) {
      routeHandler = fn;
    },
    async newPage() {
      return mockPage;
    },
  };

  const topology = {
    blockedWriteRequests: [],
    consoleErrors: [],
    firewallAbortedConsoleCount: 0,
    serverErrors: [],
    endpoints: [],
    envelopeErrors: [],
    queryAnomalies: [],
  };

  const observers = await attachExploreObservers({
    context: mockContext,
    safety: { baseURL: 'https://staging.example.internal/overview/platform' },
    guardConfig: {
      baseURL: 'https://staging.example.internal/overview/platform',
      allowedHosts: ['staging.example.internal'],
      allowedOrigins: [],
      deniedOrigins: [],
      extraEgressHosts: [],
      egressMode: 'allowlist',
      blockedRules: [],
      safePostPaths: [],
      allowGraphqlQuery: true,
      deniedSubstrings: [],
    },
    sessionData: null,
    topology,
    entryPath: '/overview/platform',
  });

  assert.equal(typeof initFn, 'function');
  assert.equal(typeof wsHandler, 'function');
  assert.equal(typeof routeHandler, 'function');
  observers.beginRoute('/console');

  // 1. WebSocket firewall: non-allowlisted closed, allowlisted connected
  let wsClosed = null;
  wsHandler({
    url: () => 'wss://evil.thirdparty.test/ws',
    close: (opts) => {
      wsClosed = opts;
    },
    connectToServer: () => assert.fail('must not connect blocked ws'),
  });
  assert.equal(wsClosed?.code, 1008);

  let wsConnected = false;
  wsHandler({
    url: () => 'wss://staging.example.internal/ws',
    close: () => assert.fail('must not close allowlisted ws'),
    connectToServer: () => {
      wsConnected = true;
    },
  });
  assert.equal(wsConnected, true);

  // 2. HTTP firewall: cross-origin XHR blocked & host captured; allowlisted GET continued
  let abortedReason = null;
  await routeHandler({
    request: () => ({
      method: () => 'GET',
      url: () => 'https://gw-staging.example.internal/api/menu',
      postData: () => null,
      resourceType: () => 'xhr',
    }),
    abort: async (reason) => {
      abortedReason = reason;
    },
    continue: async () => assert.fail('blocked cross-origin xhr must not continue'),
  });
  assert.equal(abortedReason, 'blockedbyclient');
  assert.deepEqual(observers.getBlockedApiHosts(), ['gw-staging.example.internal']);

  let continued = false;
  await routeHandler({
    request: () => ({
      method: () => 'GET',
      url: () => 'https://staging.example.internal/api/items',
      postData: () => null,
      resourceType: () => 'fetch',
    }),
    abort: async () => assert.fail('allowlisted GET must continue'),
    continue: async () => {
      continued = true;
    },
  });
  assert.equal(continued, true);

  // 3. Console & pageerror: ERR_BLOCKED_BY_CLIENT filtered; real app errors preserved
  listeners.get('console')({ type: () => 'error', text: () => 'Failed to load resource: net::ERR_BLOCKED_BY_CLIENT.Inspector' });
  listeners.get('console')({ type: () => 'error', text: () => 'Uncaught TypeError: bad render' });
  listeners.get('pageerror')(new Error('Unhandled promise rejection'));
  assert.equal(topology.firewallAbortedConsoleCount, 1);
  assert.equal(topology.consoleErrors.length, 2);

  // 4. Response observer: 5xx, JSON HTTP 200 envelope error, GET count, and query anomaly
  listeners.get('response')({
    status: () => 502,
    url: () => 'https://staging.example.internal/api/fail',
    headers: () => ({ 'content-type': 'text/plain' }),
    request: () => ({ method: () => 'GET', resourceType: () => 'xhr' }),
  });
  listeners.get('response')({
    status: () => 200,
    url: () => 'https://staging.example.internal/api/list?id=undefined',
    headers: () => ({ 'content-type': 'application/json; charset=utf-8' }),
    request: () => ({ method: () => 'GET', resourceType: () => 'fetch' }),
    json: async () => ({ code: 500, msg: 'Wrapped failure' }),
  });
  await new Promise((r) => setTimeout(r, 15));

  assert.equal(topology.serverErrors.length, 1);
  assert.equal(topology.endpoints.length, 2);
  assert.equal(topology.envelopeErrors.length, 1);
  assert.equal(topology.envelopeErrors[0].code, 500);
  assert.ok(topology.queryAnomalies.length >= 1);
  assert.equal(observers.getRouteApiCounts().get('/api/list'), 1);

  // 5. resolveExploreEntryPath & buildExploreCliSummary
  assert.equal(resolveExploreEntryPath('https://staging.example.internal/overview/platform?tab=1', undefined), '/overview/platform?tab=1');
  assert.equal(resolveExploreEntryPath('https://staging.example.internal/', undefined), '/');
  assert.equal(resolveExploreEntryPath('https://staging.example.internal/a', '/custom'), '/custom');
  const drySummary = buildExploreCliSummary(
    { snapshotId: 'exp_1', pages: [{ tabsExplored: ['A'], dialogsExplored: [] }], endpoints: [], blockedWriteRequests: [], portals: [], brokenRoutes: [], envelopeErrors: [], consoleErrors: [], blockedApiHosts: [] },
    { entryPath: '/overview/platform', dryRun: true }
  );
  assert.equal(drySummary.ok, true);
  assert.equal(drySummary.exitCode, 0);
  assert.equal(drySummary.dryRun, true);
});

test('perf budget helpers evaluate all browser/API/regression SLO violations and render zh/en Markdown', () => {
  assert.equal(computeLatencyPercentiles([]).count, 0);
  assert.equal(medianOfNullable([null, undefined]), null);
  assert.equal(medianOfNullable([10, 30, 20]), 20);
  assert.equal(medianOfNullable([10, 20, 30, 40]), 25);
  assert.equal(p75OfNullable([null]), null);
  assert.equal(p75OfNullable([10, 20, 30, 40]), 30);

  const report = {
    baseURL: 'https://staging.example.internal',
    measuredAt: '2026-11-24T00:00:00.000Z',
    mode: 'all',
    budgetPassed: false,
    violations: [],
    browserMetrics: [
      {
        route: '/dashboard',
        samples: 3,
        ttfbMs: 2000,
        fcpMs: 3000,
        lcpMs: 5000,
        lcpP75Ms: 5200,
        inpMs: 650,
        cls: 0.4,
        domNodes: 6000,
        jsHeapMb: 300,
        duplicateApisCount: 3,
      },
    ],
    apiBenchmark: {
      endpoint: 'https://staging.example.internal/api/health',
      concurrency: 4,
      totalRequests: 20,
      errorRate: 0.1,
      rps: 50,
      minMs: 10,
      p50Ms: 50,
      p75Ms: 80,
      p90Ms: 120,
      p95Ms: 2000,
      p99Ms: 3500,
      maxMs: 4000,
    },
  };

  const evalRes = evaluatePerfBudget(report, undefined, {
    browserSummary: [{ route: '/dashboard', lcpMs: 1000 }],
  });
  assert.equal(evalRes.ok, false);
  assert.equal(evalRes.violations.length, 12);

  const mdZh = buildPerfMarkdown({ ...report, violations: evalRes.violations }, 'zh');
  const mdEn = buildPerfMarkdown({ ...report, budgetPassed: true, violations: [] }, 'en');
  assert.match(mdZh, /TTFB=2000ms/);
  assert.match(mdZh, /Relative Regression/);
  assert.match(mdEn, /satisfy `perf-budget\.json`/);
});

test('trust/intoto detects CI providers, resolves T0/T1/T2 honestly, and binds all 4 subject digests', () => {
  assert.match(describeTrustLevel('T2', 'zh'), /合入级绿灯/);
  assert.match(describeTrustLevel('T1', 'en'), /not a merge-grade green/);
  assert.match(describeTrustLevel('unknown', 'en'), /^T0 —/);

  const gh = detectCiContext({
    GITHUB_ACTIONS: 'true',
    GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_WORKFLOW_REF: 'owner/repo/.github/workflows/ci.yml@refs/heads/main',
    GITHUB_RUN_ID: '12345',
    GITHUB_REF: 'refs/heads/main',
    GITHUB_SHA: 'abc123',
  });
  assert.equal(gh.provider, 'github-actions');
  assert.equal(gh.repository, 'owner/repo');

  const gl = detectCiContext({
    GITLAB_CI: 'true',
    CI_PROJECT_PATH: 'group/proj',
    CI_PIPELINE_ID: '99',
    CI_JOB_ID: '100',
    CI_COMMIT_REF_NAME: 'main',
    CI_COMMIT_SHA: 'def456',
  });
  assert.equal(gl.provider, 'gitlab-ci');
  assert.equal(detectCiContext({ CI: 'true' }).provider, 'generic-ci');
  assert.equal(detectCiContext({}).provider, 'local');

  assert.equal(resolveVerdictTrustTier({ verdict: 'fail', auditTrustTier: 'T1', hasAllFourGates: true }), 'T0');
  assert.equal(resolveVerdictTrustTier({ verdict: 'pass', auditTrustTier: 'T1', scopeDowngraded: true, hasAllFourGates: true }), 'T0');
  assert.equal(resolveVerdictTrustTier({ verdict: 'pass', auditTrustTier: 'T1', hasAllFourGates: true }), 'T1');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-intoto-unit-'));
  try {
    const qaDir = path.join(tmpDir, 'qa');
    fs.mkdirSync(qaDir, { recursive: true });
    const att = buildInTotoVerdictAttestation({
      verdictPayload: { runId: '01TEST', gitSha: 'deadbeef', verdict: 'pass', trustTier: 'T1', gates: {}, counts: {} },
      qaDir,
      repoDir: tmpDir,
      treeDigest: '1111111111111111111111111111111111111111',
      resultsDigest: 'sha256:aaaa',
      lockDigest: 'sha256:bbbb',
      gateKernelVersion: '6.0.0',
    });
    assert.equal(att.subject.length, 4);
    assert.ok(att.statementDigest.startsWith('sha256:'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('upgrade handles missing target/qaDir, stale support file removal, custom stale retention, and human CLI output', async () => {
  assert.equal(await runUpgradeCommand({ lang: 'en' }), 1);
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-upgrade-empty-'));
  try {
    assert.equal(await runUpgradeCommand({ target: emptyDir, lang: 'zh' }), 1);
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-upgrade-stale-'));
  try {
    await runInit({ name: 'stale-test', target: tmpRepo, skipInstall: true, loop: 'none', lang: 'en' });
    const qaDir = path.join(tmpRepo, 'qa');
    const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

    // Seed two stale support files: one matching manifest hash (should REMOVE_STALE), one modified (should KEEP_STALE_CUSTOM)
    const staleClean = path.join(qaDir, 'support', 'legacy-clean.mjs');
    const staleCustom = path.join(qaDir, 'support', 'legacy-custom.mjs');
    fs.writeFileSync(staleClean, '// legacy clean\n', 'utf8');
    fs.writeFileSync(staleCustom, '// user edited\n', 'utf8');
    const crypto = await import('node:crypto');
    const hash = (s) => `sha256:${crypto.createHash('sha256').update(s).digest('hex')}`;
    manifest.files['support/legacy-clean.mjs'] = hash('// legacy clean\n');
    manifest.files['support/legacy-custom.mjs'] = hash('// original stale\n');
    manifest.files['support/already-gone.mjs'] = hash('// gone\n');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');

    // Also modify target-guard.mjs to exercise CONFLICT human output branch
    fs.appendFileSync(path.join(qaDir, 'support', 'target-guard.mjs'), '\n// custom edit\n', 'utf8');
    const res = upgradeQaWorkspace(qaDir, { dryRun: false, force: false, scope: 'kernel' });
    assert.equal(res.actions.some((a) => a.action === 'REMOVE_STALE' && a.file === 'support/legacy-clean.mjs'), true);
    assert.equal(res.actions.some((a) => a.action === 'KEEP_STALE_CUSTOM' && a.file === 'support/legacy-custom.mjs'), true);
    assert.equal(fs.existsSync(staleClean), false);
    assert.equal(fs.existsSync(staleCustom), true);

    // Human-readable output path (with conflict + requiresGovernanceApprove)
    const cliCode = await runUpgradeCommand({ target: tmpRepo, lang: 'en', dryRun: true });
    assert.equal(cliCode, 1);
    const forceCode = await runUpgradeCommand({ target: tmpRepo, lang: 'zh', force: true });
    assert.equal(forceCode, 0);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('executeExploreCrawl (headless mock browser) deduplicates auth redirects, short-circuits redirect storms, and records broken routes', async () => {
  let currentUrl = 'https://staging.example.internal/overview/platform';
  const mockPage = {
    url: () => currentUrl,
    on: () => {},
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    goto: async (dest) => {
      const p = new URL(dest).pathname;
      if (p === '/broken-nav') throw new Error('net::ERR_ABORTED');
      if (p === '/unexpected-redirect') {
        currentUrl = 'https://staging.example.internal/fallback';
        return;
      }
      if (p.startsWith('/protected/') || p === '/overview/platform') {
        currentUrl = 'https://staging.example.internal/login';
        return;
      }
      currentUrl = dest;
    },
    locator: () => ({
      first: () => ({ ariaSnapshot: async () => '- main:\n  - heading "Portal Login" [level=3]' }),
      count: async () => 0,
    }),
    evaluate: async (fn, arg) => {
      const src = String(fn);
      if (src.includes('router.push')) return { usedSpa: false, error: null };
      const pathname = new URL(currentUrl).pathname;
      if (src.includes('authKeyNames')) {
        return {
          actualPath: pathname,
          title: pathname === '/login' ? 'SaaS Login' : 'Public Console',
          breadcrumbs: [],
          tableHeaders: [],
          hasTable: false,
          tableRowCount: 0,
          filterLabels: [],
          buttons: pathname === '/login' ? ['Sign In'] : ['Search'],
          tabs: [],
          hasPasswordInput: pathname === '/login',
          hasChart: false,
          tech: ['Vue', 'Element UI'],
          authKeyNames: ['demo-token'],
          detectedPortals: [],
          anchors: [
            '/broken-nav',
            '/unexpected-redirect',
            '/protected/a',
            '/protected/b',
            '/protected/c',
            '/protected/d',
            '/protected/e',
          ],
          flatFrameworkRoutes: [],
          vueRouteTrees: [],
          a11y: { hasMainLandmark: true, hasH1: false, inputsMissingLabel: 0, imagesMissingAlt: 0 },
        };
      }
      if (src.includes('el-submenu')) return 0;
      if (src.includes('sidebar-logo-container')) return { selector: null, options: [] };
      return arg ?? null;
    },
  };

  const mockBrowser = {
    newContext: async () => ({
      routeWebSocket: async () => {},
      addInitScript: async () => {},
      route: async () => {},
      newPage: async () => mockPage,
    }),
  };

  const topology = await executeExploreCrawl({
    browser: mockBrowser,
    safety: { baseURL: 'https://staging.example.internal/overview/platform' },
    guardConfig: {
      baseURL: 'https://staging.example.internal/overview/platform',
      allowedHosts: ['staging.example.internal'],
      allowedOrigins: [],
      deniedOrigins: [],
      extraEgressHosts: [],
      egressMode: 'allowlist',
      blockedRules: [],
      safePostPaths: [],
      allowGraphqlQuery: true,
      deniedSubstrings: [],
    },
    sessionData: null,
    userAuthPath: path.join(os.tmpdir(), 'nonexistent-user.json'),
    maxPages: 15,
    exploreTabs: false,
    exploreDialogs: false,
    explorePortals: false,
    maxTabsPerPage: 0,
    maxDialogsPerPage: 0,
    maxPortals: 1,
    entryPath: '/overview/platform',
  });

  assert.equal(topology.authRequired, true);
  assert.equal(topology.loginRoute, '/login');
  assert.ok(topology.authRedirectCount >= 4);
  assert.ok(topology.pages.length <= 3, `Expected duplicate login redirects deduplicated, got ${topology.pages.length}`);
  assert.ok(topology.brokenRoutes.some((b) => b.route === '/broken-nav'));
  assert.ok(topology.brokenRoutes.some((b) => b.route === '/unexpected-redirect'));
  assert.deepEqual(topology.techStack, ['Vue', 'Element UI']);
});

test('runReadOnlyApiBenchmark measures concurrency, JSON envelope errors, and non-JSON responses without Chromium', async () => {
  let reqNum = 0;
  const server = http.createServer((req, res) => {
    reqNum += 1;
    if (req.url === '/wrapped-500') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 500, msg: 'wrapped boom' }));
      return;
    }
    if (reqNum % 2 === 0) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, ok: true }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const okRes = await runReadOnlyApiBenchmark(`http://127.0.0.1:${port}/ok`, 2, 4);
    assert.equal(okRes.totalRequests, 4);
    assert.equal(okRes.errorCount, 0);

    const errRes = await runReadOnlyApiBenchmark(`http://127.0.0.1:${port}/wrapped-500`, 2, 3);
    assert.equal(errRes.totalRequests, 3);
    assert.equal(errRes.errorCount, 3);
    assert.equal(errRes.envelopeErrorCount, 3);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
