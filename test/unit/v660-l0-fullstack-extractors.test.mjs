import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { indexRepositoriesSource, indexRepositorySource } from '../../src/codemap/adapters.mjs';
import { buildJavaDbChainIndex } from '../../src/codemap/correlator.mjs';
import {
  collectApisViaStaticImports,
  collectGatewayPrefixes,
  collectRouteApisWithPrecision,
  matchBackendFilesForApi,
} from '../../src/codemap/route-api-linker.mjs';
import { createRoutePatternMatcher } from '../../src/codemap/route-matcher.mjs';
import {
  attachSpringPackagePrefixes,
  buildJavaConstantTable,
  extractJavaStringConstants,
  extractSpringPrefixRulesFromFile,
  resolveSpringPackagePrefix,
  stripJavaComments,
} from '../../src/codemap/spring-prefix-resolver.mjs';
import { resolveDynamicMenuView } from '../../src/codemap/vue-template-factory.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRel(root, rel, content) {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, 'utf8');
  return full;
}

test('GA-1 Spring prefix resolver: resolves Java static final String constants, regex & Ant patterns, most-specific prefix, and eliminates cross-portal collisions', () => {
  const webPropsSrc = `
    package com.acme.cloud.framework.web.config;
    @ConfigurationProperties(prefix = "acme.web")
    public class WebProperties {
      public static final String ADMIN_API = "/admin-api";
      public static final String PLATFORM_API = ADMIN_API + "/platform-api";
      public static final String APP_API = "/app-api";
      private Api adminApi = new Api(ADMIN_API, "^.*\\\\.controller\\\\.admin\\\\..*$");
      private Api platformApi = new Api(PLATFORM_API, "^.*\\\\.controller\\\\.platform\\\\..*$");
      private Api appApi = new Api(APP_API, "^.*\\\\.controller\\\\.app\\\\..*$");
    }
  `;
  const decl = extractJavaStringConstants('WebProperties.java', stripJavaComments(webPropsSrc));
  const globalConsts = buildJavaConstantTable([decl]);
  const rules = extractSpringPrefixRulesFromFile('WebProperties.java', webPropsSrc, globalConsts);
  assert.equal(rules.length, 3);

  // Specificity test: broader `**.controller.**` (/admin-api) loses to specific `**.controller.platform.**` (/admin-api/platform-api)
  const specificityRules = [
    { packagePattern: '**.controller.**', prefixes: ['/admin-api'] },
    { packagePattern: '**.controller.platform.**', prefixes: ['/admin-api/platform-api'] },
  ];
  const best = resolveSpringPackagePrefix('com.acme.cloud.module.system.controller.platform.dict', specificityRules);
  assert.equal(best?.primaryPrefix, '/admin-api/platform-api');

  // Colliding @RequestMapping("/system/dict-data") across admin, platform, app -> 0 cross-portal collisions!
  const endpoints = [
    { method: 'GET', path: '/system/dict-data/list', file: 'AdminDictController.java', framework: 'spring', packageName: 'com.acme.cloud.module.system.controller.admin.dict' },
    { method: 'GET', path: '/system/dict-data/list', file: 'PlatformDictController.java', framework: 'spring', packageName: 'com.acme.cloud.module.system.controller.platform.dict' },
    { method: 'GET', path: '/system/dict-data/list', file: 'AppDictController.java', framework: 'spring', packageName: 'com.acme.cloud.module.system.controller.app.dict' },
  ];
  attachSpringPackagePrefixes(endpoints, rules);

  assert.equal(endpoints[0].path, '/admin-api/system/dict-data/list');
  assert.equal(endpoints[1].path, '/admin-api/platform-api/system/dict-data/list');
  assert.equal(endpoints[2].path, '/app-api/system/dict-data/list');

  const apiToBackend = new Map(endpoints.map((e) => [e.path, [e.file]]));
  const matcher = createRoutePatternMatcher([...apiToBackend.keys()]);
  const prefixes = collectGatewayPrefixes(['/admin-api', '/admin-api/platform-api', '/app-api']);
  assert.deepEqual(matchBackendFilesForApi('/admin-api/system/dict-data/list', matcher, apiToBackend, prefixes), ['AdminDictController.java']);
  assert.deepEqual(matchBackendFilesForApi('/admin-api/platform-api/system/dict-data/list', matcher, apiToBackend, prefixes), ['PlatformDictController.java']);
  assert.deepEqual(matchBackendFilesForApi('/app-api/system/dict-data/list', matcher, apiToBackend, prefixes), ['AppDictController.java']);
});

test('GA-2 & GA-5 Enterprise Full-Stack L0: Feign/Dubbo bridges, RocketMQ, XxlJob, MyBatis XML + BaseMapper<DO>, chained Axios, crudFactory, fnName linking, global/template components, Chinese views & controller-scoped DB chain', () => {
  const root = makeTempDir('aitest-v660-l0-');
  const feDir = path.join(root, 'admin-vue');
  const beDir = path.join(root, 'cloud-java');

  try {
    // ── Frontend: Vue 2 + chained Axios wrappers + crudFactory + global components + Chinese view ──
    writeRel(feDir, 'package.json', JSON.stringify({ name: 'admin-vue' }));
    writeRel(
      feDir,
      'src/utils/request.js',
      `import axios from 'axios';
       const apiUrl = "/admin-api";
       const service = axios.create({ baseURL: process.env.VUE_APP_BASE_API + apiUrl });
       export default service;\n`
    );
    writeRel(
      feDir,
      'src/utils/platformRequest.js',
      `import service from './request';
       export default function platformRequest(data) {
         const { url, ...rest } = data;
         return service({ url: "/platform-api" + url, ...rest });
       }\n`
    );
    writeRel(
      feDir,
      'src/utils/crudFactory.js',
      `import request from '@/utils/request';
       const toKebabCase = (s) => s.replace(/\\B([A-Z])/g, '-$1').toLowerCase();
       const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
       export const createCrudApi = (entityName, prefix = '/') => {
         const resourcePath = \`\${prefix}/\${toKebabCase(entityName)}\`;
         const suffix = capitalize(entityName);
         const req = (url, method, dataKey, payload) => request({ url: \`\${resourcePath}\${url}\`, method, [dataKey]: payload });
         return {
           [\`create\${suffix}\`]: (data) => req('/create', 'post', 'data', data),
           [\`update\${suffix}\`]: (data) => req('/update', 'put', 'data', data),
           [\`delete\${suffix}\`]: (id) => req('/delete', 'delete', 'params', { id }),
           [\`get\${suffix}\`]: (id) => req('/get', 'get', 'params', { id }),
           [\`getPage\${suffix}\`]: (q) => req('/page', 'get', 'params', q),
           [\`getPageSimple\${suffix}\`]: (q) => req('/page-simple', 'get', 'params', q),
           [\`getList\${suffix}\`]: (ids) => req('/list', 'get', 'params', { ids }),
           [\`exportExcel\${suffix}\`]: (q) => req('/export-excel', 'get', 'params', q),
           [\`getImportTemplate\${suffix}\`]: () => req('/get-import-template', 'get', 'params', undefined),
         };
       };\n`
    );
    writeRel(
      feDir,
      'src/api/teach/siteBanner.js',
      `import request from '@/utils/request';
       import { createCrudApi } from '@/utils/crudFactory';
       export const { createSiteBanner, getPageSiteBanner } = createCrudApi('SiteBanner', '/teach');
       export function updateSiteBannerStatus(data) {
         return request({ url: '/teach/site-banner/update-status', method: 'put', data });
       }\n`
    );
    writeRel(
      feDir,
      'src/api/teach/order.js',
      `import request from '@/utils/request';
       export function getOrderPage(params) { return request({ url: '/teach/apply-order/page', method: 'get', params }); }
       export function deleteOrder(id) { return request({ url: '/teach/apply-order/delete?id=' + id, method: 'delete' }); }
       export function shiftOrder(data) { return request({ url: '/teach/apply-order/shift', method: 'put', data }); }
       export function listExclude(deptId) { return request({ url: '/system/dept/list/exclude/' + deptId, method: 'get' }); }\n`
    );
    writeRel(
      feDir,
      'src/api/infra/config.js',
      `import request from '@/utils/platformRequest';
       export function listConfig(query) { return request({ url: '/infra/config/page', method: 'get', params: query }); }
       export function getConfig(id) { return request({ url: '/infra/config/get?id=' + id, method: 'get' }); }\n`
    );
    // File importing BOTH request and typo-aliased platformRequest!
    writeRel(
      feDir,
      'src/api/mixed/dualClient.js',
      `import request from '@/utils/request';
       import platfromRequest from '@/utils/platformRequest';
       export function getAdminDict() { return request({ url: '/system/dict-data/list', method: 'get' }); }
       export function getPlatformDict() { return platfromRequest({ url: '/system/dict-data/list', method: 'get' }); }\n`
    );
    writeRel(
      feDir,
      'src/components/RightToolbar/index.vue',
      `<template><div class="toolbar"></div></template>
       <script>
       import { listConfig } from '@/api/infra/config';
       export default { name: 'RightToolbar', methods: { load() { listConfig(); } } };
       </script>\n`
    );
    writeRel(
      feDir,
      'src/components/DictTag/index.vue',
      `<template><span></span></template><script>export default { name: 'DictTag' };</script>\n`
    );
    // main.js with hoisted DictTag import AFTER Vue.component('DictTag', DictTag)
    writeRel(
      feDir,
      'src/main.js',
      `import Vue from 'vue';
       import RightToolbar from '@/components/RightToolbar';
       Vue.component('RightToolbar', RightToolbar);
       Vue.component('DictTag', DictTag);
       import DictTag from '@/components/DictTag';\n`
    );
    writeRel(
      feDir,
      'src/views/teach/applyOrder/child/BannerPanel.vue',
      `<template><div></div></template>
       <script>
       import { getPageSiteBanner } from '@/api/teach/siteBanner';
       export default { mounted() { getPageSiteBanner(); } };
       </script>\n`
    );
    writeRel(
      feDir,
      'src/views/teach/applyOrder/createOrder所有字段动态获取.vue',
      `<template>
         <div>
           <right-toolbar />
           <banner-panel />
           <el-button>Submit</el-button>
         </div>
       </template>
       <script>
       import { getOrderPage } from '@/api/teach/order';
       import BannerPanel from './child/BannerPanel.vue';
       export default { components: { BannerPanel }, mounted() { getOrderPage(); } };
       </script>\n`
    );

    // ── Backend: Spring Cloud + WebProperties + Feign + Dubbo + RocketMQ + XxlJob + MyBatis XML + BaseMapperX ──
    writeRel(beDir, 'pom.xml', '<project><modules><module>module-teach</module><module>module-pay</module></modules></project>\n');
    writeRel(
      beDir,
      'framework-web/src/main/java/com/acme/framework/web/WebProperties.java',
      `package com.acme.framework.web;
       public class WebProperties {
         public static final String ADMIN_API = "/admin-api";
         public static final String PLATFORM_API = "/admin-api/platform-api";
         public static final String APP_API = "/app-api";
         private Api adminApi = new Api(ADMIN_API, "^.*\\\\.controller\\\\.admin\\\\..*$");
         private Api platformApi = new Api(PLATFORM_API, "^.*\\\\.controller\\\\.platform\\\\..*$");
         private Api appApi = new Api(APP_API, "^.*\\\\.controller\\\\.app\\\\..*$");
       }\n`
    );
    writeRel(
      beDir,
      'framework-common/src/main/java/com/acme/framework/common/RpcConstants.java',
      `package com.acme.framework.common;
       public class RpcConstants {
         public static final String RPC_API_PREFIX = "/rpc-api";
         public static final String ORDER_PAID_TOPIC = "acme_order_paid";
       }\n`
    );
    writeRel(
      beDir,
      'module-pay/module-pay-api/src/main/java/com/acme/pay/enums/ApiConstants.java',
      `package com.acme.pay.enums;
       import com.acme.framework.common.RpcConstants;
       public class ApiConstants {
         public static final String NAME = "pay-server";
         public static final String PREFIX = RpcConstants.RPC_API_PREFIX + "/pay";
         public static final String VERSION = "1.0.0";
       }\n`
    );
    writeRel(
      beDir,
      'module-pay/module-pay-api/src/main/java/com/acme/pay/api/SchoolPayConfigApi.java',
      `package com.acme.pay.api;
       import com.acme.pay.enums.ApiConstants;
       import org.springframework.cloud.openfeign.FeignClient;
       import org.springframework.web.bind.annotation.GetMapping;
       @FeignClient(name = ApiConstants.NAME)
       public interface SchoolPayConfigApi {
         String PREFIX = ApiConstants.PREFIX + "/school-config";
         @GetMapping(PREFIX + "/get")
         Object getConfig();
       }\n`
    );
    writeRel(
      beDir,
      'module-pay/module-pay-biz/src/main/java/com/acme/pay/api/SchoolPayConfigApiImpl.java',
      `package com.acme.pay.api;
       import org.apache.dubbo.config.annotation.DubboService;
       import org.springframework.web.bind.annotation.RestController;
       import static com.acme.pay.enums.ApiConstants.VERSION;
       @RestController
       @DubboService(version = VERSION)
       public class SchoolPayConfigApiImpl implements SchoolPayConfigApi {
         public Object getConfig() { return null; }
       }\n`
    );
    // Mega-hub ResultBuilderV2 & transitive NoiseService that MUST NOT pollute ApplyOrderController tables!
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/builder/ResultBuilderV2.java',
      `package com.acme.teach.builder;
       import com.acme.teach.service.NoiseOtherService;
       import com.acme.teach.dal.NoiseDO;
       public class ResultBuilderV2<T> { private NoiseOtherService noiseOtherService; }\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/dal/NoiseDO.java',
      `package com.acme.teach.dal;
       @TableName("noise_unrelated_table")
       public class NoiseDO {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/dal/NoiseMapper.java',
      `package com.acme.teach.dal;
       @Mapper
       public interface NoiseMapper extends BaseMapperX<NoiseDO> {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/service/NoiseOtherService.java',
      `package com.acme.teach.service;
       public interface NoiseOtherService {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/service/NoiseOtherServiceImpl.java',
      `package com.acme.teach.service;
       import com.acme.teach.dal.NoiseMapper;
       @Service
       public class NoiseOtherServiceImpl implements NoiseOtherService {
         @Resource private NoiseMapper noiseMapper;
       }\n`
    );
    // Real ApplyOrder chain + RocketMQ producer/consumer + XxlJob
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/dal/ApplyOrderDO.java',
      `package com.acme.teach.dal;
       @TableName("teach_apply_order")
       public class ApplyOrderDO {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/dal/ApplyOrderMapper.java',
      `package com.acme.teach.dal;
       @Mapper
       public interface ApplyOrderMapper extends BaseMapperX<ApplyOrderDO> {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/resources/mapper/ApplyOrderMapper.xml',
      `<?xml version="1.0" encoding="UTF-8"?>
       <mapper namespace="com.acme.teach.dal.ApplyOrderMapper">
         <select id="selectOrderWithClass" resultType="map">
           SELECT o.id FROM teach_apply_order o
           LEFT JOIN acme_cloud.teach_classes c ON c.id = o.class_id
         </select>
         <update id="updateStatus">
           UPDATE teach_apply_order SET status = 1 WHERE id = #{id}
         </update>
       </mapper>\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/service/ApplyOrderService.java',
      `package com.acme.teach.service;
       public interface ApplyOrderService {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/service/ApplyOrderServiceImpl.java',
      `package com.acme.teach.service;
       import com.acme.framework.common.RpcConstants;
       import com.acme.teach.dal.ApplyOrderMapper;
       import com.acme.pay.api.SchoolPayConfigApi;
       import org.apache.dubbo.config.annotation.DubboReference;
       @Service
       public class ApplyOrderServiceImpl implements ApplyOrderService {
         @Resource private ApplyOrderMapper applyOrderMapper;
         @Resource private NoiseOtherService noiseOtherService;
         @DubboReference(version = "1.0.0") private SchoolPayConfigApi dubboPayApi;
         public void notifyPaid(Object msg) {
           rocketMQTemplate.syncSend(RpcConstants.ORDER_PAID_TOPIC, msg);
         }
       }\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/mq/OrderPaidConsumer.java',
      `package com.acme.teach.mq;
       import com.acme.framework.common.RpcConstants;
       @RocketMQMessageListener(topic = RpcConstants.ORDER_PAID_TOPIC, consumerGroup = "teach_order_paid_group")
       public class OrderPaidConsumer {}\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/job/OrderCloseJob.java',
      `package com.acme.teach.job;
       public class OrderCloseJob {
         @XxlJob("orderAutoCloseJobHandler")
         public void execute() {}
       }\n`
    );
    writeRel(
      beDir,
      'module-teach/module-teach-biz/src/main/java/com/acme/teach/controller/admin/applyorder/ApplyOrderController.java',
      `package com.acme.teach.controller.admin.applyorder;
       import com.acme.teach.builder.ResultBuilderV2;
       import com.acme.teach.service.ApplyOrderService;
       import com.acme.pay.api.SchoolPayConfigApi;
       @RestController
       @RequestMapping("/teach/apply-order")
       public class ApplyOrderController {
         @Resource private ApplyOrderService applyOrderService;
         @Resource private SchoolPayConfigApi schoolPayConfigApi;
         @GetMapping("/page")
         public Object page() { return new ResultBuilderV2<>(); }
       }\n`
    );

    const idx = indexRepositoriesSource([feDir, beDir]);

    // 1. Chained Axios wrappers & zero mislabeling
    assert.deepEqual(idx.axiosPrefixes.sort(), ['/admin-api', '/admin-api/platform-api']);
    assert.equal(idx.axiosPrefixByFile['admin-vue/src/api/teach/order.js'], '/admin-api');
    assert.equal(idx.axiosPrefixByFile['admin-vue/src/api/infra/config.js'], '/admin-api/platform-api');
    const dualCalls = idx.frontendApiCalls.filter((c) => c.file === 'admin-vue/src/api/mixed/dualClient.js');
    assert.ok(dualCalls.some((c) => c.fnName === 'getAdminDict' && c.path === '/admin-api/system/dict-data/list'));
    assert.ok(dualCalls.some((c) => c.fnName === 'getPlatformDict' && c.path === '/admin-api/platform-api/system/dict-data/list'));

    // 2. crudFactory generated all 9 endpoints with exact fnNames & /admin-api prefix
    const crudCalls = idx.frontendApiCalls.filter((c) => c.generatedBy === 'createCrudApi');
    assert.equal(crudCalls.length, 9);
    assert.ok(crudCalls.some((c) => c.fnName === 'createSiteBanner' && c.method === 'POST' && c.path === '/admin-api/teach/site-banner/create'));
    assert.ok(crudCalls.some((c) => c.fnName === 'getPageSiteBanner' && c.method === 'GET' && c.path === '/admin-api/teach/site-banner/page'));
    assert.ok(crudCalls.some((c) => c.fnName === 'getImportTemplateSiteBanner' && c.path === '/admin-api/teach/site-banner/get-import-template'));

    // 3. Global Vue components (incl. hoisted DictTag) & <template> child refs + Chinese dynamic menu view
    assert.ok(idx.globalComponents.some((g) => g.name === 'RightToolbar' && g.file === 'admin-vue/src/components/RightToolbar/index.vue'));
    assert.ok(idx.globalComponents.some((g) => g.name === 'DictTag' && g.file === 'admin-vue/src/components/DictTag/index.vue'));
    const chineseViewFile = resolveDynamicMenuView('teach/applyOrder/createOrder所有字段动态获取', idx.viewFiles);
    assert.equal(chineseViewFile, 'admin-vue/src/views/teach/applyOrder/createOrder所有字段动态获取.vue');
    assert.equal(
      resolveDynamicMenuView(encodeURI('teach/applyOrder/createOrder所有字段动态获取'), idx.viewFiles),
      chineseViewFile
    );
    const tplRefs = idx.vueTemplateRefs[chineseViewFile] || [];
    assert.ok(tplRefs.includes('admin-vue/src/components/RightToolbar/index.vue'));
    assert.ok(tplRefs.includes('admin-vue/src/views/teach/applyOrder/child/BannerPanel.vue'));

    // 4. Precision fnName-scoped API linking: ONLY imported getOrderPage (NOT deleteOrder/shiftOrder/listExclude!) + child getPageSiteBanner + RightToolbar listConfig!
    const preciseApis = collectRouteApisWithPrecision(chineseViewFile, idx);
    assert.ok(preciseApis.includes('/admin-api/teach/apply-order/page'));
    assert.equal(preciseApis.includes('/admin-api/teach/apply-order/delete'), false, 'Unimported deleteOrder must NOT leak into route APIs');
    assert.equal(preciseApis.includes('/admin-api/teach/apply-order/shift'), false, 'Unimported shiftOrder must NOT leak into route APIs');
    assert.ok(preciseApis.includes('/admin-api/teach/site-banner/page'), 'Child <template> BannerPanel API must be included');
    assert.equal(preciseApis.includes('/admin-api/teach/site-banner/create'), false, 'Unimported createSiteBanner must NOT leak from BannerPanel');
    assert.ok(preciseApis.includes('/admin-api/platform-api/infra/config/page'), 'Global RightToolbar API must be included');
    assert.equal(preciseApis.includes('/admin-api/platform-api/infra/config/get'), false, 'Unimported getConfig must NOT leak from RightToolbar');

    // 5. Feign -> ApiImpl bridge, Dubbo, RocketMQ edge, XxlJob, MyBatis XML statements & BaseMapperX<ApplyOrderDO>
    assert.equal(idx.feignBridges.length, 1);
    assert.equal(idx.feignBridges[0].serviceName, 'pay-server');
    assert.equal(idx.feignBridges[0].implClass, 'SchoolPayConfigApiImpl');
    assert.equal(idx.feignBridges[0].isDubboService, true);
    assert.equal(idx.dubboServices.length, 1);
    assert.equal(idx.dubboServices[0].version, '1.0.0');
    assert.equal(idx.dubboReferences.length, 1);
    assert.equal(idx.dubboReferences[0].targetType, 'SchoolPayConfigApi');
    assert.ok(idx.mqEdges.some((e) => e.topic === 'acme_order_paid' && e.producerClass === 'ApplyOrderServiceImpl' && e.consumerClass === 'OrderPaidConsumer'));
    assert.ok(idx.xxlJobs.some((j) => j.jobName === 'orderAutoCloseJobHandler' && j.methodName === 'execute'));

    const xmlLink = idx.mybatisXmlLinks.find((x) => x.namespace === 'com.acme.teach.dal.ApplyOrderMapper');
    assert.ok(xmlLink);
    assert.ok(xmlLink.mapperFile?.endsWith('ApplyOrderMapper.java'));
    assert.equal(xmlLink.statements.length, 2);
    assert.deepEqual(xmlLink.statements[0].tables.sort(), ['teach_apply_order', 'teach_classes']);
    assert.ok(xmlLink.statements[0].startLine >= 1 && xmlLink.statements[0].endLine > xmlLink.statements[0].startLine);

    const mapperMeta = Object.values(idx.javaFileInfos).find((m) => m.className === 'ApplyOrderMapper');
    assert.deepEqual(mapperMeta?.genericEntityTypes, ['ApplyOrderDO']);

    // 6. Controller-scoped direct-chain DB correlation skips ResultBuilderV2 & transitive NoiseOtherService
    const ctrlFile = Object.keys(idx.controllerChains).find((f) => f.endsWith('ApplyOrderController.java'));
    assert.ok(ctrlFile);
    const chain = idx.controllerChains[ctrlFile];
    assert.deepEqual(chain.tables.sort(), ['teach_apply_order', 'teach_classes']);
    assert.equal(chain.tables.includes('noise_unrelated_table'), false, 'ResultBuilderV2 / sibling NoiseOtherService must NOT leak');
    assert.ok(chain.crossServiceTargets.some((t) => t.endsWith('SchoolPayConfigApiImpl.java')));

    // 7. CBM controllerChain override is honored when provided
    const cbmIndex = buildJavaDbChainIndex(idx.javaFileInfos, idx.mybatisMappers, idx.dbEntities, {
      cbmControllerChains: {
        [ctrlFile]: { tables: ['teach_apply_order', 'cbm_verified_table'], crossServiceTargets: ['pay-svc'] },
      },
    });
    assert.deepEqual(cbmIndex.resolveTablesForBackendFile(ctrlFile).sort(), ['cbm_verified_table', 'teach_apply_order']);

    // 8. Backwards-compatible 4-arg collectApisViaStaticImports & empty indexRepositorySource
    const legacyApis = collectApisViaStaticImports(
      chineseViewFile,
      idx.frontendImports,
      new Map([['admin-vue/src/api/teach/order.js', ['/teach/apply-order/page']]]),
      idx.axiosPrefixByFile
    );
    assert.deepEqual(legacyApis, ['/admin-api/teach/apply-order/page']);
    const emptyIdx = indexRepositorySource('');
    assert.deepEqual(emptyIdx.feignBridges, []);
    assert.deepEqual(emptyIdx.controllerChains, {});
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
