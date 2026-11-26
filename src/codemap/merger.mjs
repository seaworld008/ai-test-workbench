// @ts-check
import { groupOutcomesBySpecFile } from '../core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from '../core/version.mjs';
import { createRoutePatternMatcher, normalizeRoutePath } from './adapters.mjs';
import {
  compileDbEntityMatchers,
  computeCodeMapContentFingerprint,
  computeTopologySnapshotId,
  correlateDbTablesForRoute,
} from './correlator.mjs';

export { compileDbEntityMatchers, correlateDbTablesForRoute };

const STALE_RUNTIME_DAYS = 14;

/**
 * Migrates v3.0 code-map objects cleanly to `schemaVersion: 4` (`A-07`).
 * @param {any} rawMap @returns {Record<string, any>}
 */
export function migrateCodeMapSchema(rawMap) {
  if (!rawMap || typeof rawMap !== 'object') return {};
  return {
    ...rawMap,
    schemaVersion: SCHEMA_VERSIONS.codeMap,
    processedSnapshots: Array.isArray(rawMap.processedSnapshots) ? rawMap.processedSnapshots : [],
  };
}

/**
 * Fuses static code index + runtime exploration topology + test results + perf snapshots into
 * Living Code Map v2 (`schemaVersion: 4`) in linear O(N) time with compiled route pattern matchers,
 * pre-grouped frontend API calls, pre-compiled DB entity regexes, and inverted spec coverage maps (`K-01..K-06`).
 * @param {any} existingMap
 * @param {{ nowIso?: string, sourceIndex?: any, topology?: any, specIndex?: Array<{ specFile: string, uiRoutes?: string[], apiPaths: string[] }>, resultsJson?: any, perfReport?: any }} [inputs]
 */
export function mergeLivingCodeMap(existingMap, inputs = {}) {
  const now = inputs.nowIso || new Date().toISOString();
  const nowMs = Date.parse(now);
  const base = migrateCodeMapSchema(existingMap);
  const revision = Number(base.revision || 0) + 1;

  const sourceIndex = inputs.sourceIndex || {
    fileCount: 0,
    truncated: false,
    warnings: [],
    frontendRoutes: [],
    brokenRouteImports: [],
    frontendApiCalls: [],
    backendEndpoints: [],
    dbEntities: [],
    backendFileTexts: {},
  };
  const topology = inputs.topology || {};
  const specIndex = Array.isArray(inputs.specIndex) ? inputs.specIndex : [];
  const resultsJson = inputs.resultsJson || null;
  const perfReport = inputs.perfReport || null;
  const outcomesBySpec = groupOutcomesBySpecFile(resultsJson);

  const staticPatterns = (sourceIndex.frontendRoutes || []).map((/** @type {any} */ r) => normalizeRoutePath(r.route));
  const matchStatic = createRoutePatternMatcher(staticPatterns);
  const hasStaticIndex = staticPatterns.length > 0;

  /** @type {Record<string, any>} */
  const routesObj = {};

  const createBlankRoute = (/** @type {string} */ key, source = 'static') => {
    const prev = base.routes?.[key] || {};
    return {
      route: key,
      source,
      title: prev.title || '',
      breadcrumbs: prev.breadcrumbs || [],
      archetype: prev.archetype || 'unknown',
      frontendFile: null,
      tableHeaders: prev.tableHeaders || [],
      filterLabels: prev.filterLabels || [],
      readonlyButtons: prev.readonlyButtons || [],
      mutationButtons: prev.mutationButtons || [],
      linkedApis: [],
      linkedBackendFiles: [],
      linkedDbTables: [],
      coveringSpecs: [],
      lastResult: prev.lastResult || 'untested',
      a11y: prev.a11y || null,
      firstSeenAt: prev.firstSeenAt || now,
      lastSeenAt: prev.lastSeenAt || now,
      stale: false,
      lastUpdatedAt: now,
    };
  };

  const ensureRoute = (/** @type {string} */ rPath, source = 'static') => {
    const normalized = normalizeRoutePath(rPath);
    const key = source === 'runtime' ? matchStatic(normalized) : normalized;
    if (!routesObj[key]) {
      routesObj[key] = createBlankRoute(key, source);
    } else if (source === 'static') {
      routesObj[key].source = 'static';
    }
    return routesObj[key];
  };

  for (const fr of sourceIndex.frontendRoutes || []) {
    const entry = ensureRoute(fr.route, 'static');
    if (fr.file && !entry.frontendFile) entry.frontendFile = fr.file;
    entry.lastSeenAt = now;
  }

  for (const [prevKey, prevRoute] of Object.entries(base.routes || {})) {
    if (routesObj[prevKey]) continue;
    if (hasStaticIndex && prevRoute.frontendFile) continue;
    if (prevRoute.source === 'runtime' || (!prevRoute.frontendFile && prevRoute.archetype !== 'tested-route')) {
      const ageMs = nowMs - Date.parse(prevRoute.lastSeenAt || prevRoute.lastUpdatedAt || now);
      const isStale = Number.isFinite(ageMs) && ageMs > STALE_RUNTIME_DAYS * 86_400_000;
      routesObj[prevKey] = {
        ...prevRoute,
        source: 'runtime',
        coveringSpecs: [],
        stale: isStale,
      };
    }
  }

  const exploredRouteKeys = new Set();
  for (const p of topology.pages || []) {
    const entry = ensureRoute(p.route || p.actualPath || '/', 'runtime');
    exploredRouteKeys.add(entry.route);
    if (p.title) entry.title = p.title;
    if (Array.isArray(p.breadcrumbs) && p.breadcrumbs.length > 0) entry.breadcrumbs = p.breadcrumbs;
    if (p.archetype) entry.archetype = p.archetype;
    if (Array.isArray(p.tableHeaders) && p.tableHeaders.length > 0) entry.tableHeaders = p.tableHeaders;
    if (Array.isArray(p.filterLabels) && p.filterLabels.length > 0) entry.filterLabels = p.filterLabels;
    if (Array.isArray(p.readonlyButtons)) entry.readonlyButtons = [...new Set([...entry.readonlyButtons, ...p.readonlyButtons])];
    if (Array.isArray(p.mutationButtons)) entry.mutationButtons = [...new Set([...entry.mutationButtons, ...p.mutationButtons])];
    if (Array.isArray(p.apisObserved)) entry.linkedApis = [...new Set([...entry.linkedApis, ...p.apisObserved])];
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
    const list = apiToBackend.get(be.path) || [];
    if (!list.includes(be.file)) list.push(be.file);
    apiToBackend.set(be.path, list);
  }
  const matchBackendApi = createRoutePatternMatcher([...apiToBackend.keys()]);

  /** @type {Map<string, string[]>} */
  const apiCallsByFile = new Map();
  for (const c of sourceIndex.frontendApiCalls || []) {
    if (!c?.file || !c?.path) continue;
    let list = apiCallsByFile.get(c.file);
    if (!list) {
      list = [];
      apiCallsByFile.set(c.file, list);
    }
    list.push(c.path);
  }

  const compiledEntities = compileDbEntityMatchers(sourceIndex.dbEntities || []);
  const backendFileTexts = sourceIndex.backendFileTexts || {};

  for (const entry of Object.values(routesObj)) {
    if (entry.frontendFile) {
      const calls = apiCallsByFile.get(entry.frontendFile);
      if (calls) {
        const apiSet = new Set(entry.linkedApis);
        for (const p of calls) {
          if (!apiSet.has(p)) {
            apiSet.add(p);
            entry.linkedApis.push(p);
          }
        }
      }
    }
    const beFiles = new Set();
    for (const apiPath of entry.linkedApis) {
      const matchedBePattern = matchBackendApi(apiPath);
      for (const f of apiToBackend.get(matchedBePattern) || []) beFiles.add(f);
    }
    entry.linkedBackendFiles = [...beFiles];
    entry.linkedDbTables = correlateDbTablesForRoute(entry, sourceIndex.dbEntities || [], backendFileTexts, compiledEntities);
  }

  const staticAndCurrentPatterns = Object.keys(routesObj);
  const matchActive = createRoutePatternMatcher(staticAndCurrentPatterns);
  /** @type {Map<string, Set<string>>} */
  const routeToSpecs = new Map();
  /** @type {Map<string, Set<string>>} */
  const apiToSpecs = new Map();

  for (const sp of specIndex) {
    for (const u of sp.uiRoutes || []) {
      const key = matchActive(u);
      let set = routeToSpecs.get(key);
      if (!set) {
        set = new Set();
        routeToSpecs.set(key, set);
      }
      set.add(sp.specFile);
    }
    for (const api of sp.apiPaths || []) {
      let set = apiToSpecs.get(api);
      if (!set) {
        set = new Set();
        apiToSpecs.set(api, set);
      }
      set.add(sp.specFile);
    }
  }

  for (const entry of Object.values(routesObj)) {
    const matchedSpecs = new Set(routeToSpecs.get(entry.route) || []);
    for (const api of entry.linkedApis) {
      const linked = apiToSpecs.get(api);
      if (linked) {
        for (const sf of linked) matchedSpecs.add(sf);
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

  const portalsByKey = new Map();
  for (const pt of [...(base.portals || []), ...(topology.portals || [])]) {
    if (!pt || !pt.name) continue;
    const key = `${pt.mode || 'default'}:${pt.id ?? pt.name}`;
    portalsByKey.set(key, { ...(portalsByKey.get(key) || {}), ...pt });
  }

  const endpointMap = new Map();
  for (const ep of [...(base.endpoints || []), ...(topology.endpoints || [])]) {
    if (!ep?.endpoint) continue;
    endpointMap.set(`${ep.method || 'GET'} ${ep.endpoint}`, ep);
  }

  const processedSnapshots = new Set(base.processedSnapshots || []);
  const currentSnapshotId = computeTopologySnapshotId(topology);
  const isNewSnapshot = Boolean(currentSnapshotId && !processedSnapshots.has(currentSnapshotId));
  if (currentSnapshotId) processedSnapshots.add(currentSnapshotId);

  const defectMap = new Map();
  for (const d of base.defects || []) defectMap.set(d.key, { ...d });

  const currentBrokenKeys = new Set();
  for (const bi of sourceIndex.brokenRouteImports || []) {
    const key = `broken-import:${bi.route}`;
    currentBrokenKeys.add(key);
    const existing = defectMap.get(key);
    if (existing) {
      existing.status = 'open';
      existing.lastSeenAt = now;
    } else {
      defectMap.set(key, {
        key,
        severity: 'P1',
        type: 'broken-route-import',
        route: bi.route,
        source: bi.routerFile,
        message: `Missing dynamic route target "${bi.importSpec}" (${bi.expectedFile})`,
        status: 'open',
        seenCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }
  for (const [k, d] of defectMap.entries()) {
    if (d.type === 'broken-route-import' && !currentBrokenKeys.has(k)) {
      d.status = 'closed';
      d.resolvedAt = d.resolvedAt || now;
    }
  }

  if (isNewSnapshot) {
    const observedRuntimeKeys = new Set();
    const recordRuntimeDefect = (/** @type {string} */ key, /** @type {string} */ severity, /** @type {string} */ type, /** @type {string} */ route, /** @type {string} */ message) => {
      observedRuntimeKeys.add(key);
      const prev = defectMap.get(key);
      if (prev) {
        prev.status = 'open';
        prev.cleanStreak = 0;
        prev.seenCount = (prev.seenCount || 1) + 1;
        prev.lastSeenAt = now;
        prev.lastSnapshotId = currentSnapshotId;
      } else {
        defectMap.set(key, {
          key,
          severity,
          type,
          route,
          message,
          status: 'open',
          cleanStreak: 0,
          seenCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSnapshotId: currentSnapshotId,
        });
      }
    };

    for (const ce of topology.consoleErrors || []) {
      const route = matchActive(ce.route || '/');
      const msg = String(ce.message || ce).slice(0, 180);
      recordRuntimeDefect(`console:${route}:${msg.slice(0, 60)}`, 'P1', 'console-error', route, msg);
    }
    for (const qa of topology.queryAnomalies || []) {
      const route = matchActive(qa.route || '/');
      recordRuntimeDefect(`query-anomaly:${route}:${qa.detail}`, 'P2', 'malformed-query-param', route, qa.detail);
    }

    for (const [k, d] of defectMap.entries()) {
      if (d.type === 'broken-route-import' || d.status === 'closed') continue;
      if (!observedRuntimeKeys.has(k) && exploredRouteKeys.has(d.route)) {
        d.cleanStreak = Number(d.cleanStreak || 0) + 1;
        if (d.cleanStreak >= 2) {
          d.status = 'closed';
          d.resolvedAt = now;
        } else {
          d.status = 'resolved-candidate';
        }
      }
    }
  }

  const activeRoutes = Object.values(routesObj).filter((r) => !r.stale);
  const coveredRoutes = activeRoutes.filter((r) => r.coveringSpecs.length > 0).length;
  const uncoveredRoutes = activeRoutes.filter((r) => r.coveringSpecs.length === 0).map((r) => r.route);
  const coveragePct = activeRoutes.length > 0 ? Math.round((coveredRoutes / activeRoutes.length) * 100) : 0;

  const perfSnapshots = [...(base.perfSnapshots || [])];
  if (perfReport && perfReport.measuredAt && !perfSnapshots.some((p) => p.measuredAt === perfReport.measuredAt)) {
    perfSnapshots.push({
      measuredAt: perfReport.measuredAt,
      budgetPassed: perfReport.budgetPassed,
      apiP95Ms: perfReport.apiBenchmark?.p95Ms ?? null,
      browserSummary: (perfReport.browserMetrics || []).slice(0, 5).map((/** @type {any} */ m) => ({
        route: m.route,
        ttfbMs: m.ttfbMs,
        fcpMs: m.fcpMs,
        lcpMs: m.lcpMs ?? null,
        cls: m.cls ?? 0,
        domNodes: m.domNodes,
      })),
    });
  }

  const dbTables = (sourceIndex.dbEntities || []).map((/** @type {any} */ d) => d.table);
  const openDefectsCount = [...defectMap.values()].filter((d) => d.status === 'open').length;
  const history = [...(base.history || [])];
  history.push({
    revision,
    day: now.slice(0, 10),
    updatedAt: now,
    totalRoutes: activeRoutes.length,
    coveredRoutes,
    coveragePct,
    endpointsCount: endpointMap.size,
    openDefects: openDefectsCount,
  });

  const nextMap = {
    schemaVersion: SCHEMA_VERSIONS.codeMap,
    version: '4.0',
    revision,
    updatedAt: now,
    contentFingerprint: '',
    baseURL: topology.baseURL || base.baseURL || null,
    techStack: [...new Set([...(base.techStack || []), ...(topology.techStack || [])])],
    portals: [...portalsByKey.values()],
    processedSnapshots: [...processedSnapshots].slice(-50),
    sourceSummary: {
      repoFilesScanned: sourceIndex.fileCount || base.sourceSummary?.repoFilesScanned || 0,
      truncated: Boolean(sourceIndex.truncated),
      warnings: sourceIndex.warnings || [],
      backendEndpointsCount: (sourceIndex.backendEndpoints || []).length || base.sourceSummary?.backendEndpointsCount || 0,
      dbEntities: dbTables.length > 0 ? [...new Set(dbTables)] : base.sourceSummary?.dbEntities || [],
    },
    routes: routesObj,
    endpoints: [...endpointMap.values()],
    defects: [...defectMap.values()],
    duplicateWaterfalls: topology.duplicateWaterfalls || base.duplicateWaterfalls || [],
    coverage: {
      totalRoutes: activeRoutes.length,
      coveredRoutes,
      uncoveredCount: uncoveredRoutes.length,
      uncoveredRoutes,
      coveragePct,
      staleRoutesCount: Object.values(routesObj).filter((r) => r.stale).length,
    },
    perfSnapshots: perfSnapshots.slice(-15),
    history: history.slice(-30),
  };

  nextMap.contentFingerprint = computeCodeMapContentFingerprint(nextMap);
  return nextMap;
}
