// @ts-check
import { redactSecrets } from '../core/redact.mjs';
import { sanitizeUntrustedCodeMetadata } from '../mcp-hub/auditor.mjs';
import { buildJavaDbChainIndex } from './correlator.mjs';
import { getStrippedApiCandidates } from './route-api-linker.mjs';
import { normalizeRoutePath } from './route-matcher.mjs';

const MAX_SERVICE_CHAINS = 500;

/** @param {string} a @param {string} b @returns {number} */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Sanitizes external graph metadata via both secret redaction and prompt-poisoning neutralization.
 * @param {unknown} raw @param {number} [maxLen] @returns {string}
 */
export function cleanGraphStr(raw, maxLen = 260) {
  const s = sanitizeUntrustedCodeMetadata(redactSecrets(String(raw ?? ''))).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** @param {unknown} arr @param {number} [maxLen] @returns {string[]} */
function cleanStrList(arr, maxLen = 260) {
  if (!Array.isArray(arr)) return [];
  return [...new Set(arr.map((x) => cleanGraphStr(x, maxLen)).filter(Boolean))].sort(cmp);
}

/**
 * Sanitizes `normalizedGraphSnapshot` metadata and synthesizes `cbmControllerChains` keyed by `controllerFile`,
 * fusing L0 mapper/DO/XML tables whenever CBM chains supply `mapperMethods` without explicit SQL table names.
 * @param {any} snapshot
 * @param {any} sourceIndex
 */
export function prepareExternalGraphSignals(snapshot, sourceIndex) {
  const rawMeta = snapshot?.meta || null;
  const rawCov = rawMeta?.coverage || null;
  const graphEngine = {
    provider: cleanGraphStr(rawMeta?.provider || 'builtin', 80) || 'builtin',
    version: rawMeta?.version ? cleanGraphStr(rawMeta.version, 64) : null,
    binarySha256: rawMeta?.binarySha256 ? cleanGraphStr(rawMeta.binarySha256, 80) : null,
    mode: rawMeta?.mode === 'enriched' ? 'enriched' : 'builtin-fallback',
    ...(rawMeta?.degradedReason ? { degradedReason: cleanGraphStr(rawMeta.degradedReason, 320) } : {}),
    coverage: {
      clean: Boolean(rawCov?.clean),
      parsePartialFiles: cleanStrList(rawCov?.parsePartialFiles, 260),
      skippedFiles: cleanStrList(rawCov?.skippedFiles, 260),
      unresolvedRatio: typeof rawCov?.unresolvedRatio === 'number' && Number.isFinite(rawCov.unresolvedRatio) ? rawCov.unresolvedRatio : 0,
    },
  };

  /** @type {Record<string, { tables: string[], serviceMethods: string[], mapperMethods: string[], crossServiceTargets: string[] }>} */
  const cbmControllerChains = {};
  /** @type {Map<string, string>} */
  const cbmMethodByCtrlRoute = new Map();
  const rawChains = Array.isArray(snapshot?.controllerChains) ? snapshot.controllerChains : [];
  if (rawChains.length === 0) return { graphEngine, cbmControllerChains, cbmMethodByCtrlRoute };

  const l0Chain = buildJavaDbChainIndex(sourceIndex.javaFileInfos || {}, sourceIndex.mybatisMappers || [], sourceIndex.dbEntities || [], {
    feignBridges: sourceIndex.feignBridges || [],
  });
  /** @type {Map<string, string>} */
  const symFileById = new Map();
  for (const s of Array.isArray(snapshot?.symbols) ? snapshot.symbols : []) {
    if (s?.id && s?.file) symFileById.set(cleanGraphStr(s.id, 260), cleanGraphStr(s.file, 260));
  }
  /** @type {Map<string, string>} */
  const fqcnToFile = new Map();
  for (const meta of Object.values(sourceIndex.javaFileInfos || {})) {
    if (meta?.fqcn && meta?.relFile) fqcnToFile.set(meta.fqcn, meta.relFile);
  }

  for (const ch of rawChains) {
    const cf = cleanGraphStr(ch?.controllerFile, 260);
    if (!cf) continue;
    const cm = cleanGraphStr(ch?.controllerMethod, 120);
    const rp = ch?.routePath ? normalizeRoutePath(cleanGraphStr(ch.routePath, 200)) : '';
    if (cm) {
      if (rp) cbmMethodByCtrlRoute.set(`${cf}|${rp}`, cm);
      if (!cbmMethodByCtrlRoute.has(cf)) cbmMethodByCtrlRoute.set(cf, cm);
    }
    const acc = cbmControllerChains[cf] || (cbmControllerChains[cf] = { tables: [], serviceMethods: [], mapperMethods: [], crossServiceTargets: [] });
    const tables = new Set([...acc.tables, ...cleanStrList(ch?.tables, 120)]);
    const services = new Set([...acc.serviceMethods, ...cleanStrList(ch?.serviceMethods, 240)]);
    const mappers = new Set([...acc.mapperMethods, ...cleanStrList(ch?.mapperMethods, 240)]);
    const cross = new Set([...acc.crossServiceTargets, ...cleanStrList(ch?.crossServiceTargets, 240)]);
    for (const mm of mappers) {
      const mFile = symFileById.get(mm) || (mm.includes('#') ? mm.split('#')[0] : '') || fqcnToFile.get(mm.includes('.') ? mm.slice(0, mm.lastIndexOf('.')) : mm) || '';
      if (mFile) for (const t of l0Chain.resolveTablesForBackendFile(mFile)) tables.add(t);
    }
    // Preserve L0 controller-scoped MyBatis/DO tables & Feign bridges when CBM call graph emits 0 SQL tables
    if (tables.size === 0 || cross.size === 0) {
      const l0Ctrl = l0Chain.resolveChainForBackendFile(cf);
      if (tables.size === 0) for (const t of l0Ctrl.tables) tables.add(t);
      if (cross.size === 0) for (const cs of l0Ctrl.crossServiceTargets) cross.add(cs);
      if (mappers.size === 0) for (const m of l0Ctrl.mappers) mappers.add(m);
      if (services.size === 0) for (const s of l0Ctrl.services) services.add(s);
    }
    if (tables.size === 0 && mappers.size === 0 && services.size === 0) continue;
    acc.tables = [...tables].sort(cmp);
    acc.serviceMethods = [...services].sort(cmp);
    acc.mapperMethods = [...mappers].sort(cmp);
    acc.crossServiceTargets = [...cross].sort(cmp);
  }
  return { graphEngine, cbmControllerChains, cbmMethodByCtrlRoute };
}

/**
 * Builds normalized CodeMap v5 `apis` dictionary, full-stack `serviceChains[]`, and `crossServiceBridges` summary.
 * @param {any} sourceIndex
 * @param {Record<string, any>} routesObj
 * @param {{ resolveChainForBackendFile: (file: string) => import('./correlator.mjs').ControllerDbChain }} javaDbChain
 * @param {Map<string, Set<string>>} apiToSpecs
 * @param {string[]} gatewayPrefixes
 * @param {Map<string, string>} cbmMethodByCtrlRoute
 */
export function buildApisAndServiceChains(sourceIndex, routesObj, javaDbChain, apiToSpecs, gatewayPrefixes, cbmMethodByCtrlRoute) {
  /** @type {Map<string, { method: string, path: string, controllerFile: string | null, controllerMethod: string | null, frontendApiFiles: Set<string>, frontendFnNames: Set<string>, linkedRoutes: Set<string>, linkedDbTables: Set<string>, crossServiceTargets: Set<string>, coveringSpecs: Set<string> }>} */
  const apiMap = new Map();
  /** @type {Map<string, string[]>} */
  const keysByPath = new Map();

  const ensureApi = (/** @type {string} */ rawMethod, /** @type {string} */ rawPath, /** @type {string | null} */ ctrlFile, /** @type {string | null} */ ctrlMethod) => {
    const method = (cleanGraphStr(rawMethod || 'ANY', 16) || 'ANY').toUpperCase();
    const normPath = normalizeRoutePath(cleanGraphStr(rawPath, 240));
    const key = `${method} ${normPath}`;
    let rec = apiMap.get(key);
    if (!rec) {
      rec = {
        method, path: normPath, controllerFile: ctrlFile, controllerMethod: ctrlMethod,
        frontendApiFiles: new Set(), frontendFnNames: new Set(), linkedRoutes: new Set(),
        linkedDbTables: new Set(), crossServiceTargets: new Set(), coveringSpecs: new Set(),
      };
      apiMap.set(key, rec);
      const list = keysByPath.get(normPath) || [];
      if (!list.includes(key)) list.push(key);
      keysByPath.set(normPath, list);
    } else {
      if (!rec.controllerFile && ctrlFile) rec.controllerFile = ctrlFile;
      if (!rec.controllerMethod && ctrlMethod) rec.controllerMethod = ctrlMethod;
    }
    return rec;
  };

  for (const be of sourceIndex.backendEndpoints || []) {
    if (!be?.path) continue;
    const cf = be.file ? cleanGraphStr(be.file, 260) : null;
    const normP = normalizeRoutePath(be.path);
    const cm = cleanGraphStr(be.handler || be.methodName || (cf ? cbmMethodByCtrlRoute.get(`${cf}|${normP}`) || cbmMethodByCtrlRoute.get(cf) : '') || '', 120) || null;
    const rec = ensureApi(be.method || 'ANY', normP, cf, cm);
    if (cf) {
      const chain = javaDbChain.resolveChainForBackendFile(cf);
      for (const t of chain.tables) rec.linkedDbTables.add(t);
      for (const cs of chain.crossServiceTargets) rec.crossServiceTargets.add(cs);
    }
  }

  /** @param {string} rawApiPath */
  const findMatchingKeys = (rawApiPath) => {
    const clean = normalizeRoutePath(String(rawApiPath || '').replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+/i, ''));
    const direct = keysByPath.get(clean);
    if (direct && direct.length > 0) return direct;
    for (const stripped of getStrippedApiCandidates(clean, gatewayPrefixes)) {
      const hit = keysByPath.get(stripped);
      if (hit && hit.length > 0) return hit;
    }
    return [];
  };

  for (const call of sourceIndex.frontendApiCalls || []) {
    if (!call?.path) continue;
    const normP = normalizeRoutePath(call.path);
    const hits = findMatchingKeys(normP);
    const targets = hits.length > 0 ? hits.map((k) => apiMap.get(k)).filter(Boolean) : [ensureApi(call.method || 'ANY', normP, null, null)];
    for (const rec of targets) {
      if (!rec) continue;
      if (call.file) rec.frontendApiFiles.add(cleanGraphStr(call.file, 260));
      if (call.fnName) rec.frontendFnNames.add(cleanGraphStr(call.fnName, 120));
    }
  }

  /** @type {Map<string, string[]>} */
  const xmlByMapper = new Map();
  for (const x of sourceIndex.mybatisXmlLinks || []) {
    if (x?.mapperFile && x?.file) {
      const arr = xmlByMapper.get(x.mapperFile) || [];
      if (!arr.includes(x.file)) arr.push(x.file);
      xmlByMapper.set(x.mapperFile, arr);
    }
  }

  /** @type {Array<Record<string, any>>} */
  const serviceChains = [];
  const seenChain = new Set();

  for (const entry of Object.values(routesObj)) {
    if (entry.stale) continue;
    for (const rawApi of entry.linkedApis || []) {
      for (const k of findMatchingKeys(rawApi)) {
        const rec = apiMap.get(k);
        if (!rec) continue;
        rec.linkedRoutes.add(entry.route);
        for (const sp of entry.coveringSpecs || []) rec.coveringSpecs.add(sp);
        if (rec.controllerFile && serviceChains.length < MAX_SERVICE_CHAINS) {
          const chainKey = `${entry.route}|${k}|${rec.controllerFile}`;
          if (!seenChain.has(chainKey)) {
            seenChain.add(chainKey);
            const ch = javaDbChain.resolveChainForBackendFile(rec.controllerFile);
            const xmlFiles = [...new Set(ch.mappers.flatMap((m) => xmlByMapper.get(m) || []))].sort(cmp);
            const feFiles = [...rec.frontendApiFiles].sort(cmp);
            const fnNames = [...rec.frontendFnNames].sort(cmp);
            serviceChains.push({
              route: entry.route,
              viewFile: entry.frontendFile || null,
              apiMethod: rec.method,
              apiPath: rec.path,
              frontendApiFile: feFiles[0] || null,
              apiFnName: fnNames[0] || null,
              controllerFile: rec.controllerFile,
              controllerMethod: rec.controllerMethod,
              serviceFiles: [...ch.services].sort(cmp),
              feignFiles: [...ch.crossServiceTargets].sort(cmp),
              mapperFiles: [...ch.mappers].sort(cmp),
              xmlFiles,
              dbTables: [...new Set(ch.tables.length > 0 ? ch.tables : entry.linkedDbTables || [])].sort(cmp),
              coveringSpecs: [...(entry.coveringSpecs || [])].sort(cmp),
            });
          }
        }
      }
    }
  }

  for (const rec of apiMap.values()) {
    for (const cand of [rec.path, ...getStrippedApiCandidates(rec.path, gatewayPrefixes)]) {
      for (const sp of apiToSpecs.get(cand) || []) rec.coveringSpecs.add(sp);
    }
  }

  /** @type {Record<string, any>} */
  const apis = {};
  for (const k of [...apiMap.keys()].sort(cmp)) {
    const r = apiMap.get(k);
    if (!r) continue;
    apis[k] = {
      method: r.method,
      path: r.path,
      controllerFile: r.controllerFile,
      controllerMethod: r.controllerMethod,
      frontendApiFiles: [...r.frontendApiFiles].sort(cmp),
      frontendFnNames: [...r.frontendFnNames].sort(cmp),
      linkedRoutes: [...r.linkedRoutes].sort(cmp),
      linkedDbTables: [...r.linkedDbTables].sort(cmp),
      crossServiceTargets: [...r.crossServiceTargets].sort(cmp),
      coveringSpecs: [...r.coveringSpecs].sort(cmp),
    };
  }
  serviceChains.sort((a, b) => cmp(a.route, b.route) || cmp(a.apiPath, b.apiPath) || cmp(a.controllerFile || '', b.controllerFile || ''));

  const crossServiceBridges = {
    feignCount: (sourceIndex.feignBridges || []).length,
    feignLinkedCount: (sourceIndex.feignBridges || []).filter((/** @type {any} */ b) => Boolean(b?.implFile)).length,
    dubboCount: (sourceIndex.dubboServices || []).length,
    mqCount: (sourceIndex.mqEdges || []).length,
    xxlJobCount: (sourceIndex.xxlJobs || []).length,
    mybatisStatementsCount: (sourceIndex.mybatisXmlLinks || []).reduce(
      (/** @type {number} */ sum, /** @type {any} */ x) => sum + (Array.isArray(x?.statements) ? x.statements.length : 0),
      0
    ),
  };

  return { apis, serviceChains, crossServiceBridges };
}
