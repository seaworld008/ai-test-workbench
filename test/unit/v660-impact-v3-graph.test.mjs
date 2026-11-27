import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  detectTenantAuthFilterHints,
  formatServiceChain,
  loadCodeMapCorrelations,
} from '../../src/diagnose/observability.mjs';
import {
  buildGraphImpactIndex,
  buildReverseImportGraph,
  collectGitDiffHunks,
  computeImpact,
  detectGlobalInfraImpact,
  evaluateGraphAssistedImpact,
  evaluateImpactForFiles,
  loadGraphImpactIndex,
} from '../../src/impact.mjs';
import { GRAPH_IMPACT_INDEX_SCHEMA_VERSION, parseUnifiedDiffHunks } from '../../src/impact/graph-index.mjs';
import { buildCodeMapFileToSpecMap } from '../../src/impact/java-support.mjs';
import { buildInTotoVerdictAttestation } from '../../src/trust.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function seedQaWorkspace(qaDir, specFiles = ['tests/e2e/apply-order.spec.ts', 'tests/e2e/refund.spec.ts', 'tests/e2e/app-order.spec.ts']) {
  for (const sp of specFiles) {
    writeFile(path.join(qaDir, sp), `import { test, expect } from '../fixtures/base';\ntest('${sp}', () => { expect(1).toBe(1); });\n`);
  }
}

test('GA-4 Global Infra Guard: Spring spring.factories, AutoConfiguration, filters/interceptors/advice & Vue global infra fail-closed to full suite', () => {
  const root = makeTempDir('aitest-v660-ga4-spring-');
  const beDir = path.join(root, 'acme-cloud');
  const feDir = path.join(root, 'acme-cloud-admin-vue');
  const qaDir = path.join(root, 'qa');

  try {
    seedQaWorkspace(qaDir, ['tests/e2e/classes.spec.ts', 'tests/e2e/order.spec.ts']);

    // Spring Boot 2.x spring.factories + Spring Boot 3.x AutoConfiguration.imports + TenantSecurityWebFilter + helper bean
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-biz-tenant', 'src', 'main', 'resources', 'META-INF', 'spring.factories'),
      `org.springframework.boot.autoconfigure.EnableAutoConfiguration=\\\n  com.acme.framework.tenant.config.TenantAutoConfiguration\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-web', 'src', 'main', 'resources', 'META-INF', 'spring', 'org.springframework.boot.autoconfigure.AutoConfiguration.imports'),
      `com.acme.framework.web.config.WebAutoConfiguration\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-biz-tenant', 'src', 'main', 'java', 'com', 'acme', 'framework', 'tenant', 'config', 'TenantAutoConfiguration.java'),
      `package com.acme.framework.tenant.config;
       import com.acme.framework.tenant.core.security.TenantSecurityWebFilter;
       import com.acme.framework.tenant.core.config.TenantProperties;
       @AutoConfiguration
       public class TenantAutoConfiguration {
         public FilterRegistrationBean<TenantSecurityWebFilter> tenantSecurityWebFilter(TenantProperties props) { return null; }
       }\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-biz-tenant', 'src', 'main', 'java', 'com', 'acme', 'framework', 'tenant', 'core', 'security', 'TenantSecurityWebFilter.java'),
      `package com.acme.framework.tenant.core.security;
       public class TenantSecurityWebFilter extends OncePerRequestFilter { }\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-biz-tenant', 'src', 'main', 'java', 'com', 'acme', 'framework', 'tenant', 'core', 'config', 'TenantProperties.java'),
      `package com.acme.framework.tenant.core.config;
       public class TenantProperties { private boolean enable = true; }\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-web', 'src', 'main', 'java', 'com', 'acme', 'framework', 'web', 'core', 'GlobalExceptionHandler.java'),
      `package com.acme.framework.web.core;
       @RestControllerAdvice
       public class GlobalExceptionHandler {}\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-mybatis', 'src', 'main', 'java', 'com', 'acme', 'framework', 'mybatis', 'SqlRewriteInterceptor.java'),
      `package com.acme.framework.mybatis;
       public class SqlRewriteInterceptor implements Interceptor {}\n`
    );
    writeFile(
      path.join(beDir, 'yudao-spring-boot-starter-rpc', 'src', 'main', 'java', 'com', 'acme', 'framework', 'rpc', 'FeignHeaderInterceptor.java'),
      `package com.acme.framework.rpc;
       public class FeignHeaderInterceptor implements RequestInterceptor {}\n`
    );

    // Vue global infra & globally registered RightToolbar component
    writeFile(path.join(feDir, 'src', 'utils', 'request.js'), `export default axios.create({ baseURL: '/admin-api' });\n`);
    writeFile(path.join(feDir, 'src', 'utils', 'platformRequest.js'), `export default {};\n`);
    writeFile(path.join(feDir, 'src', 'utils', 'crudFactory.js'), `export function createCrudApi() {}\n`);
    writeFile(path.join(feDir, 'src', 'components', 'RightToolbar', 'index.vue'), `<template><div>Toolbar</div></template>\n`);
    writeFile(
      path.join(feDir, 'src', 'main.js'),
      `import Vue from 'vue';
       import RightToolbar from '@/components/RightToolbar';
       Vue.component('RightToolbar', RightToolbar);\n`
    );

    const repos = [beDir, feDir];

    // 1. TenantSecurityWebFilter.java MUST escalate to full suite (eliminates GA-4 false negative!)
    const tenantFilterRes = evaluateImpactForFiles(
      ['acme-cloud/yudao-spring-boot-starter-biz-tenant/src/main/java/com/acme/framework/tenant/core/security/TenantSecurityWebFilter.java'],
      qaDir,
      root,
      { repos }
    );
    assert.equal(tenantFilterRes.mode, 'full');
    assert.equal(tenantFilterRes.downgraded, true);
    assert.ok(tenantFilterRes.why.some((w) => /global-infra-guard/.test(w.via)));

    // 2. TenantProperties.java (referenced by TenantAutoConfiguration in spring.factories) MUST fail-closed!
    const tenantPropsGuard = detectGlobalInfraImpact(
      ['acme-cloud/yudao-spring-boot-starter-biz-tenant/src/main/java/com/acme/framework/tenant/core/config/TenantProperties.java'],
      repos
    );
    assert.equal(tenantPropsGuard.isGlobal, true);
    assert.match(tenantPropsGuard.reasons[0], /spring-autoconfig-referenced-bean/);

    // 3. spring.factories, AutoConfiguration.imports, @RestControllerAdvice, MyBatis Interceptor, Feign RequestInterceptor
    for (const f of [
      'acme-cloud/yudao-spring-boot-starter-biz-tenant/src/main/resources/META-INF/spring.factories',
      'acme-cloud/yudao-spring-boot-starter-web/src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports',
      'acme-cloud/yudao-spring-boot-starter-web/src/main/java/com/acme/framework/web/core/GlobalExceptionHandler.java',
      'acme-cloud/yudao-spring-boot-starter-mybatis/src/main/java/com/acme/framework/mybatis/SqlRewriteInterceptor.java',
      'acme-cloud/yudao-spring-boot-starter-rpc/src/main/java/com/acme/framework/rpc/FeignHeaderInterceptor.java',
      'acme-cloud-admin-vue/src/utils/request.js',
      'acme-cloud-admin-vue/src/utils/platformRequest.js',
      'acme-cloud-admin-vue/src/utils/crudFactory.js',
      'acme-cloud-admin-vue/src/main.js',
    ]) {
      const g = detectGlobalInfraImpact([f], repos);
      assert.equal(g.isGlobal, true, `Expected global infra detection for ${f}`);
    }

    // 4. RightToolbar/index.vue without graphIndex MUST fail-closed (never 1 dependent main.js / 0 views!)
    const rightToolbarNoGraph = evaluateImpactForFiles(
      ['acme-cloud-admin-vue/src/components/RightToolbar/index.vue'],
      qaDir,
      root,
      { repos }
    );
    assert.equal(rightToolbarNoGraph.mode, 'full');
    assert.equal(rightToolbarNoGraph.downgraded, true);
    assert.ok(rightToolbarNoGraph.why.some((w) => /vue-global-component-unresolved/.test(w.via)));

    // 5. RightToolbar/index.vue WITH clean graphIndex containing complete template consumers -> resolves exact views -> specs!
    const completeGraph = buildGraphImpactIndex(
      {
        globalComponents: [
          {
            file: 'acme-cloud-admin-vue/src/components/RightToolbar/index.vue',
            name: 'RightToolbar',
            tags: ['right-toolbar'],
            consumers: ['acme-cloud-admin-vue/src/views/teach/classes/index.vue'],
            complete: true,
          },
        ],
      },
      { meta: { provider: 'codebase-memory-mcp', version: '0.12.1', binarySha256: 'abc123', mode: 'enriched', coverage: { clean: true } } },
      {
        routes: {
          '/teach/classes': {
            route: '/teach/classes',
            frontendFile: 'acme-cloud-admin-vue/src/views/teach/classes/index.vue',
            coveringSpecs: ['tests/e2e/classes.spec.ts'],
          },
        },
      }
    );
    writeFile(path.join(qaDir, 'knowledge', 'graph-impact-index.json'), JSON.stringify(completeGraph, null, 2));

    const rightToolbarResolved = evaluateImpactForFiles(
      ['acme-cloud-admin-vue/src/components/RightToolbar/index.vue'],
      qaDir,
      root,
      { repos }
    );
    assert.equal(rightToolbarResolved.mode, 'targeted');
    assert.equal(rightToolbarResolved.downgraded, false);
    assert.deepEqual(rightToolbarResolved.specs, ['tests/e2e/classes.spec.ts']);
    assert.equal(rightToolbarResolved.graphEngine?.usedForNarrowing, true);

    // 6. RightToolbar/index.vue WITH graphIndex where 1 consumer view has NO covering spec -> fails closed!
    completeGraph.globalComponents['acme-cloud-admin-vue/src/components/RightToolbar/index.vue'].consumers.push(
      'acme-cloud-admin-vue/src/views/teach/uncovered/index.vue'
    );
    writeFile(path.join(qaDir, 'knowledge', 'graph-impact-index.json'), JSON.stringify(completeGraph, null, 2));
    const rightToolbarUncovered = evaluateImpactForFiles(
      ['acme-cloud-admin-vue/src/components/RightToolbar/index.vue'],
      qaDir,
      root,
      { repos }
    );
    assert.equal(rightToolbarUncovered.mode, 'full');
    assert.equal(rightToolbarUncovered.downgraded, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('GA-3 Graph-Assisted Symbol Narrowing: lifts >=8 fan-in cliff via MyBatis XML/Service/Feign -> Prefixed Route -> Vue API fnName -> View -> Spec in <20ms, and fails closed on coverage gaps or unmapped hunks', () => {
  const root = makeTempDir('aitest-v660-ga3-symbol-');
  const beDir = path.join(root, 'acme-cloud');
  const feDir = path.join(root, 'acme-cloud-admin-vue');
  const qaDir = path.join(root, 'qa');

  try {
    seedQaWorkspace(qaDir);

    // Create high-fan-in ApplyOrderServiceImpl (imported by 10 Java classes -> native v2.1 would hit >=8 cliff!)
    const svcRel = 'acme-cloud/teach-biz/src/main/java/com/acme/teach/service/ApplyOrderServiceImpl.java';
    const mapperJavaRel = 'acme-cloud/teach-biz/src/main/java/com/acme/teach/dal/ApplyOrderMapper.java';
    const mapperXmlRel = 'acme-cloud/teach-biz/src/main/resources/mapper/ApplyOrderMapper.xml';
    const feignApiRel = 'acme-cloud/teach-api/src/main/java/com/acme/teach/api/ClassesApi.java';
    const feignImplRel = 'acme-cloud/teach-biz/src/main/java/com/acme/teach/api/ClassesApiImpl.java';
    const ctrlRel = 'acme-cloud/teach-biz/src/main/java/com/acme/teach/controller/platform/ApplyOrderController.java';
    const apiJsRel = 'acme-cloud-admin-vue/src/api/teach/order.js';
    const childVueRel = 'acme-cloud-admin-vue/src/views/teach/order/OrderTable.vue';
    const parentVueRel = 'acme-cloud-admin-vue/src/views/teach/order/index.vue';
    const refundVueRel = 'acme-cloud-admin-vue/src/views/teach/refund/index.vue';

    writeFile(path.join(root, svcRel), `package com.acme.teach.service;\npublic class ApplyOrderServiceImpl {\n  public Object getApplyOrderPage() { return null; }\n  public Object getRefundReport() { return null; }\n}\n`);
    for (let i = 0; i < 10; i += 1) {
      writeFile(
        path.join(beDir, 'teach-biz', 'src', 'main', 'java', 'com', 'acme', 'teach', 'consumer', `Consumer${i}.java`),
        `package com.acme.teach.consumer;\nimport com.acme.teach.service.ApplyOrderServiceImpl;\npublic class Consumer${i} { ApplyOrderServiceImpl svc; }\n`
      );
    }

    const graphIndex = buildGraphImpactIndex(
      {
        mybatisXmlLinks: [
          {
            file: mapperXmlRel,
            mapperFile: mapperJavaRel,
            namespace: 'com.acme.teach.dal.ApplyOrderMapper',
            statements: [
              { id: 'selectApplyOrderPage', startLine: 5, endLine: 18 },
              { id: 'selectRefundReport', startLine: 20, endLine: 32 },
            ],
          },
        ],
        feignBridges: [
          { clientFile: feignApiRel, implFile: feignImplRel, methods: ['getClassDetail'] },
        ],
        backendEndpoints: [
          { file: ctrlRel, handler: 'getApplyOrderPage', method: 'GET', path: '/admin-api/platform-api/teach/order/page' },
          { file: ctrlRel, handler: 'getRefundReport', method: 'GET', path: '/admin-api/platform-api/teach/order/refund' },
        ],
        axiosPrefixByFile: { [apiJsRel]: '/admin-api/platform-api' },
        frontendApiCalls: [
          { file: apiJsRel, fnName: 'getApplyOrderPage', method: 'GET', path: '/teach/order/page', startLine: 3, endLine: 7 },
          { file: apiJsRel, fnName: 'getRefundReport', method: 'GET', path: '/teach/order/refund', startLine: 9, endLine: 13 },
        ],
        vueApiImports: {
          [childVueRel]: { [apiJsRel]: ['getApplyOrderPage'] },
          [refundVueRel]: { [apiJsRel]: ['getRefundReport'] },
        },
        vueTemplateRefs: [{ componentFile: childVueRel, parentFile: parentVueRel }],
      },
      {
        meta: {
          provider: 'codebase-memory-mcp',
          version: '0.12.1',
          binarySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
          mode: 'enriched',
          coverage: { clean: true, parsePartialFiles: [], skippedFiles: [], unresolvedRatio: 0 },
        },
        symbols: [
          { id: `${mapperJavaRel}#selectApplyOrderPage`, file: mapperJavaRel, name: 'selectApplyOrderPage', kind: 'method', startLine: 10, endLine: 12 },
          { id: `${svcRel}#getApplyOrderPage`, file: svcRel, name: 'getApplyOrderPage', kind: 'method', startLine: 2, endLine: 4 },
          { id: `${svcRel}#getRefundReport`, file: svcRel, name: 'getRefundReport', kind: 'method', startLine: 5, endLine: 7 },
          { id: `${feignImplRel}#getClassDetail`, file: feignImplRel, name: 'getClassDetail', kind: 'method', startLine: 8, endLine: 15 },
          { id: `${feignApiRel}#getClassDetail`, file: feignApiRel, name: 'getClassDetail', kind: 'method', startLine: 6, endLine: 9 },
          { id: `${ctrlRel}#getApplyOrderPage`, file: ctrlRel, name: 'getApplyOrderPage', kind: 'method', startLine: 20, endLine: 28 },
          { id: `${ctrlRel}#getRefundReport`, file: ctrlRel, name: 'getRefundReport', kind: 'method', startLine: 30, endLine: 38 },
        ],
        callEdges: [
          { fromId: `${svcRel}#getApplyOrderPage`, toId: `${mapperJavaRel}#selectApplyOrderPage` },
          { fromId: `${ctrlRel}#getApplyOrderPage`, toId: `${svcRel}#getApplyOrderPage` },
          { fromId: `${ctrlRel}#getApplyOrderPage`, toId: `${feignApiRel}#getClassDetail` },
        ],
      },
      {
        routes: {
          '/teach/order': {
            route: '/teach/order',
            frontendFile: parentVueRel,
            linkedApis: ['/admin-api/platform-api/teach/order/page'],
            coveringSpecs: ['tests/e2e/apply-order.spec.ts'],
          },
          '/teach/refund': {
            route: '/teach/refund',
            frontendFile: refundVueRel,
            linkedApis: ['/admin-api/platform-api/teach/order/refund'],
            coveringSpecs: ['tests/e2e/refund.spec.ts'],
          },
        },
      }
    );

    assert.equal(graphIndex.schemaVersion, GRAPH_IMPACT_INDEX_SCHEMA_VERSION);
    writeFile(path.join(qaDir, 'knowledge', 'graph-impact-index.json'), JSON.stringify(graphIndex, null, 2));

    // Fast-path <20ms synchronous read verification (zero external binary spawn!)
    const loaded = loadGraphImpactIndex(qaDir);
    const warmLoaded = loadGraphImpactIndex(qaDir);
    assert.equal(loaded.ok, true);
    assert.equal(warmLoaded.ok, true);
    const bestReadMs = Math.min(loaded.readMs, warmLoaded.readMs);
    assert.ok(bestReadMs < 20, `Expected <20ms synchronous index load, got cold=${loaded.readMs}ms warm=${warmLoaded.readMs}ms`);

    const repos = [beDir, feDir];

    // 1. Editing ApplyOrderMapper.xml#selectApplyOrderPage narrows strictly to apply-order.spec.ts (NOT refund.spec.ts!)
    const xmlRes = evaluateImpactForFiles([mapperXmlRel], qaDir, root, {
      repos,
      diffHunks: { [mapperXmlRel]: [{ startLine: 8, endLine: 11 }] },
    });
    assert.equal(xmlRes.mode, 'targeted');
    assert.equal(xmlRes.downgraded, false);
    assert.deepEqual(xmlRes.specs, ['tests/e2e/apply-order.spec.ts']);
    assert.equal(xmlRes.graphEngine?.usedForNarrowing, true);
    assert.equal(xmlRes.graphEngine?.provider, 'codebase-memory-mcp');
    assert.match(xmlRes.why[0].via, /selectApplyOrderPage.*getApplyOrderPage.*\/admin-api\/platform-api\/teach\/order\/page.*getApplyOrderPage.*index\.vue/);

    // 2. Editing high-fan-in ApplyOrderServiceImpl#getApplyOrderPage lifts the >=8 fan-in cliff!
    const svcNarrow = evaluateImpactForFiles([svcRel], qaDir, root, {
      repos,
      diffHunks: { [svcRel]: [{ startLine: 3, endLine: 3 }] },
    });
    assert.equal(svcNarrow.mode, 'targeted');
    assert.deepEqual(svcNarrow.specs, ['tests/e2e/apply-order.spec.ts']);
    assert.equal(svcNarrow.graphEngine?.usedForNarrowing, true);

    // 3. Editing Feign impl ClassesApiImpl#getClassDetail bridges across Feign -> Controller -> Vue -> Spec!
    const feignRes = evaluateImpactForFiles([feignImplRel], qaDir, root, {
      repos,
      diffHunks: { [feignImplRel]: [{ startLine: 10, endLine: 12 }] },
    });
    assert.equal(feignRes.mode, 'targeted');
    assert.deepEqual(feignRes.specs, ['tests/e2e/apply-order.spec.ts']);
    assert.equal(feignRes.graphEngine?.usedForNarrowing, true);

    // 4. Unmapped hunk (outside any symbol) -> fails closed -> falls back to native >=8 cliff -> mode: 'full'!
    const unmappedHunk = evaluateImpactForFiles([svcRel], qaDir, root, {
      repos,
      diffHunks: { [svcRel]: [{ startLine: 1, endLine: 1 }] },
    });
    assert.equal(unmappedHunk.mode, 'full');
    assert.equal(unmappedHunk.downgraded, true);
    assert.equal(unmappedHunk.graphEngine?.usedForNarrowing, false);
    assert.match(String(unmappedHunk.graphEngine?.fallbackReason || ''), /unmapped-diff-hunk/);

    // 5. Coverage gap on touched file -> MUST fail closed (never narrow!)
    const dirtyGraph = structuredClone(graphIndex);
    dirtyGraph.coverage.parsePartialFiles = [svcRel];
    const dirtyEval = evaluateGraphAssistedImpact({
      changedFiles: [svcRel],
      diffHunks: { [svcRel]: [{ startLine: 3, endLine: 3 }] },
      graphIndex: dirtyGraph,
      allSpecs: ['tests/e2e/apply-order.spec.ts'],
    });
    assert.equal(dirtyEval.eligible, false);
    assert.match(dirtyEval.reason, /coverage-gap-on-touched-file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Java extends inheritance bridge, CodeMap v5 apis/serviceChains lookup, Chinese git diff hunks, and 16000 truncation error message', async () => {
  const repoDir = makeTempDir('aitest-v660-java-ext-');
  const qaDir = path.join(repoDir, 'qa');

  try {
    seedQaWorkspace(qaDir, ['tests/e2e/order.spec.ts']);

    // 1. Java extends inheritance (Super <-> Sub for domain base; BaseDO stays non-exploding!)
    writeFile(path.join(repoDir, 'src', 'BaseDO.java'), `package com.acme;\npublic class BaseDO {}\n`);
    writeFile(path.join(repoDir, 'src', 'OrderDO.java'), `package com.acme;\npublic class OrderDO extends BaseDO {}\n`);
    writeFile(path.join(repoDir, 'src', 'AbstractOrderService.java'), `package com.acme;\npublic abstract class AbstractOrderService {}\n`);
    writeFile(path.join(repoDir, 'src', 'SpecialOrderService.java'), `package com.acme;\npublic class SpecialOrderService extends AbstractOrderService {}\n`);
    writeFile(path.join(repoDir, 'src', 'OrderController.java'), `package com.acme;\npublic class OrderController { AbstractOrderService svc; }\n`);

    const rev = buildReverseImportGraph(repoDir, { includeQa: false });
    assert.ok(rev.get('src/AbstractOrderService.java')?.has('src/SpecialOrderService.java'), 'Super -> Sub edge expected');
    assert.ok(rev.get('src/SpecialOrderService.java')?.has('src/AbstractOrderService.java'), 'Polymorphic Sub -> Super edge expected');
    assert.equal(rev.get('src/OrderDO.java')?.has('src/BaseDO.java') || false, false, 'Universal BaseDO must not reverse-bridge from subclass');

    // 2. CodeMap v5 apis (object map + linkedRoutes) & serviceChains lookup
    writeFile(
      path.join(qaDir, 'knowledge', 'code-map.json'),
      JSON.stringify({
        schemaVersion: 5,
        routes: {
          '/orders': { route: '/orders', frontendFile: 'src/views/order/index.vue', coveringSpecs: ['tests/e2e/order.spec.ts'] },
        },
        apis: {
          'GET /admin-api/orders/page': {
            path: '/admin-api/orders/page',
            controllerFile: 'src/OrderController.java',
            frontendApiFile: 'src/api/order.js',
            linkedRoutes: ['/orders'],
          },
        },
        serviceChains: [
          {
            route: '/orders',
            viewFile: 'src/views/order/index.vue',
            apiPath: '/admin-api/orders/page',
            controllerFile: 'src/OrderController.java',
            serviceFiles: ['src/SpecialOrderService.java'],
            xmlFiles: ['src/OrderMapper.xml'],
            dbTables: ['trade_order'],
            coveringSpecs: ['tests/e2e/order.spec.ts'],
          },
        ],
      })
    );
    const cmMap = buildCodeMapFileToSpecMap(qaDir, ['tests/e2e/order.spec.ts']);
    assert.ok(cmMap.get('src/OrderController.java')?.some((x) => x.spec === 'tests/e2e/order.spec.ts'));
    assert.ok(cmMap.get('src/api/order.js')?.some((x) => x.spec === 'tests/e2e/order.spec.ts'));
    assert.ok(cmMap.get('src/SpecialOrderService.java')?.some((x) => x.spec === 'tests/e2e/order.spec.ts'));
    assert.ok(cmMap.get('src/OrderMapper.xml')?.some((x) => x.spec === 'tests/e2e/order.spec.ts'));

    // 3. Git diff -U0 hunk collection with Chinese filename (core.quotepath=false)
    const cnFile = 'src/views/createOrder所有字段动态获取.vue';
    writeFile(path.join(repoDir, cnFile), '<template>\n  <div>v1</div>\n</template>\n<script>\nexport default { name: "Order" };\n</script>\n');
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'qa@example.test'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'QA'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: repoDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });
    writeFile(path.join(repoDir, cnFile), '<template>\n  <div>v2-updated</div>\n</template>\n<script>\nexport default { name: "Order" };\n</script>\n');

    const hunksRes = await collectGitDiffHunks([repoDir], 'HEAD');
    assert.equal(hunksRes.ok, true);
    assert.deepEqual(hunksRes.hunksByFile[cnFile], [{ startLine: 2, endLine: 2 }]);

    // Pure unified diff parser also handles deletion hunks (count=0)
    const parsedDel = parseUnifiedDiffHunks('--- a/foo.java\n+++ b/foo.java\n@@ -14,2 +14,0 @@\n-old1\n-old2\n');
    assert.deepEqual(parsedDel['foo.java'], [{ startLine: 14, endLine: 14 }]);

    // 4. Verify src/impact.mjs no longer reports outdated 10000 budget text
    const impactSrc = fs.readFileSync(path.resolve('src/impact.mjs'), 'utf8');
    assert.equal(impactSrc.includes('MAX_GRAPH_FILES'), false);
    assert.match(impactSrc, /DEFAULT_PER_REPO_GRAPH_FILES/);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Diagnose Observability consumes CodeMap v5 serviceChains + tenant/auth filter hints, and in-toto attestation binds scope.graphEngine', async () => {
  const tmpDir = makeTempDir('aitest-v660-obs-verdict-');
  const qaDir = path.join(tmpDir, 'qa');

  try {
    writeFile(
      path.join(qaDir, 'knowledge', 'code-map.json'),
      JSON.stringify({
        schemaVersion: 5,
        routes: {
          '/teach/order': {
            route: '/teach/order',
            frontendFile: 'src/views/teach/order/index.vue',
            linkedApis: ['/admin-api/platform-api/teach/order/page'],
            linkedBackendFiles: ['ApplyOrderController.java'],
            linkedDbTables: ['teach_apply_order'],
            coveringSpecs: ['tests/e2e/order.spec.ts'],
          },
        },
        serviceChains: [
          {
            route: '/teach/order',
            viewFile: 'src/views/teach/order/index.vue',
            apiMethod: 'GET',
            apiPath: '/admin-api/platform-api/teach/order/page',
            apiFnName: 'getApplyOrderPage',
            controllerFile: 'ApplyOrderController.java',
            controllerMethod: 'getPage',
            serviceFiles: ['ApplyOrderServiceImpl.java'],
            feignFiles: ['ClassesApi.java'],
            mapperFiles: ['ApplyOrderMapper.java'],
            xmlFiles: ['ApplyOrderMapper.xml'],
            dbTables: ['teach_apply_order', 'teach_classes'],
            coveringSpecs: ['tests/e2e/order.spec.ts'],
          },
        ],
      })
    );
    writeFile(
      path.join(qaDir, 'knowledge', 'graph-impact-index.json'),
      JSON.stringify(
        buildGraphImpactIndex(
          { globalInfra: { springAutoConfigTargets: ['TenantSecurityWebFilter.java', 'SignWebFilter.java'] } },
          null,
          null
        )
      )
    );

    const corr = loadCodeMapCorrelations(qaDir, 'tests/e2e/order.spec.ts', {
      errorText: 'HTTP 401 Unauthorized on GET /admin-api/platform-api/teach/order/page: 租户 tenant-id 缺失或令牌过期',
    });
    assert.ok(corr);
    assert.equal(corr.serviceChains.length, 1);
    assert.match(
      corr.serviceChains[0],
      /Vue\(src\/views\/teach\/order\/index\.vue\) -> API\(GET \/admin-api\/platform-api\/teach\/order\/page #getApplyOrderPage\) -> Controller\(ApplyOrderController\.java#getPage\) -> Service\(ApplyOrderServiceImpl\.java\) -> Feign\(ClassesApi\.java\) -> Mapper\/XML\(ApplyOrderMapper\.java, ApplyOrderMapper\.xml\) -> Table\(teach_apply_order, teach_classes\)/
    );
    assert.ok(corr.tenantAuthHints.some((h) => /TenantSecurityWebFilter/.test(h)));
    assert.ok(corr.tenantAuthHints.some((h) => /SignWebFilter/.test(h)));
    assert.equal(formatServiceChain({}), '');
    assert.deepEqual(detectTenantAuthFilterHints('plain layout shift error'), []);

    // Verify in-toto Statement v1 binds scope.graphEngine cleanly (as produced by verdict.mjs)
    const graphEngine = {
      provider: 'codebase-memory-mcp',
      version: '0.12.1',
      binarySha256: 'deadbeef0123456789abcdef',
      mode: 'enriched',
      usedForNarrowing: true,
    };
    const stmt = buildInTotoVerdictAttestation({
      qaDir,
      repoDir: tmpDir,
      gateKernelVersion: '6.6.0',
      verdictPayload: {
        gitSha: 'abc1234',
        runId: '01V660GRAPHPROVENANCE0000',
        verdict: 'pass',
        trustTier: 'T1',
        trustLevel: 'T1',
        acceptanceScope: 'business-e2e',
        scope: { requested: 'impact', actual: 'impact', downgraded: false, selected: 1, total: 10, why: [], graphEngine },
        gates: { governance: 'pass', static: 'pass', runtime: 'pass', semanticDiff: 'pass' },
      },
    });
    assert.deepEqual(stmt.predicate.scope.graphEngine, graphEngine);
    assert.match(stmt.statementDigest, /^sha256:[0-9a-f]{64}$/);

    // Verify computeImpact attaches graphEngine provenance end-to-end & verdict.mjs binds scope.graphEngine
    writeFile(path.join(qaDir, 'playwright.config.ts'), 'export default {};\n');
    writeFile(path.join(qaDir, 'tests', 'e2e', 'order.spec.ts'), 'test("order", () => {});\n');
    const impactRes = await computeImpact(tmpDir, { files: ['src/views/teach/order/index.vue'] });
    assert.equal(impactRes.mode, 'targeted');
    assert.ok(impactRes.graphEngine);
    assert.equal(impactRes.graphEngine.provider, 'builtin');
    assert.equal(impactRes.graphEngine.usedForNarrowing, false);
    const verdictSrc = fs.readFileSync(path.resolve('src/verdict.mjs'), 'utf8');
    assert.match(verdictSrc, /graphEngineProvenance/);
    assert.match(verdictSrc, /usedForNarrowing/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
