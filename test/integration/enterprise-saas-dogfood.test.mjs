import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateLoopbackCdpUrl } from '../../src/auth-login.mjs';
import { runCli } from '../../src/cli.mjs';
import { hasPlaywrightChromium } from '../fixtures/playwright-env.mjs';
import {
  MAX_EXPLORE_PAGES,
  createStratifiedRouteQueue,
  detectEnvelopeBusinessError,
  detectUrlQueryAnomalies,
  extractVueDynamicRoutes,
  generateSystemOverviewMarkdown,
  isSafeReadonlyDialogTrigger,
} from '../../src/explore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_MODULES = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa', 'node_modules');

test('detectUrlQueryAnomalies catches both raw and percent-encoded dayjs/object query leaks', () => {
  assert.ok(detectUrlQueryAnomalies('https://gw.test/api?countDate[$L]=en&countDate[$d]=2026').length >= 1);
  assert.ok(detectUrlQueryAnomalies('https://gw.test/api?countDate%5B$L%5D=en&countDate%5b$d%5d=2026').length >= 1);
  assert.ok(detectUrlQueryAnomalies('https://gw.test/api?filter=%5Bobject%20Object%5D').length >= 1);
  assert.ok(detectUrlQueryAnomalies('https://gw.test/api?semesterId=undefined').length >= 1);
  assert.equal(detectUrlQueryAnomalies('https://gw.test/api?pageNo=1&pageSize=10').length, 0);
});

test('detectEnvelopeBusinessError catches wrapped HTTP 200 code 401/403/500 enterprise errors', () => {
  assert.equal(detectEnvelopeBusinessError(200, { code: 0, data: [] }).isError, false);
  assert.equal(detectEnvelopeBusinessError(200, { code: 200, data: { ok: true } }).isError, false);
  const authErr = detectEnvelopeBusinessError(200, { code: 401, msg: '令牌为空,未登陆' });
  assert.equal(authErr.isError, true);
  assert.equal(authErr.code, 401);
  const srvErr = detectEnvelopeBusinessError(200, { code: 500, message: 'Internal failure' });
  assert.equal(srvErr.isError, true);
  assert.equal(srvErr.code, 500);
  assert.equal(detectEnvelopeBusinessError(502, null).isError, true);
});

test('isSafeReadonlyDialogTrigger allows detail/view triggers and rejects mutation labels', () => {
  assert.equal(isSafeReadonlyDialogTrigger('查看'), true);
  assert.equal(isSafeReadonlyDialogTrigger('详情'), true);
  assert.equal(isSafeReadonlyDialogTrigger('明细'), true);
  assert.equal(isSafeReadonlyDialogTrigger('Preview'), true);
  assert.equal(isSafeReadonlyDialogTrigger('Details'), true);
  assert.equal(isSafeReadonlyDialogTrigger('新增'), false);
  assert.equal(isSafeReadonlyDialogTrigger('删除'), false);
  assert.equal(isSafeReadonlyDialogTrigger('修改'), false);
  assert.equal(isSafeReadonlyDialogTrigger('导出'), false);
  assert.equal(isSafeReadonlyDialogTrigger('Delete'), false);
  assert.equal(isSafeReadonlyDialogTrigger('Save'), false);
});

test('createStratifiedRouteQueue round-robins across top-level business domains', () => {
  const q = createStratifiedRouteQueue();
  q.enqueue('/teach/a');
  q.enqueue('/teach/b');
  q.enqueue('/teach/c');
  q.enqueue('/live/x');
  q.enqueue('/finance/y');
  q.enqueue('/teach/a'); // duplicate ignored

  assert.equal(q.size(), 5);
  const firstThree = [q.dequeue(), q.dequeue(), q.dequeue()];
  assert.deepEqual(firstThree, ['/teach/a', '/live/x', '/finance/y']);
  assert.equal(MAX_EXPLORE_PAGES >= 500, true);
});

test('extractVueDynamicRoutes handles nested Vuex permission trees while skipping hidden and dynamic params', () => {
  const routes = extractVueDynamicRoutes([
    [
      { path: '/hidden', hidden: true, children: [{ path: 'secret' }] },
      {
        path: '/teach',
        children: [
          { path: 'classes' },
          { path: 'detail/:id' },
          { path: 'https://external.example.com' },
        ],
      },
      { path: '/finance', children: [{ path: 'orders' }] },
    ],
  ]);
  assert.deepEqual(routes, ['/teach/classes', '/finance/orders']);
});

test('validateLoopbackCdpUrl restricts CDP attach strictly to loopback addresses', () => {
  assert.equal(validateLoopbackCdpUrl('http://127.0.0.1:9222').ok, true);
  assert.equal(validateLoopbackCdpUrl('http://localhost:9222').ok, true);
  assert.equal(validateLoopbackCdpUrl('http://[::1]:9222').ok, true);
  assert.equal(validateLoopbackCdpUrl('http://10.0.0.5:9222').ok, false);
  assert.equal(validateLoopbackCdpUrl('https://remote.example.com:9222').ok, false);
  assert.equal(validateLoopbackCdpUrl('file:///etc/passwd').ok, false);
});

test('generateSystemOverviewMarkdown surfaces broken routes, HTTP 200 envelope errors, dialogs and blocked API hosts', () => {
  const md = generateSystemOverviewMarkdown(
    {
      baseURL: 'https://saas-test.example.internal',
      readOnly: true,
      maxPages: 60,
      portals: [{ name: 'School Portal', mode: 'portal-explored', notes: 'Explored 12 routes' }],
      pages: [
        {
          route: '/students',
          title: 'Students',
          archetype: 'crud-table',
          tableRowCount: 10,
          tabsExplored: ['Active', 'Archived'],
          dialogsExplored: [{ trigger: '详情', title: 'Student Detail' }],
        },
      ],
      brokenRoutes: [{ route: '/device/consume-manage', actualPath: '/device/brand', reason: 'Missing chunk' }],
      envelopeErrors: [{ route: '/students', method: 'GET', endpoint: '/api/students', httpStatus: 200, code: 500, message: 'boom' }],
      blockedApiHosts: ['gw-test.example.internal'],
      endpoints: [],
      consoleErrors: [],
      serverErrors: [],
    },
    'zh'
  );
  assert.match(md, /gw-test\.example\.internal/);
  assert.match(md, /TEST_ALLOWED_HOSTS/);
  assert.match(md, /Broken Route.*\/device\/consume-manage/);
  assert.match(md, /Envelope Code 500/);
  assert.match(md, /Tab `2` 次/);
  assert.match(md, /只读详情弹窗\/抽屉 `1` 次/);
});

test('runExploreCommand deep-explores multi-portal switcher, tabs, read-only dialogs, broken routes, fixed-column rows & envelope errors', async (t) => {
  if (!hasPlaywrightChromium(TEMPLATE_MODULES)) {
    t.skip('Playwright Chromium binary not installed in this environment');
    return;
  }

  let deleteEndpointHit = false;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://127.0.0.1');
    if (u.pathname === '/api/delete-item') {
      deleteEndpointHit = true;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
      return;
    }
    if (u.pathname === '/api/wrapped-error') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 500, msg: 'Wrapped gateway failure' }));
      return;
    }
    if (u.pathname === '/api/tab-data' || u.pathname === '/api/dialog-detail' || u.pathname === '/api/portal-b') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0, data: { ok: true } }));
      return;
    }
    // Serve a realistic multi-portal Vue-like SPA shell
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html>
<html>
<head><title>Enterprise Multi-Portal SaaS</title></head>
<body>
  <div id="app">
    <header>
      <div class="sidebar-logo-container" onclick="openSwitcher()">Platform Console</div>
      <nav id="nav-links"><a href="/platform/list">Platform List</a><a href="/platform/broken">Broken Page</a></nav>
    </header>
    <main class="app-main" id="content">
      <div class="el-tabs">
        <div role="tab" class="el-tabs__item" onclick="switchTab('t1')">概览</div>
        <div role="tab" class="el-tabs__item" onclick="switchTab('t2')">明细统计</div>
      </div>
      <div class="el-table">
        <div class="el-table__body-wrapper"><table><tbody>
          <tr class="el-table__row"><td>Row 1</td><td><button onclick="openDetail()">详情</button><button onclick="dangerDelete()">删除</button></td></tr>
          <tr class="el-table__row"><td>Row 2</td><td><button onclick="openDetail()">详情</button></td></tr>
        </tbody></table></div>
        <div class="el-table__fixed-right"><table><tbody>
          <tr class="el-table__row"><td>Clone 1</td></tr>
          <tr class="el-table__row"><td>Clone 2</td></tr>
        </tbody></table></div>
      </div>
    </main>
    <div id="switcher-drawer" class="el-drawer" style="display:none">
      <button class="el-drawer__close-btn" onclick="closeOverlays()">X</button>
      <div class="item" data-portal="tenant-b" onclick="enterTenantB()">Tenant Workspace B</div>
    </div>
    <div id="detail-dialog" class="el-dialog" style="display:none">
      <button class="el-dialog__headerbtn" onclick="closeOverlays()">X</button>
      <span class="el-dialog__title">记录详情弹窗</span>
      <button onclick="closeOverlays()">关闭</button>
    </div>
  </div>
  <script>
    const state = { portal: 'platform' };
    window.openSwitcher = () => { document.getElementById('switcher-drawer').style.display = 'block'; };
    window.closeOverlays = () => {
      document.getElementById('switcher-drawer').style.display = 'none';
      document.getElementById('detail-dialog').style.display = 'none';
    };
    window.switchTab = (t) => { fetch('/api/tab-data?tab=' + t); };
    window.openDetail = () => {
      fetch('/api/dialog-detail?id=1');
      document.getElementById('detail-dialog').style.display = 'block';
    };
    window.dangerDelete = () => { fetch('/api/delete-item', { method: 'POST' }); };
    window.enterTenantB = () => {
      state.portal = 'tenant-b';
      closeOverlays();
      history.pushState({}, '', '/tenant-b/home');
      document.getElementById('nav-links').innerHTML = '<a href="/tenant-b/home">Tenant Home</a><a href="/tenant-b/orders">Tenant Orders</a>';
      fetch('/api/portal-b');
    };
    // Simulate Vue Router push where /platform/broken fails to change pathname
    document.getElementById('app').__vue__ = {
      $router: {
        options: { routes: [{ path: '/' }, { path: '/platform/list' }, { path: '/platform/broken' }] },
        push(dest) {
          if (dest === '/platform/broken') {
            return Promise.resolve(); // stays stuck on previous pathname!
          }
          history.pushState({}, '', dest);
          if (dest === '/platform/list') fetch('/api/wrapped-error');
          return Promise.resolve();
        }
      },
      $store: {
        state: {
          permission: {
            sidebarRouters: [{ path: '/platform', children: [{ path: 'list' }, { path: 'broken' }] }]
          }
        }
      }
    };
  </script>
</body>
</html>`);
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const baseURL = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-enterprise-explore-'));

  try {
    await runCli(['init', '--name', 'enterprise-mock', '--target', tmpDir, '--skip-install', '--loop', 'none']);
    fs.symlinkSync(TEMPLATE_MODULES, path.join(tmpDir, 'qa', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(
      path.join(tmpDir, 'qa', '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${baseURL}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\nREQUIRE_TEST_TARGET=1\n`,
      'utf8'
    );

    const code = await runCli([
      'explore',
      '--target',
      tmpDir,
      '--base-url',
      baseURL,
      '--max-pages',
      '12',
      '--lang',
      'zh',
    ]);
    assert.equal(code, 0);

    const topology = JSON.parse(fs.readFileSync(path.join(tmpDir, 'qa', 'reports', 'system-topology.json'), 'utf8'));
    assert.equal(deleteEndpointHit, false, 'Read-only explorer must NEVER trigger mutation buttons/APIs');

    // 1. Fixed-column ElementUI table row deduplication: 2 real rows, NOT 4!
    assert.equal(topology.pages[0].tableRowCount, 2);
    // 2. Intra-page tab clicked!
    assert.ok(topology.pages[0].tabsExplored.includes('明细统计'));
    // 3. Safe read-only detail dialog opened & recorded!
    assert.ok(topology.pages[0].dialogsExplored.some((d) => d.trigger === '详情' && d.title === '记录详情弹窗'));
    // 4. Multi-portal switcher discovered AND switched into Tenant Workspace B!
    assert.ok(
      topology.pages.some((p) => p.route === '/tenant-b/home' || p.route === '/tenant-b/orders'),
      `Expected Tenant Workspace B routes to be explored, got: ${JSON.stringify(topology.pages.map((p) => p.route))}`
    );
    // 5. Broken SPA route detected!
    assert.ok(
      topology.brokenRoutes.some((b) => b.route === '/platform/broken'),
      `Expected /platform/broken in brokenRoutes, got: ${JSON.stringify(topology.brokenRoutes)}`
    );
    // 6. Wrapped HTTP 200 code=500 envelope error caught!
    assert.ok(
      topology.envelopeErrors.some((e) => e.code === 500),
      `Expected HTTP 200 code=500 in envelopeErrors, got: ${JSON.stringify(topology.envelopeErrors)}`
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
