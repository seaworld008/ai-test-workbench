import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { CLI_COMMANDS } from '../../src/cli/commands.mjs';
import { runCli } from '../../src/cli.mjs';
import { syncLivingCodeMap } from '../../src/codemap.mjs';
import { extractQueryableTraceId, suggestFailureCategory } from '../../src/diagnose/classifier.mjs';
import { buildObservabilityQueries, selectPrimaryQueryableTraceId } from '../../src/diagnose/observability.mjs';
import { detectBlockedPortalAuthExchange, shouldTripPortalUnauthorizedBreaker } from '../../src/explore/portal-switcher.mjs';
import {
  createStratifiedRouteQueue,
  isNonCrawlableSystemRoute,
  isSuspectedReadQueryPostUrl,
} from '../../src/explore/safety.mjs';
import { computeFlakyReport } from '../../src/flaky.mjs';
import { attemptHealRepair, discardHealSession } from '../../src/heal.mjs';
import { readAndVerifySession, writeHealAttemptLedger, writeSignedSession } from '../../src/heal/store.mjs';
import { computeImpact } from '../../src/impact.mjs';
import { detectHostTooling, detectProjectStack } from '../../src/init.mjs';
import { withWorkspaceWriteLock } from '../../src/jobs/workspace-lock.mjs';
import {
  clearGitRootCache,
  computeWorkspaceInputHash,
  isPathGitIgnored,
  openTrustContext,
  runGitDiffGuard,
  verifyLedgerBindingInQaDir,
} from '../../src/kernel/gate-kernel.mjs';
import { evaluateTargetSafety, shouldAbortThirdPartyRequest } from '../../src/kernel/target-guard.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';
import { getMcpResourceDefinitions, getMcpResourceTemplates } from '../../src/mcp/resources.mjs';
import { getEffectiveAllowedRoots, validateToolPathArgs } from '../../src/mcp/security.mjs';
import { MCP_PRESETS, MCP_PROFILES } from '../../src/mcp-hub/catalog.mjs';
import { distillMemoryProposals } from '../../src/memory/distiller.mjs';
import { runParityCore } from '../../src/parity.mjs';
import { runPerfCommand } from '../../src/perf.mjs';
import { buildSarifReport } from '../../src/verdict/reports.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('WB-P0-01 & partialScope: gitignored QA workspace hashes files (never constant empty hash), skips git semanticDiff safely, and blocks partialScope ledger runs', async () => {
  const parentRepo = makeTempDir('aitest-v640-gitign-');
  try {
    clearGitRootCache();
    execFileSync('git', ['init', '-b', 'main'], { cwd: parentRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd: parentRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'QA Bot'], { cwd: parentRepo, stdio: 'ignore' });
    fs.writeFileSync(path.join(parentRepo, '.gitignore'), '.sandbox/\n', 'utf8');
    fs.writeFileSync(path.join(parentRepo, 'README.md'), '# Host\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: parentRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: parentRepo, stdio: 'ignore' });

    const sandboxTarget = path.join(parentRepo, '.sandbox', 'ws1');
    fs.mkdirSync(sandboxTarget, { recursive: true });
    await runCli(['init', '--name', 'ws1', '--target', sandboxTarget, '--skip-install', '--loop', 'none', '--json']);
    const qaDir = path.join(sandboxTarget, 'qa');

    assert.equal(isPathGitIgnored(qaDir, parentRepo), true);
    const hashBefore = computeWorkspaceInputHash(qaDir);
    assert.notEqual(hashBefore, 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');

    const specPath = path.join(qaDir, 'tests', 'e2e', 'home.spec.ts');
    fs.appendFileSync(specPath, '\n// spec mutation check\n', 'utf8');
    const hashAfter = computeWorkspaceInputHash(qaDir);
    assert.notEqual(hashAfter, hashBefore, 'Mutating a spec inside a gitignored QA dir must change worktreeHash');

    const diffSkipped = runGitDiffGuard(qaDir, 'HEAD', { requireDiff: false });
    assert.equal(diffSkipped.status, 'skipped');
    const diffBlocked = runGitDiffGuard(qaDir, 'HEAD', { requireDiff: true });
    assert.equal(diffBlocked.ok, false);
    assert.equal(diffBlocked.status, 'blocked');

    // partialScope ledger manifest cannot pass full-suite binding verification
    const began = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test single', repoDir: sandboxTarget });
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    const rawResults = {
      config: { metadata: { runId: began.runId } },
      suites: [{ file: 'tests/e2e/home.spec.ts', specs: [{ title: 'ok', line: 3, tests: [{ status: 'expected', results: [] }] }] }],
    };
    fs.writeFileSync(resultsPath, JSON.stringify(rawResults), 'utf8');
    finalizeRunLedger(qaDir, began.runId, { exitCode: 0, resultsPath });

    const trustContext = openTrustContext({ qaDir, repoDir: sandboxTarget, createKeyIfMissing: true });
    const manifestPath = path.join(qaDir, '.aitest', 'runs', began.runId, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.partialScope = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const partialBind = verifyLedgerBindingInQaDir(qaDir, resultsPath, rawResults, {
      currentWorktreeHash: computeWorkspaceInputHash(qaDir),
      trustContext,
    });
    assert.equal(partialBind.ok, false);
    assert.equal(partialBind.status, 'blocked');
  } finally {
    clearGitRootCache();
    fs.rmSync(parentRepo, { recursive: true, force: true });
  }
});

test('WB-P0-02, WB-P1-01 & WB-P1-02: audit CLI checkSpecs default, heal discarded lock, and flaky pre-conclusion exclusion', async () => {
  const tmpRepo = makeTempDir('aitest-v640-heal-flk-');
  try {
    await runCli(['init', '--name', 'heal-app', '--target', tmpRepo, '--skip-install', '--loop', 'none', '--json']);
    const qaDir = path.join(tmpRepo, 'qa');
    const trustContext = openTrustContext({ qaDir, repoDir: tmpRepo, createKeyIfMissing: true });

    // WB-P1-01: CLI audit exposes --no-check-specs so omitting --check-specs keeps undefined (-> true in audit.mjs)
    assert.ok('no-check-specs' in CLI_COMMANDS.audit.options);

    // WB-P1-02: discarded session sets repairPermitted=false and rejects subsequent attemptHealRepair
    const sessionId = 'heal_discard_test_01';
    writeSignedSession(
      qaDir,
      {
        sessionId,
        testId: 'tests/e2e/home.spec.ts::home renders',
        specFile: 'tests/e2e/home.spec.ts',
        categoryCode: 'A',
        state: 'repairing',
        repairPermitted: true,
        attemptCount: 1,
        maxAttempts: 3,
        createdAt: new Date(Date.now() - 10_000).toISOString(),
        updatedAt: new Date(Date.now() - 5_000).toISOString(),
      },
      trustContext
    );
    writeHealAttemptLedger(qaDir, {}, trustContext, [sessionId]);

    const disc = discardHealSession(qaDir, { sessionId, summary: 'abandoned attempt' });
    assert.equal(disc.ok, true);
    const reloadedAfterDiscard = readAndVerifySession(qaDir, sessionId);
    assert.equal(reloadedAfterDiscard.ok, true);
    assert.equal(reloadedAfterDiscard.session.repairPermitted, false);

    const reviveAttempt = await attemptHealRepair(qaDir, { sessionId, skipRun: true });
    assert.equal(reviveAttempt.ok, false);
    assert.match(String(reviveAttempt.error || ''), /discarded/i);

    // Flaky report excludes pre-conclusion failed runs of a verified A-class heal session
    const tId = 'tests/e2e/home.spec.ts::home renders';
    for (let i = 0; i < 2; i += 1) {
      const r = beginRunLedger(qaDir, { suite: 'e2e', command: 'pw', repoDir: tmpRepo });
      const rp = path.join(qaDir, 'reports', 'results.json');
      fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
      fs.writeFileSync(
        rp,
        JSON.stringify({
          config: { metadata: { runId: r.runId } },
          suites: [{ file: 'tests/e2e/home.spec.ts', specs: [{ title: 'home renders', file: 'tests/e2e/home.spec.ts', line: 3, tests: [{ projectName: 'e2e', status: 'unexpected', results: [{ status: 'failed', duration: 50 }] }] }] }],
        }),
        'utf8'
      );
      finalizeRunLedger(qaDir, r.runId, { exitCode: 1, resultsPath: rp });
    }

    const cutoffIso = new Date(Date.now() + 50).toISOString();
    writeSignedSession(
      qaDir,
      {
        sessionId: 'heal_verified_02',
        testId: tId,
        specFile: 'tests/e2e/home.spec.ts',
        categoryCode: 'A',
        state: 'concluded',
        repairPermitted: false,
        attemptCount: 2,
        maxAttempts: 3,
        conclusion: { outcome: 'verified', summary: 'fixed locator' },
        concludedAt: cutoffIso,
        updatedAt: cutoffIso,
      },
      trustContext
    );

    await new Promise((r) => setTimeout(r, 80));
    const rPass = beginRunLedger(qaDir, { suite: 'e2e', command: 'pw', repoDir: tmpRepo });
    const rpPass = path.join(qaDir, 'reports', 'results.json');
    fs.writeFileSync(
      rpPass,
      JSON.stringify({
        config: { metadata: { runId: rPass.runId } },
        suites: [{ file: 'tests/e2e/home.spec.ts', specs: [{ title: 'home renders', file: 'tests/e2e/home.spec.ts', line: 3, tests: [{ projectName: 'e2e', status: 'expected', results: [{ status: 'passed', duration: 40 }] }] }] }],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, rPass.runId, { exitCode: 0, resultsPath: rpPass });

    const flakyReport = computeFlakyReport(qaDir);
    assert.equal(
      flakyReport.flakyCandidates.some((c) => c.testId === tId),
      false,
      'Verified healed test must not be penalized for pre-heal failures'
    );
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('WB-P0-03 & WB-P1-05: parity blocks {code:401}/HTML shell fake-green, injects saved auth token, and validates TEST_ABORT_THIRD_PARTY_HOSTS', async () => {
  // 1. TEST_ABORT_THIRD_PARTY_HOSTS validation
  const okSafety = evaluateTargetSafety({
    TEST_ENV: 'staging',
    TEST_BASE_URL: 'https://portal-staging.example.test',
    TEST_ALLOWED_HOSTS: 'portal-staging.example.test,gw-staging.example.test',
    TEST_ABORT_THIRD_PARTY_HOSTS: 'stats.thirdparty.test',
  });
  assert.equal(okSafety.allowed, true);
  assert.equal(shouldAbortThirdPartyRequest('https://stats.thirdparty.test/collect', okSafety), true);
  assert.equal(shouldAbortThirdPartyRequest('https://gw-staging.example.test/api/ping', okSafety), false);

  const badConflict = evaluateTargetSafety({
    TEST_ENV: 'staging',
    TEST_BASE_URL: 'https://portal-staging.example.test',
    TEST_ALLOWED_HOSTS: 'portal-staging.example.test',
    TEST_ABORT_THIRD_PARTY_HOSTS: 'portal-staging.example.test',
  });
  assert.equal(badConflict.allowed, false);

  const badWildcard = evaluateTargetSafety({
    TEST_ENV: 'local',
    TEST_ABORT_THIRD_PARTY_HOSTS: '*.thirdparty.test',
  });
  assert.equal(badWildcard.allowed, false);

  // 2. Parity {code:401} & HTML shell fail-closed vs authenticated pass
  const tmpRepo = makeTempDir('aitest-v640-parity-');
  const handler = (req, res) => {
    if (req.url === '/admin-api/shell-misrouted') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><body><div id="app"></div></body></html>');
      return;
    }
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer tok_valid_123') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 401, msg: 'Token missing' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { items: [1, 2], tenant: req.headers['platform-id'] || 'none' } }));
  };

  const baseSrv = http.createServer(handler);
  const candSrv = http.createServer(handler);
  await new Promise((r) => baseSrv.listen(0, '127.0.0.1', r));
  await new Promise((r) => candSrv.listen(0, '127.0.0.1', r));
  const basePort = /** @type {import('node:net').AddressInfo} */ (baseSrv.address()).port;
  const candPort = /** @type {import('node:net').AddressInfo} */ (candSrv.address()).port;

  try {
    await runCli(['init', '--name', 'parity-app', '--target', tmpRepo, '--skip-install', '--loop', 'none', '--json']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Without auth -> both return HTTP 200 {code:401} -> MUST block with AUTH_OR_SHELL_INVALID (never 100% PASS!)
    const unauthRes = await runParityCore({
      target: tmpRepo,
      baselineUrl: `http://127.0.0.1:${basePort}`,
      candidateUrl: `http://127.0.0.1:${candPort}`,
      routes: '/admin-api/tenant/list',
    });
    assert.equal(unauthRes.ok, false);
    assert.equal(unauthRes.outcome, 'blocked');
    assert.equal(unauthRes.blockerKind, 'AUTH_OR_SHELL_INVALID');

    // Misrouted API returning HTML SPA shell -> MUST block with AUTH_OR_SHELL_INVALID
    const shellRes = await runParityCore({
      target: tmpRepo,
      baselineUrl: `http://127.0.0.1:${basePort}`,
      candidateUrl: `http://127.0.0.1:${candPort}`,
      routes: '/admin-api/shell-misrouted',
    });
    assert.equal(shellRes.ok, false);
    assert.equal(shellRes.blockerKind, 'AUTH_OR_SHELL_INVALID');

    // Save storageState with ACCESS_TOKEN + PLATFORM_ID -> auto-injected headers -> 100% PASS!
    const authDir = path.join(qaDir, 'playwright', '.auth');
    fs.mkdirSync(authDir, { recursive: true });
    fs.writeFileSync(
      path.join(authDir, 'user.json'),
      JSON.stringify({
        cookies: [],
        origins: [
          {
            origin: `http://127.0.0.1:${candPort}`,
            localStorage: [
              { name: 'ACCESS_TOKEN', value: 'tok_valid_123' },
              { name: 'PLATFORM_ID', value: '88' },
            ],
          },
        ],
      }),
      'utf8'
    );

    const authPass = await runParityCore({
      target: tmpRepo,
      baselineUrl: `http://127.0.0.1:${basePort}`,
      candidateUrl: `http://127.0.0.1:${candPort}`,
      routes: '/admin-api/tenant/list',
    });
    assert.equal(authPass.ok, true);
    assert.equal(authPass.parityPct, 100);
  } finally {
    baseSrv.close();
    candSrv.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('WB-P0-04..WB-P0-09 & WB-P1-03: multi-repo Vue + Spring Cloud CodeMap v4.1 and Diff-Impact v2.1', async () => {
  const rootDir = makeTempDir('aitest-v640-fullstack-');
  const feDir = path.join(rootDir, 'frontend-admin');
  const beDir = path.join(rootDir, 'backend-cloud');
  const qaHost = path.join(rootDir, 'qa-workspace');

  try {
    await runCli(['init', '--name', 'fs-qa', '--target', qaHost, '--skip-install', '--loop', 'none', '--json']);
    const qaDir = path.join(qaHost, 'qa');

    // Build synthetic Vue 2 + Element UI frontend repo
    fs.mkdirSync(path.join(feDir, 'src', 'router'), { recursive: true });
    fs.mkdirSync(path.join(feDir, 'src', 'utils'), { recursive: true });
    fs.mkdirSync(path.join(feDir, 'src', 'api', 'platform'), { recursive: true });
    fs.mkdirSync(path.join(feDir, 'src', 'views', 'platform', 'board', 'child'), { recursive: true });
    fs.mkdirSync(path.join(feDir, 'src', 'views', 'infra', 'build'), { recursive: true });

    fs.writeFileSync(
      path.join(feDir, 'package.json'),
      JSON.stringify({ name: 'frontend-admin', dependencies: { vue: '2.6.14', 'element-ui': '2.15.14' }, devDependencies: { '@vue/cli-service': '5.0.0' } }),
      'utf8'
    );
    fs.writeFileSync(path.join(feDir, '.eslintrc.js'), 'module.exports = {};\n', 'utf8');
    fs.writeFileSync(path.join(feDir, 'jsconfig.json'), '{"compilerOptions":{"baseUrl":"."}}\n', 'utf8');
    fs.writeFileSync(path.join(feDir, 'src', 'permission.js'), `router.beforeEach((to, from, next) => { next({ path: '/' }); });\n`, 'utf8');
    fs.writeFileSync(
      path.join(feDir, 'src', 'router', 'index.js'),
      `export const constantRoutes = [
        {
          path: '/user',
          component: Layout,
          children: [
            { path: 'profile/:dictId(\\\\d+)', component: () => import('@/views/infra/build/index') }
          ]
        }
      ];\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(feDir, 'src', 'utils', 'request.js'),
      `const service = axios.create({ baseURL: process.env.VUE_APP_BASE_API + '/admin-api' }); export default service;\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(feDir, 'src', 'api', 'platform', 'board.js'),
      `import request from '@/utils/request';
       export function getOverview(orgId) { return request({ url: \`/platform-api/board/overview/\${orgId}\`, method: 'get' }); }
       export function getTenantPage() { return request({ url: 'platform-api/system/tenant/page', method: 'get' }); }\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(feDir, 'src', 'views', 'platform', 'board', 'child', 'PanelGroup.vue'),
      `<template><div>KPI</div></template><script>import { getOverview, getTenantPage } from '@/api/platform/board'; export default {};</script>\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(feDir, 'src', 'views', 'platform', 'board', 'index.vue'),
      `<template><PanelGroup /></template><script>import PanelGroup from './child/PanelGroup.vue'; export default { components: { PanelGroup } };</script>\n`,
      'utf8'
    );
    fs.writeFileSync(path.join(feDir, 'src', 'views', 'infra', 'build', 'index.vue'), `<template><div>Form Builder</div></template>\n`, 'utf8');

    // Build synthetic Spring Cloud + MyBatis backend repo
    const javaPkgDir = path.join(beDir, 'module-system', 'src', 'main', 'java', 'com', 'acme', 'controller', 'platform');
    const svcDir = path.join(beDir, 'module-system', 'src', 'main', 'java', 'com', 'acme', 'service');
    const dalDir = path.join(beDir, 'module-system', 'src', 'main', 'java', 'com', 'acme', 'dal');
    const cfgDir = path.join(beDir, 'module-infra', 'src', 'main', 'java', 'com', 'acme', 'config');
    const xmlDir = path.join(beDir, 'module-system', 'src', 'main', 'resources', 'mapper');
    for (const d of [javaPkgDir, svcDir, dalDir, cfgDir, xmlDir]) fs.mkdirSync(d, { recursive: true });

    fs.writeFileSync(
      path.join(beDir, 'pom.xml'),
      `<project><modules><module>module-system</module><module>module-infra</module></modules></project>\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(cfgDir, 'WebConfiguration.java'),
      `package com.acme.config;
       public class WebConfiguration {
         // **.controller.platform.** -> /admin-api/platform-api
         String prefix = "/admin-api/platform-api";
         String pkg = "**.controller.platform.**";
       }\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(javaPkgDir, 'InternalRpcClient.java'),
      `package com.acme.controller.platform;
       @FeignClient(name = "rpc-svc")
       public interface InternalRpcClient { @GetMapping("/rpc/internal/secret") String ping(); }\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(javaPkgDir, 'TenantController.java'),
      `package com.acme.controller.platform;
       import com.acme.service.TenantService;
       @RestController
       @RequestMapping("/system/tenant")
       public class TenantController {
         private TenantService tenantService;
         // @DeleteMapping("/commented-out-danger")
         @GetMapping("/page")
         public Object getTenantPage() { return null; }
       }\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(svcDir, 'TenantService.java'),
      `package com.acme.service; public interface TenantService {}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(svcDir, 'TenantServiceImpl.java'),
      `package com.acme.service;
       import com.acme.dal.TenantMapper;
       import com.acme.dal.TenantDO;
       public class TenantServiceImpl implements TenantService { private TenantMapper mapper; }\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dalDir, 'TenantMapper.java'),
      `package com.acme.dal; public interface TenantMapper {}\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(dalDir, 'TenantDO.java'),
      `package com.acme.dal;
       @TableName("system_tenant")
       public class TenantDO { private Long id; }\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(xmlDir, 'TenantMapper.xml'),
      `<mapper namespace="com.acme.dal.TenantMapper">
         <select id="selectStats">SELECT count(*) FROM system_tenant t LEFT JOIN teach_classes_user u ON u.tenant_id = t.id</select>
       </mapper>\n`,
      'utf8'
    );

    // Seed QA runtime topology + E2E spec with waitForResponse
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(qaDir, 'reports', 'system-topology.json'),
      JSON.stringify({
        pages: [
          {
            route: '/overview/platform',
            component: 'platform/board/index',
            apis: ['GET /admin-api/platform-api/system/tenant/page'],
          },
        ],
        apis: [{ method: 'GET', path: '/admin-api/platform-api/system/tenant/page', statuses: [200] }],
      }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'platform-board.spec.ts'),
      `import { test, expect } from '../fixtures/base';
       test('board overview @critical', async ({ page }) => {
         const respPromise = page.waitForResponse((r) => r.url().includes('/admin-api/platform-api/system/tenant/page'));
         await page.goto('/overview/platform');
         const resp = await respPromise;
         expect(resp.status()).toBe(200);
       });\n`,
      'utf8'
    );

    // Host stack & tooling detection
    const feStacks = detectProjectStack(feDir);
    assert.ok(feStacks.some((s) => /Vue 2/i.test(s)));
    assert.ok(feStacks.some((s) => /Element UI/i.test(s)));
    const feTooling = detectHostTooling(feDir);
    assert.ok(feTooling.eslintConfigs.includes('.eslintrc.js'));
    assert.equal(feTooling.hasJsConfig, true);

    const beTooling = detectHostTooling(beDir);
    assert.ok(beTooling.mavenModules.includes('module-system'));

    // Sync Living CodeMap across BOTH repos
    const mapRes = await syncLivingCodeMap(qaDir, { repos: [feDir, beDir], syncImpact: 'force' });
    assert.ok(fs.existsSync(mapRes.codeMapPath));
    assert.ok(fs.existsSync(mapRes.graphImpactIndexPath));
    const codeMap = JSON.parse(fs.readFileSync(path.join(qaDir, 'knowledge', 'code-map.json'), 'utf8'));

    assert.equal(codeMap.schemaVersion, 5);
    assert.equal(codeMap.meta.sourceRepos.length, 2);
    assert.ok(codeMap.routes['/user/profile/:dictId'], 'Nested + regex-param Vue route must be normalized');
    assert.match(codeMap.routes['/user/profile/:dictId'].frontendFile || '', /src\/views\/infra\/build\/index\.vue$/);

    const boardRoute = codeMap.routes['/overview/platform'];
    assert.ok(boardRoute, 'Dynamic runtime route must exist in code-map');
    assert.match(boardRoute.frontendFile || '', /src\/views\/platform\/board\/index\.vue$/);
    assert.ok(boardRoute.coveringSpecs.includes('tests/e2e/platform-board.spec.ts'));
    assert.ok(
      boardRoute.linkedBackendFiles.some((f) => f.endsWith('TenantController.java')),
      `Expected TenantController.java in linkedBackendFiles, got ${JSON.stringify(boardRoute.linkedBackendFiles)}`
    );
    assert.ok(
      boardRoute.linkedDbTables.includes('system_tenant'),
      `Expected 4-tier DB table system_tenant in linkedDbTables, got ${JSON.stringify(boardRoute.linkedDbTables)}`
    );

    // Ensure codeMap.apis is genuinely populated with TenantController endpoints AND excludes FeignClient / commented-out DeleteMapping / self-duplication
    const allApiKeys = Object.keys(codeMap.apis || {});
    assert.ok(allApiKeys.length > 0, 'Expected populated top-level codeMap.apis in CodeMap v5');
    assert.ok(
      allApiKeys.some((k) => k.includes('/admin-api/platform-api/system/tenant/page')),
      `Expected TenantController prefixed API in codeMap.apis, got ${JSON.stringify(allApiKeys)}`
    );
    assert.equal(allApiKeys.some((k) => k.includes('commented-out-danger')), false);
    assert.equal(allApiKeys.some((k) => k.includes('/rpc/internal/secret')), false);
    assert.equal(allApiKeys.some((k) => k.includes('/system/tenant/system/tenant')), false);

    // Subsequent no-arg syncLivingCodeMap(qaDir) preserves meta.sourceRepos!
    await syncLivingCodeMap(qaDir, { force: true });
    const codeMapReloaded = JSON.parse(fs.readFileSync(path.join(qaDir, 'knowledge', 'code-map.json'), 'utf8'));
    assert.equal(codeMapReloaded.meta.sourceRepos.length, 2);

    // WB-P0-08 & WB-P0-09: Diff-Impact v2.1
    // 1. Intermediate child component PanelGroup.vue aggregates upward to board/index.vue -> platform-board.spec.ts!
    const childImpact = await computeImpact(qaHost, {
      files: ['frontend-admin/src/views/platform/board/child/PanelGroup.vue', '.aitest/.write.lock'],
    });
    assert.equal(childImpact.mode, 'targeted');
    assert.equal(childImpact.downgraded, false);
    assert.ok(childImpact.specs.includes('tests/e2e/platform-board.spec.ts'));

    // 2. Java controller change resolves covering spec via CodeMap!
    const javaImpact = await computeImpact(qaHost, {
      files: ['backend-cloud/module-system/src/main/java/com/acme/controller/platform/TenantController.java'],
    });
    assert.equal(javaImpact.mode, 'targeted');
    assert.ok(javaImpact.specs.includes('tests/e2e/platform-board.spec.ts'));

    // 3. Unmapped file fallback sets downgraded: true
    const fallbackImpact = await computeImpact(qaHost, {
      files: ['frontend-admin/src/unmapped-standalone-util.js'],
    });
    assert.equal(fallbackImpact.mode, 'full');
    assert.equal(fallbackImpact.downgraded, true);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('WB-P0-12 & WB-P1-04..WB-P1-08: workspace lock timeout, explore helpers, VictoriaLogs/sw8 diagnose, perf dryRun, MCP presets/resources, SARIF seam & distiller', async () => {
  const tmpRepo = makeTempDir('aitest-v640-runtime-');
  try {
    await runCli(['init', '--name', 'rt-app', '--target', tmpRepo, '--skip-install', '--loop', 'none', '--json']);
    const qaDir = path.join(tmpRepo, 'qa');

    // 1. WB-P0-12: In-memory queue timeout on withWorkspaceWriteLock throws WORKSPACE_LOCK_BUSY naming active holder
    let releaseFirst;
    const heldPromise = withWorkspaceWriteLock(
      qaDir,
      () => new Promise((resolve) => { releaseFirst = resolve; }),
      5000,
      { toolName: 'aitest_explore', jobId: 'job_holder_99' }
    );
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      () => withWorkspaceWriteLock(qaDir, async () => 'second', 60, { toolName: 'aitest_run' }),
      (/** @type {any} */ err) => {
        assert.equal(err.code, 'WORKSPACE_LOCK_BUSY');
        assert.match(err.message, /job_holder_99|aitest_explore/);
        return true;
      }
    );
    releaseFirst?.('done');
    await heldPromise;

    // 2. WB-P1-04: Explore route filter, stratified queue, safe-POST hint & portal circuit-breaker
    assert.equal(isNonCrawlableSystemRoute('/404'), true);
    assert.equal(isNonCrawlableSystemRoute('/redirect/overview'), true);
    assert.equal(isNonCrawlableSystemRoute('/overview/platform'), false);
    assert.equal(isSuspectedReadQueryPostUrl('https://gw.example.test/admin-api/org/get-org-info'), true);
    assert.equal(isSuspectedReadQueryPostUrl('https://gw.example.test/admin-api/org/delete-org'), false);
    assert.equal(
      detectBlockedPortalAuthExchange([{ method: 'POST', endpoint: 'https://gw.example.test/system/auth/refresh-token' }], 0).tripped,
      true
    );
    assert.equal(
      shouldTripPortalUnauthorizedBreaker({ isPrimaryPortal: false, probedCount: 3, unauthorizedInFirstThree: 3 }),
      true
    );

    const stratified = createStratifiedRouteQueue();
    stratified.enqueue('/system/dict', 'fallback');
    stratified.enqueue('/tenant/school-list', 'secondary');
    stratified.enqueue('/overview/platform', 'primary');
    assert.equal(stratified.dequeue(), '/overview/platform');
    assert.equal(stratified.dequeue(), '/tenant/school-list');
    assert.equal(stratified.dequeue(), '/system/dict');

    // 3. WB-P1-06: Diagnose classifier priority (Schema C over companion blockedRequest), sw8 decode & VictoriaLogs LogsQL
    const cOverB = suggestFailureCategory(
      '[Schema Contract] Expected property "total" to be integer, got null',
      { blockedRequests: ['POST https://stats.example.test/collect (blocked)'] }
    );
    assert.equal(cOverB.categoryCode, 'C');

    const authExp = suggestFailureCategory('HTTP 200 {"code":401,"msg":"令牌为空,未登陆"} via POST /auth/logout');
    assert.ok(authExp.authExpiredHint, 'Expected authExpiredHint on 401/logout failure');

    const b64Tid = Buffer.from('a1b2c3d4e5f60718293a4b5c6d7e8f90.42.1700000000001').toString('base64');
    const sw8Header = `1-${b64Tid}-${Buffer.from('seg').toString('base64')}-0-c3Zj-aW5zdA==-ZW5k-cGVlcg==`;
    const decodedSw8 = extractQueryableTraceId(`sw8: ${sw8Header}`);
    assert.equal(decodedSw8, 'a1b2c3d4e5f60718293a4b5c6d7e8f90.42.1700000000001');

    const rankedTid = selectPrimaryQueryableTraceId(
      ['trace-id: server-real-tid-9988776655443322'],
      '00112233445566778899aabbccddeeff'
    );
    assert.equal(rankedTid, 'server-real-tid-9988776655443322');
    const obsQueries = buildObservabilityQueries(rankedTid);
    assert.ok(obsQueries.victoriaLogsQl.some((q) => q.includes('_msg:"server-real-tid-9988776655443322"')));

    // 4. WB-P1-07: perf --dry-run returns 0 without launching Chromium or hitting invalid port
    const origLog = console.log;
    console.log = () => {};
    try {
      const perfDryCode = await runPerfCommand({
        target: tmpRepo,
        baseUrl: 'http://127.0.0.1:59998',
        routes: '/overview',
        dryRun: true,
        json: true,
      });
      assert.equal(perfDryCode, 0);
    } finally {
      console.log = origLog;
    }

    // 5. MCP roots union, repos[] boundary check, parity-summary resource, enterprise presets, SARIF seam & distiller
    const siblingFe = makeTempDir('aitest-v640-sib-');
    const outsideDir = makeTempDir('aitest-v640-out-');
    try {
      const roots = getEffectiveAllowedRoots({
        workspaceRoots: [tmpRepo, siblingFe],
        clientRoots: [path.join(tmpRepo, 'qa')],
        defaultTarget: tmpRepo,
      });
      assert.equal(validateToolPathArgs({ repos: [siblingFe] }, tmpRepo, roots).ok, true);
      assert.equal(validateToolPathArgs({ repos: [outsideDir] }, tmpRepo, roots).ok, false);
    } finally {
      fs.rmSync(siblingFe, { recursive: true, force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }

    assert.ok(getMcpResourceDefinitions(tmpRepo).some((r) => r.uri.endsWith('/parity-summary')));
    assert.ok(getMcpResourceTemplates().some((t) => t.uriTemplate.endsWith('/parity-summary')));
    for (const preset of ['gitlab', 'mysql', 'victorialogs', 'skywalking']) {
      assert.ok(preset in MCP_PRESETS, `Expected enterprise preset ${preset}`);
      assert.equal(MCP_PRESETS[preset].readonly, true);
    }
    assert.ok(Array.isArray(MCP_PROFILES['enterprise-selfhosted']));
    assert.equal(MCP_PRESETS['ai-test-workbench'].readonly, false);

    const sarif = buildSarifReport({
      verdict: 'pass',
      gateErrors: [],
      failures: [],
      seamReview: {
        s5LiteralShifts: [{ file: 'tests/e2e/a.spec.ts', line: 10, before: '"16"', after: '"23"' }],
        suspectedShortcuts: ['broad regex'],
        expiringWaivers: [{ id: 'W-01', expiresOn: '2026-12-01' }],
      },
    });
    assert.ok(sarif.runs[0].results.some((r) => r.level === 'warning' && /SEAM/.test(r.ruleId)));

    // Verified 3-attempt heal session is NOT miscounted as escalatedHeals in distiller
    const trustContext = openTrustContext({ qaDir, repoDir: tmpRepo, createKeyIfMissing: true });
    writeSignedSession(
      qaDir,
      {
        sessionId: 'heal_3rd_ok',
        testId: 'tests/e2e/a.spec.ts::ok on 3rd try',
        specFile: 'tests/e2e/a.spec.ts',
        categoryCode: 'A',
        state: 'concluded',
        repairPermitted: false,
        attemptCount: 3,
        maxAttempts: 3,
        conclusion: { outcome: 'verified', summary: 'fixed on 3rd attempt' },
      },
      trustContext
    );
    writeHealAttemptLedger(qaDir, {}, trustContext, []);
    const distilled = distillMemoryProposals(qaDir, { dryRun: true });
    assert.equal(distilled.sources.escalatedHeals, 0);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
