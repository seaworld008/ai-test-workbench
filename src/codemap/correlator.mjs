// @ts-check
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * @typedef {{ table: string, file: string, tblLower: string, singular: string, plural: string, compactStem: string, wordRe: RegExp }} CompiledDbEntityMatcher
 * @typedef {{ byFile: Map<string, string[]>, byCompactStem: Map<string, string[]>, bySegment: Map<string, string[]>, byWordToken: Map<string, string[]>, dottedMatchers: CompiledDbEntityMatcher[], textTokenCache: WeakMap<object, Map<string, { text: string, tables: string[] }>> }} CompiledDbEntityIndex
 * @typedef {import('./backend-adapters.mjs').JavaFileMeta & { genericEntityTypes?: string[], implementsTypes?: string[], isFeignClient?: boolean, isDubboService?: boolean, isApiImpl?: boolean, isUtilityHub?: boolean }} ExtendedJavaFileMeta
 * @typedef {{ controllerFile: string, services: string[], mappers: string[], tables: string[], crossServiceTargets: string[] }} ControllerDbChain
 */

/** @type {WeakMap<CompiledDbEntityMatcher[], CompiledDbEntityIndex>} */
const ENTITY_INDEX_CACHE = new WeakMap();
const WORD_TOKEN_ONLY_RE = /^[A-Za-z0-9_]+$/;
const NON_WORD_CHAR_RE = /[^A-Za-z0-9_]/;

const JAVA_STEM_SUFFIX_RE = /(?:Controller|ServiceImpl|Service|Mapper|Manager|DO|Entity|PO|VO|ReqVO|RespVO|DTO)$/i;
const AMBIGUOUS_STEMS = new Set(['base', 'common', 'system', 'admin', 'index', 'main', 'user', 'data', 'auth', 'dict', 'dictdata', 'info', 'config', 'type', 'record']);
const FRAMEWORK_BASE_TYPES = new Set(['BaseDO', 'TenantBaseDO', 'BaseMapper', 'BaseMapperX', 'MPJBaseMapper', 'ServiceImpl', 'IService', 'Serializable', 'Object']);
const UTILITY_OR_NOISE_TYPE_RE =
  /(?:ResultBuilder\w*|CommonResult|PageResult|BeanUtils|Convert|Utils|Util|Helper|Constants|Constant|Properties|Enum|Exception|Filter|Interceptor|Aspect|Advice|StrategyFactory|CheckChain|RedisDAO|Producer|Consumer|VO|DTO|Template)$/;
const GLOBAL_SHELL_CTRL_RE = /(?:AuthController|PlatformAuthController|DictDataController|AppDictDataController|CaptchaController)\.java$/i;

/** @param {string} s @returns {string} */
const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** @param {string} name @returns {string} */
function stripJavaStem(name) {
  let cur = path.basename(String(name || '')).replace(/\.[a-z0-9]+$/i, '');
  for (let i = 0; i < 2; i += 1) {
    const next = cur.replace(JAVA_STEM_SUFFIX_RE, '');
    if (next === cur || !next) break;
    cur = next;
  }
  return cur.replace(/_/g, '').toLowerCase();
}

/** @param {string} relFile @returns {string} */
function getModuleScopeKey(relFile) {
  const parts = String(relFile || '').split('/');
  const srcIdx = parts.indexOf('src');
  return srcIdx > 0 ? parts.slice(0, srcIdx).join('/') : parts.slice(0, Math.min(2, parts.length)).join('/');
}

/** @param {any} topology @returns {string | null} */
export function computeTopologySnapshotId(topology) {
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

/** @param {Map<string, string[]>} map @param {string} key @param {string} table */
function pushIndexTable(map, key, table) {
  let list = map.get(key);
  if (!list) { list = []; map.set(key, list); }
  if (!list.includes(table)) list.push(table);
}

/**
 * Pre-compiles DB entity matchers and O(1) lookup indexes ONCE per merge.
 * @param {Array<{ table: string, file: string }>} dbEntities
 * @returns {CompiledDbEntityMatcher[]}
 */
export function compileDbEntityMatchers(dbEntities) {
  /** @type {CompiledDbEntityMatcher[]} */
  const compiled = [];
  /** @type {CompiledDbEntityIndex} */
  const index = {
    byFile: new Map(),
    byCompactStem: new Map(),
    bySegment: new Map(),
    byWordToken: new Map(),
    dottedMatchers: [],
    textTokenCache: new WeakMap(),
  };

  for (const entity of dbEntities || []) {
    if (!entity || !entity.table) continue;
    const table = String(entity.table);
    const file = entity.file || '';
    const tblLower = table.toLowerCase();
    const singular = tblLower.endsWith('s') ? tblLower.slice(0, -1) : tblLower;
    const plural = tblLower.endsWith('s') ? tblLower : `${tblLower}s`;
    const compactStem = tblLower.replace(/_/g, '');
    const item = {
      table,
      file,
      tblLower,
      singular,
      plural,
      compactStem,
      wordRe: new RegExp(`\\b${escapeRegExp(table)}\\b`, 'i'),
    };
    compiled.push(item);

    pushIndexTable(index.byFile, file, table);
    pushIndexTable(index.byCompactStem, compactStem, table);
    pushIndexTable(index.bySegment, tblLower, table);
    pushIndexTable(index.bySegment, singular, table);
    pushIndexTable(index.bySegment, plural, table);
    if (!AMBIGUOUS_STEMS.has(tblLower)) {
      if (WORD_TOKEN_ONLY_RE.test(table)) pushIndexTable(index.byWordToken, tblLower, table);
      else if (NON_WORD_CHAR_RE.test(table)) index.dottedMatchers.push(item);
    }
  }
  ENTITY_INDEX_CACHE.set(compiled, index);
  return compiled;
}

/**
 * Tokenizes a backend file once per `backendFileTexts` map and looks up unique tokens in `byWordToken`.
 * @param {CompiledDbEntityIndex} index
 * @param {Record<string, string>} backendFileTexts
 * @param {string} bf
 * @returns {string[]}
 */
function resolveTextMatchedTables(index, backendFileTexts, bf) {
  if (!backendFileTexts || typeof backendFileTexts !== 'object') return [];
  const text = backendFileTexts[bf];
  if (!text) return [];
  let fileCache = index.textTokenCache.get(backendFileTexts);
  if (!fileCache) { fileCache = new Map(); index.textTokenCache.set(backendFileTexts, fileCache); }
  const cached = fileCache.get(bf);
  if (cached && cached.text === text) return cached.tables;

  /** @type {Set<string>} */
  const hits = new Set();
  if (index.byWordToken.size > 0) {
    const tokens = text.match(/[A-Za-z0-9_]+/g);
    if (tokens) {
      /** @type {Set<string>} */
      const seenTokens = new Set();
      for (let i = 0; i < tokens.length; i += 1) {
        const tok = tokens[i].toLowerCase();
        if (seenTokens.has(tok)) continue;
        seenTokens.add(tok);
        const tbls = index.byWordToken.get(tok);
        if (tbls) for (const t of tbls) hits.add(t);
      }
    }
  }
  for (const dm of index.dottedMatchers) {
    if (!hits.has(dm.table) && dm.wordRe.test(text)) hits.add(dm.table);
  }
  const tables = [...hits];
  fileCache.set(bf, { text, tables });
  return tables;
}

/**
 * Builds a controller-scoped direct-chain Java DB index:
 * `Controller -> injected Service/Impl -> injected Mapper -> BaseMapper<DO> / Mapper.xml SQL tables`,
 * skipping utility/hub classes (`ResultBuilderV2`, `CommonResult`, `PageResult`, `BeanUtils`)
 * and honoring optional CBM symbol call-chain overrides when supplied.
 * @param {Record<string, ExtendedJavaFileMeta>} [javaFileInfos]
 * @param {Array<{ file: string, namespace: string, tables: string[] }>} [mybatisMappers]
 * @param {Array<{ table: string, file: string }>} [dbEntities]
 * @param {{
 *   feignBridges?: Array<{ interfaceFqcn?: string, implFile?: string | null }>,
 *   cbmControllerChains?: Record<string, { tables?: string[], serviceMethods?: string[], mapperMethods?: string[], crossServiceTargets?: string[] }>,
 * }} [options]
 * @returns {{ resolveTablesForBackendFile: (file: string) => string[], resolveChainForBackendFile: (file: string) => ControllerDbChain }}
 */
export function buildJavaDbChainIndex(javaFileInfos = {}, mybatisMappers = [], dbEntities = [], options = {}) {
  /** @type {Map<string, string>} */
  const fqcnToFile = new Map();
  /** @type {Map<string, string[]>} */
  const simpleToFiles = new Map();
  /** @type {Map<string, string[]>} */
  const interfaceToImpls = new Map();
  /** @type {Map<string, string[]>} */
  const fileToTables = new Map();
  /** @type {Map<string, string[]>} */
  const entitySimpleToFiles = new Map();
  /** @type {Map<string, Array<{ file: string, tables: string[] }>>} */
  const xmlByNamespace = new Map();
  /** @type {Map<string, string>} */
  const feignBridgeByFqcn = new Map();

  const pushMap = (/** @type {Map<string, string[]>} */ map, /** @type {string} */ k, /** @type {string} */ v) => {
    const arr = map.get(k) || [];
    if (!arr.includes(v)) arr.push(v);
    map.set(k, arr);
  };

  for (const ent of dbEntities || []) {
    if (ent?.file && ent?.table) pushMap(fileToTables, ent.file, ent.table);
  }
  for (const xm of mybatisMappers || []) {
    if (!xm?.namespace) continue;
    const list = xmlByNamespace.get(xm.namespace) || [];
    list.push({ file: xm.file, tables: xm.tables || [] });
    xmlByNamespace.set(xm.namespace, list);
  }
  for (const fb of options?.feignBridges || []) {
    if (fb?.interfaceFqcn && fb.implFile) feignBridgeByFqcn.set(fb.interfaceFqcn, fb.implFile);
  }
  for (const meta of Object.values(javaFileInfos || {})) {
    if (!meta) continue;
    if (meta.fqcn) fqcnToFile.set(meta.fqcn, meta.relFile);
    if (meta.className) {
      pushMap(simpleToFiles, meta.className, meta.relFile);
      if (meta.isEntity || fileToTables.has(meta.relFile)) pushMap(entitySimpleToFiles, meta.className, meta.relFile);
    }
    for (const sup of meta.implementsTypes?.length ? meta.implementsTypes : meta.superTypes || []) {
      if (!FRAMEWORK_BASE_TYPES.has(sup)) pushMap(interfaceToImpls, sup, meta.relFile);
    }
  }

  /** @param {string} typeName @param {ExtendedJavaFileMeta} fromMeta @returns {string | null} */
  const resolveTypeFile = (typeName, fromMeta) => {
    if (!typeName || FRAMEWORK_BASE_TYPES.has(typeName)) return null;
    for (const imp of fromMeta.imports || []) {
      if (imp.endsWith(`.${typeName}`) && fqcnToFile.has(imp)) return fqcnToFile.get(imp) || null;
    }
    if (fromMeta.packageName && fqcnToFile.has(`${fromMeta.packageName}.${typeName}`)) {
      return fqcnToFile.get(`${fromMeta.packageName}.${typeName}`) || null;
    }
    for (const imp of fromMeta.imports || []) {
      if (imp.endsWith('.*') && fqcnToFile.has(`${imp.slice(0, -1)}${typeName}`)) {
        return fqcnToFile.get(`${imp.slice(0, -1)}${typeName}`) || null;
      }
    }
    const cands = simpleToFiles.get(typeName) || [];
    if (cands.length === 1) return cands[0];
    if (cands.length > 1) {
      const sameMod = cands.filter((c) => getModuleScopeKey(c) === getModuleScopeKey(fromMeta.relFile));
      if (sameMod.length === 1) return sameMod[0];
    }
    return null;
  };

  /** @param {string} depFile @param {ExtendedJavaFileMeta} depMeta @param {ExtendedJavaFileMeta} originMeta @returns {string[]} */
  const resolveImplFiles = (depFile, depMeta, originMeta) => {
    const rawImpls = (interfaceToImpls.get(depMeta.className) || []).filter((f) => {
      const m = javaFileInfos[f];
      return Boolean(m && !m.isUtilityHub && !m.isFeignClient && !m.isController);
    });
    if (rawImpls.length === 0) return [depFile];
    const modKey = getModuleScopeKey(depFile || originMeta.relFile);
    const sameMod = rawImpls.filter((f) => getModuleScopeKey(f) === modKey);
    const pool = sameMod.length > 0 ? sameMod : rawImpls;
    const namedImpl = pool.filter((f) => javaFileInfos[f]?.className === `${depMeta.className}Impl`);
    return namedImpl.length > 0 ? namedImpl : pool.slice(0, 2);
  };

  /** @param {string} mapperFile @param {Set<string>} tables @param {Set<string>} mappers */
  const collectMapperTables = (mapperFile, tables, mappers) => {
    mappers.add(mapperFile);
    for (const t of fileToTables.get(mapperFile) || []) tables.add(t);
    const mapperMeta = javaFileInfos[mapperFile];
    if (!mapperMeta) return;
    for (const xm of xmlByNamespace.get(mapperMeta.fqcn) || []) {
      for (const t of xm.tables) tables.add(t);
    }
    for (const entType of mapperMeta.genericEntityTypes || []) {
      const entFile = resolveTypeFile(entType, mapperMeta);
      if (entFile) {
        for (const t of fileToTables.get(entFile) || []) tables.add(t);
      } else {
        const fb = entitySimpleToFiles.get(entType) || [];
        const scoped = fb.filter((f) => getModuleScopeKey(f) === getModuleScopeKey(mapperFile));
        for (const cf of scoped.length > 0 ? scoped : fb.length === 1 ? fb : []) {
          for (const t of fileToTables.get(cf) || []) tables.add(t);
        }
      }
    }
  };

  /** @type {Map<string, ControllerDbChain>} */
  const chainMemo = new Map();

  /** @param {string} startFile @returns {ControllerDbChain} */
  const resolveChainForBackendFile = (startFile) => {
    const cached = chainMemo.get(startFile);
    if (cached) return cached;

    /** @type {Set<string>} */
    const services = new Set();
    /** @type {Set<string>} */
    const mappers = new Set();
    /** @type {Set<string>} */
    const tables = new Set(fileToTables.get(startFile) || []);
    /** @type {Set<string>} */
    const crossServiceTargets = new Set();

    const cbm = options?.cbmControllerChains?.[startFile];
    if (cbm) {
      for (const t of cbm.tables || []) tables.add(t);
      for (const cs of cbm.crossServiceTargets || []) crossServiceTargets.add(cs);
      for (const sm of cbm.serviceMethods || []) services.add(sm);
      for (const mm of cbm.mapperMethods || []) mappers.add(mm);
      const out = { controllerFile: startFile, services: [...services], mappers: [...mappers], tables: [...tables], crossServiceTargets: [...crossServiceTargets] };
      chainMemo.set(startFile, out);
      return out;
    }

    const startMeta = javaFileInfos[startFile];
    if (!startMeta) {
      const empty = { controllerFile: startFile, services: [], mappers: [], tables: [...tables], crossServiceTargets: [] };
      chainMemo.set(startFile, empty);
      return empty;
    }
    if (startMeta.isMapper) collectMapperTables(startFile, tables, mappers);

    const hop1Types = startMeta.fieldTypes?.length
      ? startMeta.fieldTypes
      : (startMeta.imports || []).map((imp) => imp.split('.').pop() || '').filter((s) => /(?:Service|Mapper|Repository|Dao|Api)$/.test(s));

    for (const depType of hop1Types) {
      if (!depType || FRAMEWORK_BASE_TYPES.has(depType) || UTILITY_OR_NOISE_TYPE_RE.test(depType)) continue;
      const depFile = resolveTypeFile(depType, startMeta);
      if (!depFile || depFile === startFile) continue;
      const depMeta = javaFileInfos[depFile];
      if (!depMeta || depMeta.isUtilityHub) continue;
      if (depMeta.isFeignClient) { crossServiceTargets.add(feignBridgeByFqcn.get(depMeta.fqcn) || depMeta.relFile); continue; }
      if (depMeta.isMapper) { collectMapperTables(depFile, tables, mappers); continue; }
      if (!depMeta.isService && !/Manager$/.test(depMeta.className)) continue;

      for (const implFile of resolveImplFiles(depFile, depMeta, startMeta)) {
        services.add(implFile);
        const implMeta = javaFileInfos[implFile];
        if (!implMeta || implMeta.isUtilityHub) continue;
        const beforeCount = tables.size;
        const implFields = implMeta.fieldTypes?.length
          ? implMeta.fieldTypes
          : (implMeta.imports || []).map((imp) => imp.split('.').pop() || '').filter((s) => /(?:Mapper|Repository|Dao)$/.test(s));

        for (const fType of implFields) {
          if (!fType || FRAMEWORK_BASE_TYPES.has(fType) || UTILITY_OR_NOISE_TYPE_RE.test(fType)) continue;
          const fFile = resolveTypeFile(fType, implMeta);
          const fMeta = fFile ? javaFileInfos[fFile] : null;
          if (!fFile || !fMeta || fMeta.isUtilityHub) continue;
          if (fMeta.isFeignClient) crossServiceTargets.add(feignBridgeByFqcn.get(fMeta.fqcn) || fMeta.relFile);
          else if (fMeta.isMapper || /(?:Mapper|Repository|Dao)$/.test(fMeta.className)) collectMapperTables(fFile, tables, mappers);
        }

        if (tables.size === beforeCount) {
          const svcStem = stripJavaStem(implMeta.className);
          for (const imp of implMeta.imports || []) {
            const ef = fqcnToFile.get(imp);
            if (ef && fileToTables.has(ef) && (!svcStem || stripJavaStem(ef) === svcStem)) {
              for (const t of fileToTables.get(ef) || []) tables.add(t);
            }
          }
        }
      }
    }

    const out = { controllerFile: startFile, services: [...services], mappers: [...mappers], tables: [...tables], crossServiceTargets: [...crossServiceTargets] };
    chainMemo.set(startFile, out);
    return out;
  };

  return { resolveTablesForBackendFile: (f) => resolveChainForBackendFile(f).tables, resolveChainForBackendFile };
}

/**
 * 4-tier controller/entity correlation (`K-04` + Controller-scoped direct Java Service/Mapper/XML chain).
 * @param {{ route: string, linkedApis?: string[], linkedBackendFiles?: string[] }} entry
 * @param {Array<{ table: string, file: string }>} dbEntities
 * @param {Record<string, string>} [backendFileTexts]
 * @param {CompiledDbEntityMatcher[] | null} [compiledEntities]
 * @param {{ resolveTablesForBackendFile: (file: string) => string[] } | null} [javaDbChain]
 * @returns {string[]}
 */
export function correlateDbTablesForRoute(entry, dbEntities, backendFileTexts = {}, compiledEntities = null, javaDbChain = null) {
  const matchers = compiledEntities || compileDbEntityMatchers(dbEntities || []);
  if (matchers.length === 0) return [];

  /** @type {Set<string>} */
  const matched = new Set();
  const routeSegmentSet = new Set(entry.route.toLowerCase().split('/').filter((s) => s && !s.startsWith(':')));
  const apiSegmentSet = new Set(
    (entry.linkedApis || []).flatMap((a) => a.toLowerCase().split('/')).filter((s) => s && s !== 'api' && !/^v\d+$/.test(s) && !s.startsWith(':'))
  );
  const rawLinkedFiles = entry.linkedBackendFiles || [];
  const isAuthOrDictRoute = /\/(?:login|auth|dict)/i.test(entry.route);
  const domainFiles = isAuthOrDictRoute ? rawLinkedFiles : rawLinkedFiles.filter((f) => !GLOBAL_SHELL_CTRL_RE.test(f));
  const linkedFiles = domainFiles.length > 0 ? domainFiles : rawLinkedFiles;
  const linkedFileSet = new Set(linkedFiles);
  const backendStems = linkedFiles.map(stripJavaStem).filter((s) => s.length >= 4 && !AMBIGUOUS_STEMS.has(s));

  if (javaDbChain) {
    for (const bf of linkedFiles) {
      for (const tbl of javaDbChain.resolveTablesForBackendFile(bf)) matched.add(tbl);
    }
  }

  const index = ENTITY_INDEX_CACHE.get(matchers);
  if (index) {
    const addAll = (/** @type {string[] | undefined} */ tbls) => { if (tbls) for (const t of tbls) matched.add(t); };
    for (const bf of linkedFiles) {
      addAll(index.byFile.get(bf));
      addAll(resolveTextMatchedTables(index, backendFileTexts, bf));
    }
    for (const stem of backendStems) addAll(index.byCompactStem.get(stem));
    for (const seg of routeSegmentSet) addAll(index.bySegment.get(seg));
    for (const seg of apiSegmentSet) addAll(index.bySegment.get(seg));
    return [...matched];
  }

  for (const entity of matchers) {
    if (matched.has(entity.table)) continue;
    if (linkedFileSet.has(entity.file)) { matched.add(entity.table); continue; }
    if (!AMBIGUOUS_STEMS.has(entity.tblLower) && linkedFiles.some((bf) => backendFileTexts[bf] && entity.wordRe.test(backendFileTexts[bf]))) {
      matched.add(entity.table);
      continue;
    }
    if (backendStems.length > 0 && backendStems.includes(entity.compactStem)) { matched.add(entity.table); continue; }
    if (
      routeSegmentSet.has(entity.tblLower) || routeSegmentSet.has(entity.singular) || routeSegmentSet.has(entity.plural) ||
      apiSegmentSet.has(entity.tblLower) || apiSegmentSet.has(entity.singular) || apiSegmentSet.has(entity.plural)
    ) {
      matched.add(entity.table);
    }
  }
  return [...matched];
}

/** @param {any} mapCandidate @returns {string} */
export function computeCodeMapContentFingerprint(mapCandidate) {
  const canonicalRoutes = Object.fromEntries(
    Object.entries(mapCandidate.routes || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, {
        route: v.route, source: v.source, archetype: v.archetype, frontendFile: v.frontendFile,
        linkedApis: v.linkedApis, linkedBackendFiles: v.linkedBackendFiles, linkedDbTables: v.linkedDbTables,
        coveringSpecs: v.coveringSpecs, lastResult: v.lastResult, stale: v.stale,
      }])
  );
  const canonicalDefects = (mapCandidate.defects || []).map((/** @type {any} */ d) => ({ key: d.key, status: d.status, seenCount: d.seenCount }));
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify({
    routes: canonicalRoutes, defects: canonicalDefects, endpoints: mapCandidate.endpoints || [],
    coverage: mapCandidate.coverage, perfCount: (mapCandidate.perfSnapshots || []).length,
  })).digest('hex')}`;
}
