import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { indexRepositorySource } from '../../src/codemap/adapters.mjs';
import { resolveImportCandidate } from '../../src/codemap/registry.mjs';
import { extractFrontendImportsAndApis, skipBalancedAngleBrackets } from '../../src/codemap/vue-api-extractor.mjs';
import { extractVueRouterRoutes, stripJsComments } from '../../src/codemap/vue-extractor.mjs';
import { extractLocalJsStringConsts, extractUrlPrefixHelpers } from '../../src/codemap/vue-template-factory.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRel(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

test('skipBalancedAngleBrackets distinguishes TS generics from comparison operators', () => {
  const simple = "http.request<Result<Foo[]>>('get', '/api/v1/nodes')";
  const simpleIdx = skipBalancedAngleBrackets(simple, simple.indexOf('<'));
  assert.equal(simple[simpleIdx], '(');

  const arrowInType = "defHttp.post<Record<string, (n: number) => void>> ({ url: '/api/items' })";
  const arrowIdx = skipBalancedAngleBrackets(arrowInType, arrowInType.indexOf('<'));
  assert.equal(arrowInType[arrowIdx], '(');

  const objInType = "apiClient<Array<{ id: string; count: number }>>({ url: '/api/metrics', method: 'get' })";
  const objIdx = skipBalancedAngleBrackets(objInType, objInType.indexOf('<'));
  assert.equal(objInType[objIdx], '(');

  const cmpAndCall = '1 < 2 && foo(a > b)';
  assert.equal(skipBalancedAngleBrackets(cmpAndCall, cmpAndCall.indexOf('<')), -1);

  const ifCmp = 'if (a < b) foo(c > d)';
  assert.equal(skipBalancedAngleBrackets(ifCmp, ifCmp.indexOf('<')), -1);

  const multilineCmp = 'const ok = a < b\nfoo(c > d)';
  assert.equal(skipBalancedAngleBrackets(multilineCmp, multilineCmp.indexOf('<')), -1);

  const noParen = 'const flag = a < b + c > d';
  assert.equal(skipBalancedAngleBrackets(noParen, noParen.indexOf('<')), -1);
});

test('extractUrlPrefixHelpers resolves local arrow, function declaration, default param, and const-interpolated helpers', () => {
  const src = stripJsComments(`
    const API_PREFIX: string = '/api/v1/';
    const CLUSTER_PATH = API_PREFIX + 'clusters/';
    const baseUrlApi = (url: string) => \`/api/v1/\${url}\`;
    export function legacyUrlApi(url: string) { return '/api/legacy/' + url; }
    export const withPrefix = (p = '') => \`\${API_PREFIX}\${p}\`;
    export const clusterUrl = (p: string) => \`\${CLUSTER_PATH}\${p}\`;
  `);
  const consts = extractLocalJsStringConsts(src);
  assert.equal(consts.API_PREFIX, '/api/v1/');
  assert.equal(consts.CLUSTER_PATH, '/api/v1/clusters/');

  const helpers = extractUrlPrefixHelpers(src, consts);
  assert.equal(helpers.baseUrlApi, '/api/v1/');
  assert.equal(helpers.legacyUrlApi, '/api/legacy/');
  assert.equal(helpers.withPrefix, '/api/v1/');
  assert.equal(helpers.clusterUrl, '/api/v1/clusters/');
});

test('extractVueRouterRoutes supports single-object modules (satisfies/as/const) and local lazy component bindings while ignoring helper config objects', () => {
  const repoDir = makeTempDir('aitest-v670-vue-router-');
  try {
    writeRel(repoDir, 'src/layout/index.vue', '<template><router-view /></template>\n');
    writeRel(repoDir, 'src/views/alarm/rules.vue', '<template><div>Alarm Rules</div></template>\n');
    writeRel(repoDir, 'src/views/cluster/nodes.vue', '<template><div>Cluster Nodes</div></template>\n');

    const alarmRouterFile = writeRel(
      repoDir,
      'src/router/modules/alarm.ts',
      `const Layout = () => import('@/layout/index.vue');
       const MissingAlarmDetail = () => import('../views/alarm/missingDetail.vue');
       const helperConfig = { path: '/ignored-helper', foo: 1 };
       export default {
         path: '/alarm',
         component: Layout,
         redirect: '/alarm/rules',
         children: [
           { path: 'rules', name: 'AlarmRules', component: () => import('@/views/alarm/rules.vue') },
           { path: 'detail/:id', name: 'AlarmDetail', component: MissingAlarmDetail }
         ]
       } satisfies RouteConfigsTable;\n`
    );

    const clusterRouterFile = writeRel(
      repoDir,
      'src/router/modules/cluster.ts',
      `const NodesView = () => import('../../views/cluster/nodes.vue');
       export const clusterRoute: RouteRecordRaw = {
         path: '/cluster',
         redirect: '/cluster/nodes',
         children: [
           { path: 'nodes', component: NodesView }
         ]
       } as RouteRecordRaw;\n`
    );

    const nonRouterFile = writeRel(
      repoDir,
      'src/utils/menuConfig.ts',
      `export default { path: '/not-a-route', component: () => import('@/views/alarm/rules.vue') };\n`
    );

    const alarmOut = extractVueRouterRoutes({
      filePath: alarmRouterFile,
      relFile: 'src/router/modules/alarm.ts',
      text: fs.readFileSync(alarmRouterFile, 'utf8'),
      repoDir,
      resolveImportCandidate,
    });
    assert.ok(alarmOut.routes.some((r) => r.route === '/alarm' && r.kind === 'router-layout' && r.file === 'src/layout/index.vue'));
    assert.ok(alarmOut.routes.some((r) => r.route === '/alarm/rules' && r.file === 'src/views/alarm/rules.vue'));
    assert.equal(alarmOut.routes.some((r) => r.route === '/ignored-helper'), false, 'Helper object without children/component/redirect must be ignored');
    assert.equal(alarmOut.brokenImports.length, 1);
    assert.equal(alarmOut.brokenImports[0].route, '/alarm/detail/:id');
    assert.equal(alarmOut.brokenImports[0].importSpec, '../views/alarm/missingDetail.vue');

    const clusterOut = extractVueRouterRoutes({
      filePath: clusterRouterFile,
      relFile: 'src/router/modules/cluster.ts',
      text: fs.readFileSync(clusterRouterFile, 'utf8'),
      repoDir,
      resolveImportCandidate,
    });
    assert.ok(clusterOut.routes.some((r) => r.route === '/cluster/nodes' && r.file === 'src/views/cluster/nodes.vue'));

    const nonRouterOut = extractVueRouterRoutes({
      filePath: nonRouterFile,
      relFile: 'src/utils/menuConfig.ts',
      text: fs.readFileSync(nonRouterFile, 'utf8'),
      repoDir,
      resolveImportCandidate,
    });
    assert.equal(nonRouterOut.routes.length, 0, 'Non-router files must not match single-object routes');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('extractFrontendImportsAndApis handles all 4 TS generic HTTP forms, local helpers, .cjs modules, and rejects comparison false positives', () => {
  const repoDir = makeTempDir('aitest-v670-api-patterns-');
  try {
    writeRel(repoDir, 'src/utils/http/client.ts', 'export const customClient = {} as any;\n');
    writeRel(repoDir, 'src/api/prefix.cjs', "exports.baseUrlApi = (u) => '/api/v2/' + u;\n");

    const tsApiFile = writeRel(
      repoDir,
      'src/api/clusterApi.ts',
      `import { customClient as opsClient } from '@/utils/http/client';
       const baseUrlApi = (url: string) => \`/api/v1/\${url}\`;
       const ok = 1 < 2 && foo(a > b);

       export const login = (data: LoginReq): Promise<Result<string>> =>
         http.request<Result<string>>("post", "/api/v1/login", { data });

       export const listNodes = (params?: NodeQuery): Promise<Result<NodeItem[]>> =>
         http.request<Result<NodeItem[]>>("get", baseUrlApi("nodes"), { params });

       export function getItemById<T>(id: string): Promise<PageRes<T>> {
         return http.get<PageRes<T>>('/api/items/' + id);
       }

       export const createItem = (payload: CreateItemReq): Promise<void> =>
         defHttp.post<void>({ url: '/api/items', data: payload });

       export const updateNode = (id: string): Promise<void> =>
         opsClient.patch<void>(\`\${baseUrlApi('nodes')}/\${id}\`);

       export const checkHealth = (): Promise<HealthRes> =>
         apiClient<HealthRes>({ url: '/api/v1/health', method: 'get' });\n`
    );

    const out = extractFrontendImportsAndApis({
      filePath: tsApiFile,
      relFile: 'src/api/clusterApi.ts',
      ext: '.ts',
      text: fs.readFileSync(tsApiFile, 'utf8'),
      repoDir,
      resolveImportCandidate,
    });

    assert.equal(out.apiCalls.length, 6, `Expected 6 deduplicated API calls, got ${JSON.stringify(out.apiCalls)}`);
    assert.ok(out.apiCalls.some((c) => c.method === 'POST' && c.path === '/api/v1/login' && c.fnName === 'login'));
    assert.ok(out.apiCalls.some((c) => c.method === 'GET' && c.path === '/api/v1/nodes' && c.fnName === 'listNodes'));
    assert.ok(out.apiCalls.some((c) => c.method === 'GET' && c.path === '/api/items/:param' && c.fnName === 'getItemById'));
    assert.ok(out.apiCalls.some((c) => c.method === 'POST' && c.path === '/api/items' && c.fnName === 'createItem'));
    assert.ok(out.apiCalls.some((c) => c.method === 'PATCH' && c.path === '/api/v1/nodes/:param' && c.fnName === 'updateNode' && c.clientFile === 'src/utils/http/client.ts'));
    assert.ok(out.apiCalls.some((c) => c.method === 'GET' && c.path === '/api/v1/health' && c.fnName === 'checkHealth'));

    // .cjs support via extractFrontendImportsAndApis
    const cjsFile = writeRel(
      repoDir,
      'src/api/legacy.cjs',
      `const { baseUrlApi } = require('./prefix.cjs');
       exports.fetchNodes = () => http.get(baseUrlApi('nodes'));\n`
    );
    const cjsOut = extractFrontendImportsAndApis({
      filePath: cjsFile,
      relFile: 'src/api/legacy.cjs',
      ext: '.cjs',
      text: fs.readFileSync(cjsFile, 'utf8'),
      repoDir,
      resolveImportCandidate,
      externalPrefixHelpers: { 'src/api/prefix.cjs': { baseUrlApi: '/api/v2/' } },
    });
    assert.equal(cjsOut.apiCalls.length, 1);
    assert.equal(cjsOut.apiCalls[0].path, '/api/v2/nodes');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('indexRepositorySource resolves cross-file URL prefix helpers regardless of file walk order and indexes Vue 3 modular routers', () => {
  const repoDir = makeTempDir('aitest-v670-crossfile-');
  try {
    writeRel(repoDir, 'ops-web/package.json', JSON.stringify({ name: 'ops-web', dependencies: { vue: '3.5.0' } }));
    writeRel(repoDir, 'ops-web/src/layout/index.vue', '<template><router-view /></template>\n');
    writeRel(repoDir, 'ops-web/src/views/cluster/index.vue', '<template><div>Cluster</div></template>\n');
    writeRel(repoDir, 'ops-web/src/utils/http/index.ts', 'export const http = {};\n');

    // API file 'a_cluster.ts' sorts BEFORE helper 'z_prefix.ts' AND constant 'z_const.ts'
    writeRel(
      repoDir,
      'ops-web/src/api/a_cluster.ts',
      `import { http } from '@/utils/http';
       import { baseUrlApi, withPrefix as buildUrl } from './z_prefix';
       import defPrefix from './a_default_prefix';

       export const getNodes = (params?: Record<string, unknown>): Promise<Result<unknown>> =>
         http.request<Result<unknown>>('get', baseUrlApi('nodes'), { params });

       export const createRule = (data: unknown): Promise<Result<unknown>> =>
         http.post<Result<unknown>>(buildUrl('rules'), { data });

       export const getAudit = (): Promise<unknown> =>
         http.get<unknown>(defPrefix('audit'));

       export const getDirect = (): Promise<unknown> =>
         http.get<unknown>('/api/v1/direct');\n`
    );

    // Helper files sorting both before and after a_cluster.ts
    writeRel(
      repoDir,
      'ops-web/src/api/a_default_prefix.ts',
      `export default (url: string) => \`/api/sec/\${url}\`;\n`
    );
    writeRel(
      repoDir,
      'ops-web/src/api/z_prefix.ts',
      `import { V1_PREFIX } from './z_const';
       export const baseUrlApi = (url: string) => \`\${V1_PREFIX}\${url}\`;
       export function withPrefix(p = '') { return '/api/rules/' + p; }\n`
    );
    writeRel(
      repoDir,
      'ops-web/src/api/z_const.ts',
      `export const V1_PREFIX: string = '/api/v1/';\n`
    );
    writeRel(
      repoDir,
      'ops-web/src/api/z_prefix.cjs',
      `exports.cjsPrefix = (u) => '/api/cjs/' + u;\n`
    );
    writeRel(
      repoDir,
      'ops-web/src/api/a_legacy.cjs',
      `const { cjsPrefix } = require('./z_prefix.cjs');\nexports.getLegacy = () => http.get(cjsPrefix('items'));\n`
    );

    // Modular router file with single-object export + lazy Layout
    writeRel(
      repoDir,
      'ops-web/src/router/modules/cluster.ts',
      `const Layout = () => import('@/layout/index.vue');
       export default {
         path: '/cluster',
         component: Layout,
         children: [
           { path: 'index', name: 'ClusterIndex', component: () => import('@/views/cluster/index.vue') }
         ]
       } satisfies RouteConfigsTable;\n`
    );

    const idx = indexRepositorySource(path.join(repoDir, 'ops-web'));
    assert.equal(idx.layoutRoutes['/cluster'], 'src/layout/index.vue');
    assert.ok(idx.frontendRoutes.some((r) => r.route === '/cluster/index' && r.file === 'src/views/cluster/index.vue'));

    const calls = idx.frontendApiCalls.filter((c) => c.file === 'src/api/a_cluster.ts');
    assert.equal(calls.length, 4, `Expected exactly 4 calls (no duplicates), got ${JSON.stringify(calls)}`);
    assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/v1/nodes' && c.fnName === 'getNodes'));
    assert.ok(calls.some((c) => c.method === 'POST' && c.path === '/api/rules/rules' && c.fnName === 'createRule'));
    assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/sec/audit' && c.fnName === 'getAudit'));
    assert.ok(calls.some((c) => c.method === 'GET' && c.path === '/api/v1/direct' && c.fnName === 'getDirect'));
    assert.ok(idx.frontendApiCalls.some((c) => c.file === 'src/api/a_legacy.cjs' && c.path === '/api/cjs/items'));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
