// @ts-check
import { groupOutcomesBySpecFile } from '../core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from '../core/version.mjs';
import { createRoutePatternMatcher, normalizeRoutePath } from './adapters.mjs';
import {
  buildJavaDbChainIndex,
  compileDbEntityMatchers,
  computeCodeMapContentFingerprint,
  correlateDbTablesForRoute,
} from './correlator.mjs';
import {
  buildFrontendViewGraph,
  collectApisViaStaticImports,
  collectGatewayPrefixes,
  convergeDefectsAndPerf,
  getStrippedApiCandidates,
  matchBackendFilesForApi,
  resolveDynamicViewForPage,
} from './route-api-linker.mjs';
import { buildApisAndServiceChains, prepareExternalGraphSignals } from './v5-fusion.mjs';

export { compileDbEntityMatchers, correlateDbTablesForRoute };

const STALE_RUNTIME_DAYS = 14;

/**
 * Migrates v3/v4 code-map objects cleanly to `schemaVersion: 5` while preserving runtime routes & defects.
 * @param {any} rawMap @returns {Record<string, any>}
 */
export function migrateCodeMapSchema(rawMap) {
  if (!rawMap || typeof rawMap !== 'object') return {};
  return {
    ...rawMap,
    schemaVersion: SCHEMA_VERSIONS.codeMap,
    processedSnapshots: Array.isArray(rawMap.processedSnapshots) ? rawMap.processedSnapshots : [],
    apis: rawMap.apis && typeof rawMap.apis === 'object' && !Array.isArray(rawMap.apis) ? rawMap.apis : {},
    serviceChains: Array.isArray(rawMap.serviceChains) ? rawMap.serviceChains : [],
  };
}

/**
 * Fuses static code index + optional sidecar graph snapshot + runtime exploration topology + test results + perf snapshots
 * into Living Code Map v5 (`schemaVersion: 5`).
 * @param {any} existingMap
 * @param {{
 *   nowIso?: string,
 *   sourceIndex?: any,
 *   topology?: any,
 *   specIndex?: Array<{ specFile: string, uiRoutes?: string[], apiPaths: string[] }>,
 *   resultsJson?: any,
 *   perfReport?: any,
 *   sourceRepos?: string[],
 *   maxScanFiles?: number,
 *   apiPrefixes?: string[],
 *   normalizedGraphSnapshot?: import('./providers/cbm-normalizer.mjs').NormalizedGraphSnapshot | null,
 * }} [inputs]
 */
export function mergeLivingCodeMap(existingMap, inputs = {}) {
  const now = inputs.nowIso || new Date().toISOString();
  const nowMs = Date.parse(now);
  const base = migrateCodeMapSchema(existingMap);
  const revision = Number(base.revision || 0) + 1;

  const sourceIndex = inputs.sourceIndex || {
    fileCount: 0, truncated: false, warnings: [], frontendRoutes: [], brokenRouteImports: [],
    frontendApiCalls: [], backendEndpoints: [], dbEntities: [], backendFileTexts: {},
  };
  const topology = inputs.topology || {};
  const specIndex = Array.isArray(inputs.specIndex) ? inputs.specIndex : [];
  const outcomesBySpec = groupOutcomesBySpecFile(inputs.resultsJson || null);

  const { graphEngine, cbmControllerChains, cbmMethodByCtrlRoute } = prepareExternalGraphSignals(
    inputs.normalizedGraphSnapshot || null,
    sourceIndex
  );

  const staticPatterns = (sourceIndex.frontendRoutes || []).map((/** @type {any} */ r) => normalizeRoutePath(r.route));
  const matchStatic = createRoutePatternMatcher(staticPatterns);
  const hasStaticIndex = staticPatterns.length > 0;

  /** @type {Record<string, any>} */
  const routesObj = {};
  const createBlankRoute = (/** @type {string} */ key, source = 'static') => {
    const prev = base.routes?.[key] || {};
    return {
      route: key, source, title: prev.title || '', breadcrumbs: prev.breadcrumbs || [],
      archetype: prev.archetype || 'unknown', frontendFile: null,
      tableHeaders: prev.tableHeaders || [], filterLabels: prev.filterLabels || [],
      readonlyButtons: prev.readonlyButtons || [], mutationButtons: prev.mutationButtons || [],
      linkedApis: [], linkedBackendFiles: [], linkedDbTables: [], coveringSpecs: [],
      lastResult: prev.lastResult || 'untested', a11y: prev.a11y || null,
      firstSeenAt: prev.firstSeenAt || now, lastSeenAt: prev.lastSeenAt || now,
      stale: false, lastUpdatedAt: now,
    };
  };
  const ensureRoute = (/** @type {string} */ rPath, source = 'static') => {
    const normalized = normalizeRoutePath(rPath);
    const key = source === 'runtime' ? matchStatic(normalized) : normalized;
    if (!routesObj[key]) routesObj[key] = createBlankRoute(key, source);
    else if (source === 'static') routesObj[key].source = 'static';
    return routesObj[key];
  };

  for (const fr of sourceIndex.frontendRoutes || []) {
    const entry = ensureRoute(fr.route, 'static');
    if (fr.file && !entry.frontendFile) entry.frontendFile = fr.file;
    entry.lastSeenAt = now;
  }
  for (const [prevKey, prevRoute] of Object.entries(base.routes || {})) {
    if (routesObj[prevKey] || (hasStaticIndex && prevRoute.source !== 'runtime' && prevRoute.frontendFile)) continue;
    if (prevRoute.source === 'runtime' || (!prevRoute.frontendFile && prevRoute.archetype !== 'tested-route')) {
      const ageMs = nowMs - Date.parse(prevRoute.lastSeenAt || prevRoute.lastUpdatedAt || now);
      routesObj[prevKey] = {
        ...prevRoute, source: 'runtime', coveringSpecs: [],
        linkedApis: Array.isArray(prevRoute.linkedApis) ? [...prevRoute.linkedApis] : [],
        linkedBackendFiles: Array.isArray(prevRoute.linkedBackendFiles) ? [...prevRoute.linkedBackendFiles] : [],
        linkedDbTables: Array.isArray(prevRoute.linkedDbTables) ? [...prevRoute.linkedDbTables] : [],
        stale: Number.isFinite(ageMs) && ageMs > STALE_RUNTIME_DAYS * 86_400_000,
      };
    }
  }

  const exploredRouteKeys = new Set();
  /** @type {Map<string, any>} */
  const pageMetaByRoute = new Map();
  for (const p of topology.pages || []) {
    const entry = ensureRoute(p.route || p.actualPath || '/', 'runtime');
    exploredRouteKeys.add(entry.route);
    pageMetaByRoute.set(entry.route, p);
    if (p.title) entry.title = p.title;
    if (Array.isArray(p.breadcrumbs) && p.breadcrumbs.length > 0) entry.breadcrumbs = p.breadcrumbs;
    if (p.archetype) entry.archetype = p.archetype;
    if (Array.isArray(p.tableHeaders) && p.tableHeaders.length > 0) entry.tableHeaders = p.tableHeaders;
    if (Array.isArray(p.filterLabels) && p.filterLabels.length > 0) entry.filterLabels = p.filterLabels;
    if (Array.isArray(p.readonlyButtons)) entry.readonlyButtons = [...new Set([...entry.readonlyButtons, ...p.readonlyButtons])];
    if (Array.isArray(p.mutationButtons)) entry.mutationButtons = [...new Set([...entry.mutationButtons, ...p.mutationButtons])];
    const observed = p.apisObserved || p.apis || p.observedApis;
    if (Array.isArray(observed)) entry.linkedApis = [...new Set([...entry.linkedApis, ...observed])];
    if (p.a11y) entry.a11y = p.a11y;
    entry.lastSeenAt = now;
    entry.stale = false;
    entry.lastUpdatedAt = now;
  }

  for (const sp of specIndex) {
    for (const rPath of sp.uiRoutes || []) {
      const entry = ensureRoute(rPath, 'runtime');
      if (entry.archetype === 'unknown') entry.archetype = 'tested-route';
    }
  }

  /** @type {Map<string, string[]>} */
  const apiToBackend = new Map();
  for (const be of sourceIndex.backendEndpoints || []) {
    for (const p of [be.path, ...(be.aliasedPaths || [])]) {
      if (!p) continue;
      const list = apiToBackend.get(p) || [];
      if (!list.includes(be.file)) list.push(be.file);
      apiToBackend.set(p, list);
    }
  }
  const matchBackendApi = createRoutePatternMatcher([...apiToBackend.keys()]);

  /** @type {Map<string, string[]>} */
  const apiCallsByFile = new Map();
  for (const c of sourceIndex.frontendApiCalls || []) {
    if (!c?.file || !c?.path) continue;
    const list = apiCallsByFile.get(c.file) || [];
    list.push(c.path);
    apiCallsByFile.set(c.file, list);
  }

  const gatewayPrefixes = collectGatewayPrefixes([...(sourceIndex.axiosPrefixes || []), ...(inputs.apiPrefixes || [])]);
  const { reverse: reverseFrontend, viewSet } = buildFrontendViewGraph(
    sourceIndex.frontendImports || {},
    sourceIndex.viewFiles || [],
    sourceIndex.vueTemplateRefs || {}
  );
  const compiledEntities = compileDbEntityMatchers(sourceIndex.dbEntities || []);
  const javaDbChain = buildJavaDbChainIndex(
    sourceIndex.javaFileInfos || {},
    sourceIndex.mybatisMappers || [],
    sourceIndex.dbEntities || [],
    { feignBridges: sourceIndex.feignBridges || [], cbmControllerChains }
  );
  const backendFileTexts = sourceIndex.backendFileTexts || {};

  const allRouteKeys = Object.keys(routesObj);
  for (const entry of Object.values(routesObj)) {
    if (!entry.frontendFile) {
      const pageMeta = pageMetaByRoute.get(entry.route) || { route: entry.route };
      const resolvedView = resolveDynamicViewForPage(pageMeta, entry.linkedApis, {
        viewFiles: sourceIndex.viewFiles || [], frontendApiCalls: sourceIndex.frontendApiCalls || [],
        reverseFrontend, viewSet, prefixes: gatewayPrefixes,
      });
      if (resolvedView) entry.frontendFile = resolvedView;
      else if (sourceIndex.layoutRoutes?.[entry.route]) entry.frontendFile = sourceIndex.layoutRoutes[entry.route];
      else if (sourceIndex.layoutFile && entry.route !== '/' && allRouteKeys.some((rk) => rk.startsWith(`${entry.route}/`))) {
        entry.frontendFile = sourceIndex.layoutFile;
      }
    }

    if (entry.frontendFile) {
      const calls = collectApisViaStaticImports(
        entry.frontendFile,
        sourceIndex.frontendImports || {},
        apiCallsByFile,
        sourceIndex.axiosPrefixByFile || {},
        {
          frontendNamedImports: sourceIndex.frontendNamedImports || {},
          frontendApiCalls: sourceIndex.frontendApiCalls || [],
          vueTemplateRefs: sourceIndex.vueTemplateRefs || {},
        }
      );
      const apiSet = new Set(entry.linkedApis);
      for (const p of calls) {
        if (!apiSet.has(p)) { apiSet.add(p); entry.linkedApis.push(p); }
      }
    }

    const beFiles = new Set();
    for (const apiPath of entry.linkedApis) {
      for (const f of matchBackendFilesForApi(apiPath, matchBackendApi, apiToBackend, gatewayPrefixes)) beFiles.add(f);
    }
    entry.linkedBackendFiles = [...beFiles];
    entry.linkedDbTables = correlateDbTablesForRoute(entry, sourceIndex.dbEntities || [], backendFileTexts, compiledEntities, javaDbChain);
  }

  const matchActive = createRoutePatternMatcher(Object.keys(routesObj));
  /** @type {Map<string, Set<string>>} */
  const routeToSpecs = new Map();
  /** @type {Map<string, Set<string>>} */
  const apiToSpecs = new Map();

  for (const sp of specIndex) {
    for (const u of sp.uiRoutes || []) {
      const key = matchActive(u);
      const set = routeToSpecs.get(key) || new Set();
      set.add(sp.specFile);
      routeToSpecs.set(key, set);
    }
    for (const api of sp.apiPaths || []) {
      for (const cand of [api, ...getStrippedApiCandidates(api, gatewayPrefixes)]) {
        const set = apiToSpecs.get(cand) || new Set();
        set.add(sp.specFile);
        apiToSpecs.set(cand, set);
      }
    }
  }

  for (const entry of Object.values(routesObj)) {
    const matchedSpecs = new Set(routeToSpecs.get(entry.route) || []);
    for (const api of entry.linkedApis) {
      for (const cand of [api, ...getStrippedApiCandidates(api, gatewayPrefixes)]) {
        for (const sf of apiToSpecs.get(cand) || []) matchedSpecs.add(sf);
      }
    }
    entry.coveringSpecs = [...matchedSpecs];

    if (entry.coveringSpecs.length > 0 && outcomesBySpec.size > 0) {
      let anyFail = false;
      let anyPass = false;
      for (const sf of entry.coveringSpecs) {
        const out = outcomesBySpec.get(sf);
        if (!out) continue;
        if (out.failed > 0) anyFail = true;
        else if (out.passed > 0) anyPass = true;
      }
      if (anyFail) entry.lastResult = 'failed';
      else if (anyPass) entry.lastResult = 'passed';
    }
  }

  const { apis, serviceChains, crossServiceBridges } = buildApisAndServiceChains(
    sourceIndex, routesObj, javaDbChain, apiToSpecs, gatewayPrefixes, cbmMethodByCtrlRoute
  );

  const portalsByKey = new Map();
  for (const pt of [...(base.portals || []), ...(topology.portals || [])]) {
    if (!pt || !pt.name) continue;
    const key = `${pt.mode || 'default'}:${pt.id ?? pt.name}`;
    portalsByKey.set(key, { ...(portalsByKey.get(key) || {}), ...pt });
  }
  const endpointMap = new Map();
  for (const ep of [...(base.endpoints || []), ...(topology.endpoints || [])]) {
    if (ep?.endpoint) endpointMap.set(`${ep.method || 'GET'} ${ep.endpoint}`, ep);
  }

  const converged = convergeDefectsAndPerf({
    base, sourceIndex, topology, perfReport: inputs.perfReport || null, now, exploredRouteKeys, matchActive,
  });

  const activeRoutes = Object.values(routesObj).filter((r) => !r.stale);
  const coveredRoutes = activeRoutes.filter((r) => r.coveringSpecs.length > 0).length;
  const uncoveredRoutes = activeRoutes.filter((r) => r.coveringSpecs.length === 0).map((r) => r.route);
  const coveragePct = activeRoutes.length > 0 ? Math.round((coveredRoutes / activeRoutes.length) * 100) : 0;
  const dbTables = (sourceIndex.dbEntities || []).map((/** @type {any} */ d) => d.table);
  const openDefectsCount = converged.defects.filter((d) => d.status === 'open').length;

  const history = [...(base.history || []), {
    revision, day: now.slice(0, 10), updatedAt: now, totalRoutes: activeRoutes.length,
    coveredRoutes, coveragePct, endpointsCount: endpointMap.size, openDefects: openDefectsCount,
  }];

  const resolvedSourceRepos = inputs.sourceRepos || sourceIndex.repos || base.meta?.sourceRepos || [];
  const nextMap = {
    schemaVersion: SCHEMA_VERSIONS.codeMap,
    version: '5.0',
    revision,
    updatedAt: now,
    contentFingerprint: '',
    meta: {
      sourceRepos: resolvedSourceRepos,
      scannedFiles: sourceIndex.fileCount || 0,
      truncated: Boolean(sourceIndex.truncated),
      ...(typeof inputs.maxScanFiles === 'number' ? { maxScanFiles: inputs.maxScanFiles } : {}),
      ...(Array.isArray(inputs.apiPrefixes) && inputs.apiPrefixes.length > 0 ? { apiPrefixes: inputs.apiPrefixes } : {}),
      graphEngine,
    },
    baseURL: topology.baseURL || base.baseURL || null,
    techStack: [...new Set([...(base.techStack || []), ...(topology.techStack || [])])],
    portals: [...portalsByKey.values()],
    processedSnapshots: converged.processedSnapshots,
    sourceSummary: {
      repoFilesScanned: sourceIndex.fileCount || base.sourceSummary?.repoFilesScanned || 0,
      truncated: Boolean(sourceIndex.truncated),
      warnings: sourceIndex.warnings || [],
      backendEndpointsCount: (sourceIndex.backendEndpoints || []).length || base.sourceSummary?.backendEndpointsCount || 0,
      dbEntities: dbTables.length > 0 ? [...new Set(dbTables)] : base.sourceSummary?.dbEntities || [],
    },
    routes: routesObj,
    apis,
    serviceChains,
    crossServiceBridges,
    endpoints: [...endpointMap.values()],
    defects: converged.defects,
    duplicateWaterfalls: topology.duplicateWaterfalls || base.duplicateWaterfalls || [],
    coverage: {
      totalRoutes: activeRoutes.length, coveredRoutes,
      uncoveredCount: uncoveredRoutes.length, uncoveredRoutes, coveragePct,
      staleRoutesCount: Object.values(routesObj).filter((r) => r.stale).length,
    },
    perfSnapshots: converged.perfSnapshots,
    history: history.slice(-30),
  };

  nextMap.contentFingerprint = computeCodeMapContentFingerprint(nextMap);
  return nextMap;
}
