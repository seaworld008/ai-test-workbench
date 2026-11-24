// @ts-check
import crypto from 'node:crypto';
import { groupOutcomesBySpecFile } from '../core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from '../core/version.mjs';
import { matchRuntimeRouteToPattern, normalizeRoutePath } from './adapters.mjs';

const STALE_RUNTIME_DAYS = 14;

/** @param {any} topology @returns {string | null} */
function computeTopologySnapshotId(topology) {
  if (!topology || typeof topology !== 'object') return null;
  if (topology.snapshotId) return String(topology.snapshotId);
  if (!topology.exploredAt && (!Array.isArray(topology.pages) || topology.pages.length === 0)) return null;
  const raw = JSON.stringify({
    exploredAt: topology.exploredAt || '',
    pages: (topology.pages || []).map((/** @type {any} */ p) => p.route),
    consoleErrors: topology.consoleErrors || [],
    queryAnomalies: topology.queryAnomalies || [],
  });
  return `snap_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

/** @param {string} s @returns {string} */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Precise controller/entity correlation (`K-04`): avoids naive substring pollution (`user` matching `/user-guide`).
 * @param {{ route: string, linkedApis?: string[], linkedBackendFiles?: string[] }} entry
 * @param {Array<{ table: string, file: string }>} dbEntities
 * @param {Record<string, string>} [backendFileTexts]
 * @returns {string[]}
 */
export function correlateDbTablesForRoute(entry, dbEntities, backendFileTexts = {}) {
  const matched = /** @type {Set<string>} */ (new Set());
  const routeSegments = entry.route
    .toLowerCase()
    .split('/')
    .filter((s) => s && !s.startsWith(':'));
  const apiSegments = (entry.linkedApis || [])
    .flatMap((a) => a.toLowerCase().split('/'))
    .filter((s) => s && s !== 'api' && !/^v\d+$/.test(s) && !s.startsWith(':'));

  for (const entity of dbEntities || []) {
    const tbl = entity.table;
    const tblLower = tbl.toLowerCase();
    const singular = tblLower.endsWith('s') ? tblLower.slice(0, -1) : tblLower;
    const plural = tblLower.endsWith('s') ? tblLower : `${tblLower}s`;

    if ((entry.linkedBackendFiles || []).includes(entity.file)) {
      matched.add(tbl);
      continue;
    }
    const controllerRefsEntity = (entry.linkedBackendFiles || []).some((bf) => {
      const src = backendFileTexts[bf];
      return src ? new RegExp(`\\b${escapeRegExp(tbl)}\\b`, 'i').test(src) : false;
    });
    if (controllerRefsEntity) {
      matched.add(tbl);
      continue;
    }

    if (
      routeSegments.includes(tblLower) ||
      routeSegments.includes(singular) ||
      routeSegments.includes(plural) ||
      apiSegments.includes(tblLower) ||
      apiSegments.includes(singular) ||
      apiSegments.includes(plural)
    ) {
      matched.add(tbl);
    }
  }
  return [...matched];
}

/** @param {any} mapCandidate @returns {string} */
function computeCodeMapContentFingerprint(mapCandidate) {
  const canonicalRoutes = Object.fromEntries(
    Object.entries(mapCandidate.routes || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [
        k,
        {
          route: v.route,
          source: v.source,
          archetype: v.archetype,
          frontendFile: v.frontendFile,
          linkedApis: v.linkedApis,
          linkedBackendFiles: v.linkedBackendFiles,
          linkedDbTables: v.linkedDbTables,
          coveringSpecs: v.coveringSpecs,
          lastResult: v.lastResult,
          stale: v.stale,
        },
      ])
  );
  const canonicalDefects = (mapCandidate.defects || []).map((/** @type {any} */ d) => ({
    key: d.key,
    status: d.status,
    seenCount: d.seenCount,
  }));
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        routes: canonicalRoutes,
        defects: canonicalDefects,
        endpoints: mapCandidate.endpoints || [],
        coverage: mapCandidate.coverage,
        perfCount: (mapCandidate.perfSnapshots || []).length,
      })
    )
    .digest('hex')}`;
}

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
 * Living Code Map v2 (`schemaVersion: 4`) with dynamic route matching, stale route/spec pruning,
 * snapshot-idempotent defect lifecycle (`open -> resolved-candidate -> closed`), and daily history aggregation (`K-01..K-06`).
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
  const hasStaticIndex = (sourceIndex.frontendRoutes || []).length > 0;

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
    const key = source === 'runtime' ? matchRuntimeRouteToPattern(normalized, staticPatterns) : normalized;
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

  const apiToBackend = new Map();
  for (const be of sourceIndex.backendEndpoints || []) {
    const list = apiToBackend.get(be.path) || [];
    if (!list.includes(be.file)) list.push(be.file);
    apiToBackend.set(be.path, list);
  }

  for (const entry of Object.values(routesObj)) {
    if (entry.frontendFile) {
      const calls = (sourceIndex.frontendApiCalls || []).filter((/** @type {any} */ c) => c.file === entry.frontendFile);
      for (const c of calls) {
        if (!entry.linkedApis.includes(c.path)) entry.linkedApis.push(c.path);
      }
    }
    const beFiles = new Set();
    for (const apiPath of entry.linkedApis) {
      const matchedBePattern = matchRuntimeRouteToPattern(apiPath, [...apiToBackend.keys()]);
      for (const f of apiToBackend.get(matchedBePattern) || []) beFiles.add(f);
    }
    entry.linkedBackendFiles = [...beFiles];
    entry.linkedDbTables = correlateDbTablesForRoute(entry, sourceIndex.dbEntities || [], sourceIndex.backendFileTexts || {});
  }

  const staticAndCurrentPatterns = Object.keys(routesObj);
  for (const entry of Object.values(routesObj)) {
    const matchedSpecs = new Set();
    for (const sp of specIndex) {
      const normalizedSpecRoutes = (sp.uiRoutes || []).map((u) => matchRuntimeRouteToPattern(u, staticAndCurrentPatterns));
      if (normalizedSpecRoutes.includes(entry.route)) matchedSpecs.add(sp.specFile);
      if (entry.linkedApis.some((/** @type {string} */ a) => sp.apiPaths.includes(a))) matchedSpecs.add(sp.specFile);
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
      const route = matchRuntimeRouteToPattern(ce.route || '/', staticAndCurrentPatterns);
      const msg = String(ce.message || ce).slice(0, 180);
      recordRuntimeDefect(`console:${route}:${msg.slice(0, 60)}`, 'P1', 'console-error', route, msg);
    }
    for (const qa of topology.queryAnomalies || []) {
      const route = matchRuntimeRouteToPattern(qa.route || '/', staticAndCurrentPatterns);
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
