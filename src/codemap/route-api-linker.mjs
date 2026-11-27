// @ts-check
import { computeTopologySnapshotId } from './correlator.mjs';
import { normalizeRoutePath } from './route-matcher.mjs';
import { matchRoutePathToViewFile, resolveDynamicMenuView } from './vue-template-factory.mjs';

export const KNOWN_GATEWAY_PREFIXES = [
  '/admin-api/platform-api',
  '/admin-api',
  '/platform-api',
  '/app-api',
  '/prod-api',
  '/dev-api',
  '/api',
];

/**
 * Builds deduplicated prefix list sorted longest-first for greedy gateway prefix stripping.
 * @param {string[]} [extraPrefixes]
 * @returns {string[]}
 */
export function collectGatewayPrefixes(extraPrefixes = []) {
  return [...new Set([...KNOWN_GATEWAY_PREFIXES, ...(extraPrefixes || [])].map(normalizeRoutePath).filter((p) => p !== '/'))].sort(
    (a, b) => b.length - a.length
  );
}

/**
 * Strips known gateway / axios prefixes ONLY when the remaining suffix has `>= 2` path segments.
 * @param {string} apiPath
 * @param {readonly string[]} prefixes
 * @returns {string[]}
 */
export function getStrippedApiCandidates(apiPath, prefixes) {
  const norm = normalizeRoutePath(apiPath);
  /** @type {string[]} */
  const out = [];
  for (const pref of prefixes) {
    if (norm === pref) continue;
    if (norm.startsWith(`${pref}/`)) {
      const rest = norm.slice(pref.length);
      const segs = rest.split('/').filter(Boolean);
      if (segs.length >= 2 && !out.includes(rest)) out.push(rest);
    }
  }
  return out;
}

/**
 * Builds reverse frontend import/template graph (`importedOrChildFile -> Set<importerFile>`) and view-file index helpers.
 * @param {Record<string, string[]>} frontendImports
 * @param {string[]} viewFiles
 * @param {Record<string, string[]>} [vueTemplateRefs]
 */
export function buildFrontendViewGraph(frontendImports = {}, viewFiles = [], vueTemplateRefs = {}) {
  /** @type {Map<string, Set<string>>} */
  const reverse = new Map();
  const addEdge = (/** @type {string} */ importer, /** @type {string} */ target) => {
    let set = reverse.get(target);
    if (!set) { set = new Set(); reverse.set(target, set); }
    set.add(importer);
  };
  for (const [importer, targets] of Object.entries(frontendImports || {})) {
    for (const t of targets || []) addEdge(importer, t);
  }
  for (const [parentView, children] of Object.entries(vueTemplateRefs || {})) {
    for (const c of children || []) addEdge(parentView, c);
  }
  return { reverse, viewSet: new Set(viewFiles || []) };
}

/**
 * Finds view files (`views/` or `pages/`) that transitively import or render `startFile` within 1-3 hops,
 * returning `{ file, depth }` entries preferring page views over `/child/` sub-components.
 * @param {string} startFile
 * @param {Map<string, Set<string>>} reverseFrontend
 * @param {Set<string>} viewSet
 * @returns {Array<{ file: string, depth: number }>}
 */
function findImportingViews(startFile, reverseFrontend, viewSet) {
  /** @type {Map<string, number>} */
  const viewDepth = new Map();
  if (viewSet.has(startFile)) viewDepth.set(startFile, 0);
  const visited = new Set([startFile]);
  const queue = [{ file: startFile, depth: 0 }];
  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || cur.depth >= 3) continue;
    for (const imp of reverseFrontend.get(cur.file) || []) {
      if (visited.has(imp)) continue;
      visited.add(imp);
      if (viewSet.has(imp)) viewDepth.set(imp, cur.depth + 1);
      queue.push({ file: imp, depth: cur.depth + 1 });
    }
  }
  const entries = [...viewDepth.entries()].map(([file, depth]) => ({ file, depth }));
  const nonChild = entries.filter((e) => !/\/(?:child|children|components|modals|dialogs|menus|tabs)\//i.test(e.file));
  return nonChild.length > 0 ? nonChild : entries;
}

/**
 * Resolves a dynamic route/page's `frontendFile` using:
 * 1) `page.component` / `page.matchedComponent` against `sourceIndex.viewFiles` (incl. Chinese filenames)
 * 2) observed APIs -> api module -> unique importing view component
 * 3) route path segments against view directory/index files
 * @param {{ route: string, component?: string, matchedComponent?: string, apisObserved?: string[], apis?: string[], observedApis?: string[] }} page
 * @param {string[]} entryLinkedApis
 * @param {{
 *   viewFiles?: string[],
 *   frontendApiCalls?: Array<{ path: string, file: string }>,
 *   reverseFrontend: Map<string, Set<string>>,
 *   viewSet: Set<string>,
 *   prefixes: readonly string[],
 * }} ctx
 * @returns {string | null}
 */
export function resolveDynamicViewForPage(page, entryLinkedApis, ctx) {
  const viewFiles = ctx.viewFiles || [];
  if (viewFiles.length === 0) return null;

  const compSpec = page.component || page.matchedComponent;
  if (compSpec) {
    const hit = resolveDynamicMenuView(compSpec, viewFiles);
    if (hit) return hit;
  }

  const observed = [...(entryLinkedApis || []), ...(page.apisObserved || page.apis || page.observedApis || [])].map(normalizeRoutePath);
  if (observed.length > 0 && Array.isArray(ctx.frontendApiCalls) && ctx.frontendApiCalls.length > 0) {
    /** @type {Set<string>} */
    const observedVariants = new Set(observed);
    for (const obs of observed) {
      for (const stripped of getStrippedApiCandidates(obs, ctx.prefixes)) observedVariants.add(stripped);
    }

    /** @type {Map<string, number>} */
    const viewScores = new Map();
    const routeTokens = normalizeRoutePath(page.route).toLowerCase().split('/').filter((s) => s && !s.startsWith(':'));
    for (const call of ctx.frontendApiCalls) {
      if (!call?.file || !call?.path) continue;
      const callNorm = normalizeRoutePath(call.path);
      if (/\/(?:get-permission-info|list-menus|list-all-simple|unread-count)$/i.test(callNorm)) continue;
      const callVariants = [callNorm, ...getStrippedApiCandidates(callNorm, ctx.prefixes)];
      if (!callVariants.some((v) => observedVariants.has(v))) continue;
      for (const { file: vf, depth } of findImportingViews(call.file, ctx.reverseFrontend, ctx.viewSet)) {
        const hopBonus = Math.max(2, 12 - depth * 3);
        const vfLower = vf.toLowerCase();
        const tokenBonus = routeTokens.reduce((sum, tok) => (vfLower.includes(`/${tok}/`) || vfLower.includes(tok) ? sum + 3 : sum), 0);
        const rootPenalty = /(?:^|\/)src\/views\/index\.vue$/i.test(vf) ? -6 : 0;
        viewScores.set(vf, (viewScores.get(vf) || 0) + hopBonus + tokenBonus + rootPenalty);
      }
    }
    if (viewScores.size > 0) {
      const sorted = [...viewScores.entries()].sort((a, b) => b[1] - a[1]);
      if (sorted.length === 1 || sorted[0][1] > sorted[1][1]) return sorted[0][0];
    }
  }

  return matchRoutePathToViewFile(page.route, viewFiles);
}

/**
 * Formats an API path with its file's exact axios client prefix (avoiding unprefixed collision duplicates).
 * @param {string} rawPath
 * @param {string} filePrefix
 * @returns {string}
 */
function applyExactClientPrefix(rawPath, filePrefix) {
  const norm = normalizeRoutePath(rawPath);
  if (!filePrefix || norm.startsWith(`${filePrefix}/`) || norm === filePrefix) return norm;
  return normalizeRoutePath(`${filePrefix}${norm}`);
}

/** @type {WeakMap<object, { len: number, map: Map<string, Array<{ path: string, fnName?: string }>> }>} */
const richCallsCache = new WeakMap();

/**
 * Follows 1-2 hops of static imports & `<template>` component refs from `frontendFile` and collects API paths.
 * When `options.frontendNamedImports` & `options.frontendApiCalls` (or rich call objects) are supplied,
 * narrows API module imports by exact imported `fnName` instead of dumping every export in the API file.
 * @param {string} frontendFile
 * @param {Record<string, string[]>} frontendImports
 * @param {Map<string, Array<string | { path: string, fnName?: string, method?: string }>>} apiCallsByFile
 * @param {Record<string, string>} axiosPrefixByFile
 * @param {{
 *   frontendNamedImports?: Record<string, Record<string, string[]>>,
 *   frontendApiCalls?: Array<{ method?: string, path: string, file: string, fnName?: string }>,
 *   vueTemplateRefs?: Record<string, string[]>,
 * }} [options]
 * @returns {string[]}
 */
export function collectApisViaStaticImports(
  frontendFile,
  frontendImports = {},
  apiCallsByFile = new Map(),
  axiosPrefixByFile = {},
  options = {}
) {
  const hasRichArr = Array.isArray(options?.frontendApiCalls) && options.frontendApiCalls.length > 0;
  const cacheKey = hasRichArr ? options.frontendApiCalls : apiCallsByFile;
  const cacheLen = hasRichArr ? /** @type {any[]} */ (options.frontendApiCalls).length : apiCallsByFile.size;
  const hit = cacheKey ? richCallsCache.get(cacheKey) : undefined;
  /** @type {Map<string, Array<{ path: string, fnName?: string }>>} */
  let richCallsByFile;
  if (hit && hit.len === cacheLen) {
    richCallsByFile = hit.map;
  } else {
    richCallsByFile = new Map();
    if (hasRichArr) {
      for (const c of /** @type {any[]} */ (options.frontendApiCalls)) {
        if (!c?.file || !c?.path) continue;
        const list = richCallsByFile.get(c.file) || [];
        list.push({ path: c.path, fnName: c.fnName });
        richCallsByFile.set(c.file, list);
      }
    } else {
      for (const [f, list] of apiCallsByFile.entries()) {
        richCallsByFile.set(
          f,
          (list || []).map((item) => (typeof item === 'string' ? { path: item } : { path: item.path, fnName: item.fnName }))
        );
      }
    }
    if (cacheKey) richCallsCache.set(cacheKey, { len: cacheLen, map: richCallsByFile });
  }

  const namedImports = options?.frontendNamedImports || {};
  const templateRefs = options?.vueTemplateRefs || {};

  /** @type {Set<string>} */
  const collected = new Set();
  /** @type {Set<string>} */
  const visitedAll = new Set([frontendFile]);
  /** @type {Map<string, Set<string>>} */
  const visitedNamed = new Map();
  /** @type {Array<{ file: string, depth: number, allowedFns: Set<string> | null }>} */
  const queue = [{ file: frontendFile, depth: 0, allowedFns: null }];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur) continue;
    const calls = richCallsByFile.get(cur.file) || [];
    const filePrefix = axiosPrefixByFile[cur.file] || '';
    if (calls.length > 0) {
      let chosen = calls;
      if (cur.allowedFns && cur.allowedFns.size > 0) {
        const matchedByFn = calls.filter((c) => c.fnName && cur.allowedFns?.has(c.fnName));
        if (matchedByFn.length > 0) chosen = matchedByFn;
      }
      for (const c of chosen) {
        collected.add(applyExactClientPrefix(c.path, filePrefix));
      }
    }
    if (cur.depth >= 2) continue;

    const nextTargets = [...new Set([...(frontendImports[cur.file] || []), ...(templateRefs[cur.file] || [])])];
    const namedForCur = namedImports[cur.file] || {};
    for (const nextFile of nextTargets) {
      const syms = namedForCur[nextFile];
      const isSelective = Array.isArray(syms) && syms.length > 0 && !syms.includes('*') && !syms.includes('default');
      // Prevent depth>=1 helper modules (e.g. SearchSelect/options.js -> remote.js with 150+ APIs) from dumping barrel APIs
      const targetCallCount = richCallsByFile.get(nextFile)?.length || 0;
      if (cur.depth >= 1 && targetCallCount > 15 && (cur.allowedFns !== null || !isSelective)) continue;
      if (!isSelective) {
        if (visitedAll.has(nextFile)) continue;
        visitedAll.add(nextFile);
        queue.push({ file: nextFile, depth: cur.depth + 1, allowedFns: null });
      } else {
        if (visitedAll.has(nextFile)) continue;
        const prevSet = visitedNamed.get(nextFile) || new Set();
        const fresh = syms.filter((s) => !prevSet.has(s));
        if (fresh.length === 0) continue;
        for (const s of fresh) prevSet.add(s);
        visitedNamed.set(nextFile, prevSet);
        queue.push({ file: nextFile, depth: cur.depth + 1, allowedFns: new Set(fresh) });
      }
    }
  }
  return [...collected];
}

/**
 * Convenience helper resolving a view's exact `fnName`-filtered APIs using all rich `sourceIndex` metadata.
 * @param {string} frontendFile
 * @param {{
 *   frontendImports?: Record<string, string[]>,
 *   frontendNamedImports?: Record<string, Record<string, string[]>>,
 *   frontendApiCalls?: Array<{ method?: string, path: string, file: string, fnName?: string }>,
 *   axiosPrefixByFile?: Record<string, string>,
 *   vueTemplateRefs?: Record<string, string[]>,
 * }} sourceIndex
 * @returns {string[]}
 */
export function collectRouteApisWithPrecision(frontendFile, sourceIndex) {
  return collectApisViaStaticImports(
    frontendFile,
    sourceIndex.frontendImports || {},
    new Map(),
    sourceIndex.axiosPrefixByFile || {},
    {
      frontendNamedImports: sourceIndex.frontendNamedImports || {},
      frontendApiCalls: sourceIndex.frontendApiCalls || [],
      vueTemplateRefs: sourceIndex.vueTemplateRefs || {},
    }
  );
}

/**
 * Matches a runtime or frontend API path against indexed backend endpoints.
 * Prefers exact prefixed route hits (0% cross-portal collision); falls back to gateway-prefix-stripped
 * suffixes (`>= 2` segments) ONLY when no prefixed backend route matched directly.
 * @param {string} apiPath
 * @param {(route: string) => string} matchBackendApi
 * @param {Map<string, string[]>} apiToBackend
 * @param {readonly string[]} prefixes
 * @returns {string[]}
 */
export function matchBackendFilesForApi(apiPath, matchBackendApi, apiToBackend, prefixes) {
  const norm = normalizeRoutePath(apiPath);
  const directHits = apiToBackend.get(matchBackendApi(norm));
  if (directHits && directHits.length > 0) return directHits;

  for (const stripped of getStrippedApiCandidates(norm, prefixes)) {
    const hits = apiToBackend.get(matchBackendApi(stripped));
    if (hits && hits.length > 0) return hits;
  }

  const hasGatewayPrefix = prefixes.some((p) => norm === p || norm.startsWith(`${p}/`));
  if (!hasGatewayPrefix) {
    /** @type {Set<string>} */
    const uniquePortalHits = new Set();
    let matchedPortals = 0;
    for (const pref of prefixes) {
      const candidate = normalizeRoutePath(`${pref}${norm}`);
      const hits = apiToBackend.get(matchBackendApi(candidate));
      if (hits && hits.length > 0) {
        matchedPortals += 1;
        for (const h of hits) uniquePortalHits.add(h);
      }
    }
    if (matchedPortals === 1) return [...uniquePortalHits];
  }
  return [];
}

/**
 * Converges broken-import, console-error, and query-anomaly defects and appends perf snapshots.
 * @param {{
 *   base: Record<string, any>,
 *   sourceIndex: any,
 *   topology: any,
 *   perfReport: any,
 *   now: string,
 *   exploredRouteKeys: Set<string>,
 *   matchActive: (route: string) => string,
 * }} params
 */
export function convergeDefectsAndPerf({ base, sourceIndex, topology, perfReport, now, exploredRouteKeys, matchActive }) {
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
        key, severity: 'P1', type: 'broken-route-import', route: bi.route, source: bi.routerFile,
        message: `Missing dynamic route target "${bi.importSpec}" (${bi.expectedFile})`,
        status: 'open', seenCount: 1, firstSeenAt: now, lastSeenAt: now,
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
        prev.status = 'open'; prev.cleanStreak = 0; prev.seenCount = (prev.seenCount || 1) + 1;
        prev.lastSeenAt = now; prev.lastSnapshotId = currentSnapshotId;
      } else {
        defectMap.set(key, {
          key, severity, type, route, message, status: 'open', cleanStreak: 0, seenCount: 1,
          firstSeenAt: now, lastSeenAt: now, lastSnapshotId: currentSnapshotId,
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
        if (d.cleanStreak >= 2) { d.status = 'closed'; d.resolvedAt = now; }
        else { d.status = 'resolved-candidate'; }
      }
    }
  }

  const perfSnapshots = [...(base.perfSnapshots || [])];
  if (perfReport && perfReport.measuredAt && !perfSnapshots.some((p) => p.measuredAt === perfReport.measuredAt)) {
    perfSnapshots.push({
      measuredAt: perfReport.measuredAt,
      budgetPassed: perfReport.budgetPassed,
      apiP95Ms: perfReport.apiBenchmark?.p95Ms ?? null,
      browserSummary: (perfReport.browserMetrics || []).slice(0, 5).map((/** @type {any} */ m) => ({
        route: m.route, ttfbMs: m.ttfbMs, fcpMs: m.fcpMs, lcpMs: m.lcpMs ?? null, cls: m.cls ?? 0, domNodes: m.domNodes,
      })),
    });
  }

  return {
    processedSnapshots: [...processedSnapshots].slice(-50),
    defects: [...defectMap.values()],
    perfSnapshots: perfSnapshots.slice(-15),
  };
}
