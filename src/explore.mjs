// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveQaDirectory } from './agents.mjs';
import { syncLivingCodeMap } from './codemap.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { resolvePlaywrightPackage } from './core/playwright-resolve.mjs';
import { loadRuntimeConfig } from './core/runtime-config.mjs';
import { executeExploreCrawl } from './explore/crawler.mjs';
import {
  buildExploreCliSummary,
  generatePageAriaSpecMarkdown,
  generateSystemOverviewMarkdown,
  resolveExploreEntryPath,
} from './explore/reporter.mjs';
import { writeInferredApiSchemas } from './explore/schema-inferrer.mjs';
import {
  DEFAULT_EXPLORE_PAGES, MAX_EXPLORE_PAGES, classifyActionSafety, createStratifiedRouteQueue,
  detectEnvelopeBusinessError, detectPageArchetype, detectUrlQueryAnomalies, evaluateExploreRequestSafety,
  extractVueDynamicRoutes, isSafeReadonlyDialogTrigger, redactEndpointUrl, routeToSafeSlug, sanitizeUntrustedDomText,
} from './explore/safety.mjs';
import {
  DEFAULT_BLOCKED_ENDPOINTS, compileBlockedEndpointRules, evaluateTargetSafety,
  loadMergedQaEnv, parseCsvList, parseLowerCsvList,
} from './origin-guard.mjs';

export {
  DEFAULT_EXPLORE_PAGES, MAX_EXPLORE_PAGES, classifyActionSafety, createStratifiedRouteQueue,
  detectEnvelopeBusinessError, detectPageArchetype, detectUrlQueryAnomalies, evaluateExploreRequestSafety,
  extractVueDynamicRoutes, generatePageAriaSpecMarkdown, generateSystemOverviewMarkdown, isSafeReadonlyDialogTrigger,
  redactEndpointUrl, sanitizeUntrustedDomText,
};

/** @param {string} filePath */
function loadJsonIfValid(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Executes a bounded, strictly read-only zero-to-one browser exploration from an entry URL.
 * @param {Record<string, any>} [options]
 */
export async function runExploreCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {number} exitCode @param {string} msg @param {string[]} [errors] */
  const failExplore = (exitCode, msg, errors = [msg]) => {
    if (!asJson) for (const e of errors) console.error(e);
    return emitCommandResult(
      buildCommandResult({
        tool: 'explore',
        outcome: exitCode === 2 ? 'blocked' : 'fail',
        ok: false,
        exitCode,
        summary: msg,
        blockerKind: exitCode === 2 ? 'TARGET_OR_CONFIG_BLOCKED' : null,
        data: { error: msg, errors },
      }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) return failExplore(1, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) return failExplore(1, lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);

  const wbCfg = loadWorkbenchConfig({ qaDir });
  if (!wbCfg.ok) return failExplore(2, `[Config Blocked] ${wbCfg.errors.join('; ') || 'Invalid workbench config.'}`);
  const runtimeCfgRes = loadRuntimeConfig(qaDir);
  if (!runtimeCfgRes.ok) return failExplore(2, `[Runtime Config Blocked] ${runtimeCfgRes.errors.join('; ') || 'Invalid aitest.runtime.json.'}`);

  /** @type {Record<string, string>} */
  const overrides = {};
  if (options.baseUrl) overrides.TEST_BASE_URL = options.baseUrl;
  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  if (!mergedEnv.TEST_BASE_URL && runtimeCfgRes.config?.baseURL) {
    mergedEnv.TEST_BASE_URL = runtimeCfgRes.config.baseURL;
  }
  const safety = evaluateTargetSafety(mergedEnv);
  if (!safety.ok || !safety.baseURL) {
    const errs = safety.errors.length > 0 ? safety.errors : ['TEST_BASE_URL is required for explore.'];
    return failExplore(2, `[Target Guard Blocked] ${errs[0]}`, errs.map((e) => `[Target Guard Blocked] ${e}`));
  }

  const pwPkg = resolvePlaywrightPackage(qaDir);
  if (!pwPkg) {
    return failExplore(
      1,
      lang === 'zh' ? `在 ${qaDir} 中未找到 playwright 包，请先安装依赖。` : `playwright package not found in ${qaDir}. Install dependencies first.`
    );
  }

  const maxPages = Math.max(1, Math.min(MAX_EXPLORE_PAGES, Number(options.maxPages || DEFAULT_EXPLORE_PAGES)));
  const exploreTabs = options.exploreTabs !== false;
  const exploreDialogs = options.exploreDialogs !== false;
  const explorePortals = options.explorePortals !== false;
  const maxTabsPerPage = Math.max(0, Math.min(12, Number(options.maxTabsPerPage ?? 6)));
  const maxDialogsPerPage = Math.max(0, Math.min(5, Number(options.maxDialogsPerPage ?? 2)));
  const maxPortals = Math.max(1, Math.min(5, Number(options.maxPortals ?? 3)));
  const entryPath = resolveExploreEntryPath(safety.baseURL, options.entryPath);
  const userAuthPath = path.join(qaDir, 'playwright', '.auth', 'user.json');
  const sessionData = loadJsonIfValid(path.join(qaDir, 'playwright', '.auth', 'session.json'));

  const guardConfig = {
    baseURL: safety.baseURL,
    allowedHosts: safety.allowedHosts,
    allowedOrigins: safety.allowedOrigins,
    deniedOrigins: safety.deniedOrigins,
    extraEgressHosts: safety.extraEgressHosts,
    egressMode: safety.egressMode || 'allowlist',
    blockedRules: compileBlockedEndpointRules(mergedEnv.TEST_BLOCKED_ENDPOINTS ?? DEFAULT_BLOCKED_ENDPOINTS),
    safePostPaths: parseCsvList(mergedEnv.EXPLORE_SAFE_POST_PATHS ?? ''),
    allowGraphqlQuery: mergedEnv.EXPLORE_ALLOW_GRAPHQL_QUERY !== '0',
    deniedSubstrings: parseLowerCsvList(mergedEnv.TEST_DENIED_ORIGINS ?? ''),
    abortThirdPartyHosts: parseLowerCsvList(mergedEnv.TEST_ABORT_THIRD_PARTY_HOSTS ?? ''),
  };

  const { chromium } = await import(pathToFileURL(pwPkg).href);
  const browser = await chromium.launch({ headless: true });

  let topology;
  try {
    topology = await executeExploreCrawl({
      browser, safety, guardConfig, sessionData, userAuthPath,
      maxPages, exploreTabs, exploreDialogs, explorePortals, maxTabsPerPage, maxDialogsPerPage, maxPortals, entryPath,
    });
  } finally {
    await browser.close();
  }

  if (options.dryRun) {
    const drySummary = buildExploreCliSummary(topology, { entryPath, dryRun: true });
    return emitCommandResult(
      buildCommandResult({
        tool: 'explore', outcome: 'pass', ok: true, exitCode: 0,
        summary: `Dry-run explore complete (${topology.pages.length} route(s), ${topology.endpoints.length} endpoint(s))`,
        data: drySummary,
      }),
      { asJson }
    );
  }

  const reportsDir = path.join(qaDir, 'reports');
  const specsDir = path.join(qaDir, 'specs');
  const pagesSpecDir = path.join(specsDir, 'pages');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.mkdirSync(pagesSpecDir, { recursive: true });

  const topologyPath = path.join(reportsDir, 'system-topology.json');
  const overviewPath = path.join(specsDir, 'system-overview.md');
  const schemaOut = writeInferredApiSchemas(qaDir, topology.jsonCaptures || [], topology);
  const { jsonCaptures: _omitCaptures, ...persistedTopology } = topology;
  fs.writeFileSync(topologyPath, JSON.stringify(persistedTopology, null, 2) + '\n', 'utf8');
  fs.writeFileSync(overviewPath, generateSystemOverviewMarkdown(persistedTopology, lang), 'utf8');

  for (const p of topology.pages) {
    fs.writeFileSync(path.join(pagesSpecDir, `${routeToSafeSlug(p.route)}.md`), generatePageAriaSpecMarkdown(p, lang), 'utf8');
  }

  const codeMapSync = await syncLivingCodeMap(qaDir, { lang, syncImpact: !options.noSyncImpact });
  const summary = {
    ...buildExploreCliSummary(persistedTopology, { entryPath, topologyPath, overviewPath, pagesSpecDir, codeMapSync }),
    apiSchemasPath: schemaOut.outPath,
    apiSchemasCount: schemaOut.count,
  };

  if (!asJson) {
    console.log(
      lang === 'zh'
        ? `\n[Explore] 从 0 到 1 只读探索完成 (snapshot=${topology.snapshotId})：覆盖 ${topology.portals.length} 个门户上下文、${topology.pages.length} 个路由（Tab ${summary.tabsExploredCount} 次 / 只读弹窗 ${summary.dialogsExploredCount} 次 / 断链 ${topology.brokenRoutes.length} 个）、${topology.endpoints.length} 个脱敏 API 端点（包裹异常 ${topology.envelopeErrors.length} 次，拦截写请求 ${topology.blockedWriteRequests.length} 次），同步活体知识图谱 (Revision #${codeMapSync.revision})。`
        : `\n[Explore] Zero-to-one read-only exploration complete (snapshot=${topology.snapshotId}): ${topology.portals.length} portal(s), ${topology.pages.length} route(s) (tabs=${summary.tabsExploredCount}, readonly dialogs=${summary.dialogsExploredCount}, broken=${topology.brokenRoutes.length}), ${topology.endpoints.length} redacted API endpoint(s) (envelopeErrors=${topology.envelopeErrors.length}, blockedWrites=${topology.blockedWriteRequests.length}), synced Living Code Map (Revision #${codeMapSync.revision}).`
    );
    if (topology.authRequired) {
      console.warn(
        lang === 'zh'
          ? `  [鉴权提示] 检测到 ${topology.authRedirectCount} 条受保护路由重定向至登录页 (${topology.loginRoute || '/login'})；请先人工运行 auth-login（或 --cdp-url）保存会话后再探索业务页面。`
          : `  [Auth Hint] Detected ${topology.authRedirectCount} protected route(s) redirecting to ${topology.loginRoute || '/login'}; capture an authenticated session via auth-login (or --cdp-url) before crawling authenticated pages.`
      );
    }
    if (topology.blockedApiHosts.length > 0) {
      console.warn(
        lang === 'zh'
          ? `  [提示] 拦截了跨源 API 主机: ${topology.blockedApiHosts.join(', ')}（如属当前测试环境后端网关，请加入 TEST_ALLOWED_HOSTS）`
          : `  [Hint] Blocked cross-origin API host(s): ${topology.blockedApiHosts.join(', ')} (add to TEST_ALLOWED_HOSTS if part of your test gateway)`
      );
    }
    console.log(`  Topology JSON : ${topologyPath}\n  System Atlas  : ${overviewPath}\n  Page ARIA Dir : ${pagesSpecDir}\n  Code Map MD   : ${codeMapSync.systemMapMdPath}`);
  }

  return emitCommandResult(
    buildCommandResult({
      tool: 'explore', outcome: 'pass', ok: true, exitCode: 0,
      summary: `Explore complete (${topology.pages.length} route(s), ${topology.endpoints.length} endpoint(s), map rev #${codeMapSync.revision})`,
      data: summary,
    }),
    { asJson }
  );
}
