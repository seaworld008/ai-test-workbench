import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '../examples/demo-webapp/server.mjs';
import { runCli } from '../src/cli.mjs';
import {
  classifyActionSafety,
  detectPageArchetype,
  generateSystemOverviewMarkdown,
  redactEndpointUrl,
  runExploreCommand,
} from '../src/explore.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_MODULES = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa', 'node_modules');

test('classifyActionSafety distinguishes readonly controls from mutating actions', () => {
  assert.equal(classifyActionSafety('搜索'), 'readonly');
  assert.equal(classifyActionSafety('查询'), 'readonly');
  assert.equal(classifyActionSafety('重置'), 'readonly');
  assert.equal(classifyActionSafety('查看详情'), 'readonly');
  assert.equal(classifyActionSafety('新增'), 'mutation');
  assert.equal(classifyActionSafety('删除'), 'mutation');
  assert.equal(classifyActionSafety('获取验证码'), 'mutation');
  assert.equal(classifyActionSafety('Approve Order'), 'mutation');
  assert.equal(classifyActionSafety(''), 'unknown');
});

test('redactEndpointUrl masks sensitive query params while preserving safe pagination params', () => {
  const dirty = 'https://api.example.internal/v1/auth/session?refreshToken=secret123&mobile=13800138000&pageNo=1&pageSize=10';
  const clean = redactEndpointUrl(dirty);
  assert.equal(clean.includes('secret123'), false);
  assert.equal(clean.includes('13800138000'), false);
  assert.equal(clean.includes('refreshToken=%5BREDACTED%5D'), true);
  assert.equal(clean.includes('mobile=%5BREDACTED%5D'), true);
  assert.equal(clean.includes('pageNo=1'), true);
  assert.equal(clean.includes('pageSize=10'), true);
});

test('detectPageArchetype and generateSystemOverviewMarkdown produce structured Chinese and English atlases', () => {
  assert.equal(detectPageArchetype({ route: '/login', hasPasswordInput: true }), 'auth-portal');
  assert.equal(detectPageArchetype({ route: '/overview/platform', hasChart: true }), 'dashboard');
  assert.equal(detectPageArchetype({ route: '/tenant/list', tableHeaders: ['名称', '操作'] }), 'crud-table');
  assert.equal(detectPageArchetype({ route: '/system-config/setting', filterLabels: ['规则'], buttons: ['编辑'] }), 'form-config');

  const md = generateSystemOverviewMarkdown({
    baseURL: 'https://staging.example.internal',
    exploredAt: '2026-11-23T10:00:00Z',
    readOnly: true,
    maxPages: 25,
    techStack: ['Vue', 'Element UI'],
    authKeyNames: ['ACCESS_TOKEN', 'PLATFORM_ID'],
    portals: [
      { name: 'Platform Console', mode: 'platform', notes: '13 routes' },
      { name: 'Tenant Workspace', mode: 'tenant', id: 101, notes: '24 routes' },
    ],
    pages: [
      {
        route: '/tenant/list',
        breadcrumbs: ['首页', '租户列表'],
        archetype: 'crud-table',
        tableHeaders: ['租户名称', '状态'],
        filterLabels: ['租户名称'],
        readonlyButtons: ['搜索', '重置'],
        mutationButtons: ['新增', '删除'],
        tableRowCount: 10,
        a11y: { hasMainLandmark: false, hasH1: false, inputsMissingLabel: 3 },
      },
    ],
    endpoints: [{ method: 'GET', endpoint: '/api/tenants?pageNo=1', status: 200 }],
    consoleErrors: [],
    serverErrors: [],
  }, 'zh');

  assert.match(md, /系统全景画像与功能测试蓝图/);
  assert.match(md, /Tenant Workspace/);
  assert.match(md, /crud-table/);
  assert.match(md, /\/tenant\/list/);
});

test('runExploreCommand blocks production targets cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-explore-prod-'));
  try {
    await runCli(['init', '--name', 'prod-block', '--target', tmpDir, '--skip-install', '--loop', 'none']);
    fs.symlinkSync(TEMPLATE_MODULES, path.join(tmpDir, 'qa', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(
      path.join(tmpDir, 'qa', '.env'),
      'TEST_ENV=production\nTEST_BASE_URL=https://prod.example.com\nTEST_ALLOWED_HOSTS=prod.example.com\n',
      'utf8'
    );
    const code = await runExploreCommand({ target: tmpDir, lang: 'en' });
    assert.equal(code, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('runExploreCommand crawls demo-webapp read-only and generates system-topology.json + system-overview.md', async (t) => {
  if (!fs.existsSync(path.join(TEMPLATE_MODULES, '@playwright', 'test', 'cli.js'))) {
    t.skip('Template node_modules not installed locally');
    return;
  }

  const demo = await startDemoServer({ port: 0, host: '127.0.0.1' });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-explore-demo-'));
  try {
    const initCode = await runCli(['init', '--name', 'explore-demo', '--target', tmpDir, '--skip-install', '--loop', 'none']);
    assert.equal(initCode, 0);
    fs.symlinkSync(TEMPLATE_MODULES, path.join(tmpDir, 'qa', 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.writeFileSync(
      path.join(tmpDir, 'qa', '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${demo.baseURL}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\nREQUIRE_TEST_TARGET=1\n`,
      'utf8'
    );

    const exploreCode = await runCli([
      'explore',
      '--target',
      tmpDir,
      '--base-url',
      demo.baseURL,
      '--max-pages',
      '5',
      '--lang',
      'zh',
    ]);
    assert.equal(exploreCode, 0);

    const topologyPath = path.join(tmpDir, 'qa', 'reports', 'system-topology.json');
    const overviewPath = path.join(tmpDir, 'qa', 'specs', 'system-overview.md');
    assert.equal(fs.existsSync(topologyPath), true);
    assert.equal(fs.existsSync(overviewPath), true);

    const topology = JSON.parse(fs.readFileSync(topologyPath, 'utf8'));
    assert.equal(topology.readOnly, true);
    assert.ok(topology.pages.length >= 1);
    assert.equal(topology.pages[0].route, '/');

    const overview = fs.readFileSync(overviewPath, 'utf8');
    assert.match(overview, /系统全景画像与功能测试蓝图/);
  } finally {
    await demo.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
