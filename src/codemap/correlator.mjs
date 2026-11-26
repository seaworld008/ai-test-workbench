// @ts-check
import crypto from 'node:crypto';
import path from 'node:path';

/**
 * @typedef {{
 *   table: string,
 *   file: string,
 *   tblLower: string,
 *   singular: string,
 *   plural: string,
 *   compactStem: string,
 *   wordRe: RegExp,
 * }} CompiledDbEntityMatcher
 */

const JAVA_STEM_SUFFIX_RE = /(?:Controller|ServiceImpl|Service|Mapper|Manager|DO|Entity|PO|VO|ReqVO|RespVO|DTO)$/i;
const AMBIGUOUS_STEMS = new Set(['base', 'common', 'system', 'admin', 'index', 'main', 'user', 'data', 'auth', 'dict', 'dictdata', 'info', 'config', 'type', 'record']);
const FRAMEWORK_BASE_TYPES = new Set(['BaseDO', 'TenantBaseDO', 'BaseMapper', 'BaseMapperX', 'MPJBaseMapper', 'ServiceImpl', 'IService', 'Serializable', 'Object']);
const GLOBAL_SHELL_CTRL_RE = /(?:AuthController|PlatformAuthController|DictDataController|AppDictDataController|CaptchaController)\.java$/i;

/** @param {string} s @returns {string} */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} name @returns {string} */
function stripJavaStem(name) {
  const base = path.basename(String(name || '')).replace(/\.[a-z0-9]+$/i, '');
  let cur = base;
  for (let i = 0; i < 2; i += 1) {
    const next = cur.replace(JAVA_STEM_SUFFIX_RE, '');
    if (next === cur || !next) break;
    cur = next;
  }
  return cur.replace(/_/g, '').toLowerCase();
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

/**
 * Pre-compiles DB entity matchers ONCE per merge.
 * @param {Array<{ table: string, file: string }>} dbEntities
 * @returns {CompiledDbEntityMatcher[]}
 */
export function compileDbEntityMatchers(dbEntities) {
  /** @type {CompiledDbEntityMatcher[]} */
  const compiled = [];
  for (const entity of dbEntities || []) {
    if (!entity || !entity.table) continue;
    const table = String(entity.table);
    const tblLower = table.toLowerCase();
    const singular = tblLower.endsWith('s') ? tblLower.slice(0, -1) : tblLower;
    const plural = tblLower.endsWith('s') ? tblLower : `${tblLower}s`;
    compiled.push({
      table,
      file: entity.file || '',
      tblLower,
      singular,
      plural,
      compactStem: tblLower.replace(/_/g, ''),
      wordRe: new RegExp(`\\b${escapeRegExp(table)}\\b`, 'i'),
    });
  }
  return compiled;
}

/**
 * Builds a pre-indexed Java symbol/import chain (`Controller -> Service / ServiceImpl -> Mapper / Mapper.xml -> DO`)
 * so `correlateDbTablesForRoute` resolves 2-4 hop DB tables in O(1) per controller.
 * @param {Record<string, import('./backend-adapters.mjs').JavaFileMeta>} [javaFileInfos]
 * @param {Array<{ file: string, namespace: string, tables: string[] }>} [mybatisMappers]
 * @param {Array<{ table: string, file: string }>} [dbEntities]
 * @returns {{ resolveTablesForBackendFile: (file: string) => string[] }}
 */
export function buildJavaDbChainIndex(javaFileInfos = {}, mybatisMappers = [], dbEntities = []) {
  /** @type {Map<string, string[]>} */
  const fqcnToFiles = new Map();
  /** @type {Map<string, string[]>} */
  const simpleToFiles = new Map();
  /** @type {Map<string, string[]>} */
  const interfaceToImpls = new Map();
  /** @type {Map<string, string[]>} */
  const fileToTables = new Map();
  /** @type {Map<string, Array<{ file: string, tables: string[] }>>} */
  const xmlByNamespace = new Map();

  for (const ent of dbEntities || []) {
    if (!ent?.file || !ent?.table) continue;
    const list = fileToTables.get(ent.file) || [];
    if (!list.includes(ent.table)) list.push(ent.table);
    fileToTables.set(ent.file, list);
  }
  for (const xm of mybatisMappers || []) {
    if (!xm?.namespace) continue;
    const list = xmlByNamespace.get(xm.namespace) || [];
    list.push({ file: xm.file, tables: xm.tables || [] });
    xmlByNamespace.set(xm.namespace, list);
  }

  const pushMap = (/** @type {Map<string, string[]>} */ map, /** @type {string} */ k, /** @type {string} */ v) => {
    const arr = map.get(k) || [];
    if (!arr.includes(v)) arr.push(v);
    map.set(k, arr);
  };

  for (const meta of Object.values(javaFileInfos || {})) {
    if (!meta) continue;
    if (meta.fqcn) pushMap(fqcnToFiles, meta.fqcn, meta.relFile);
    if (meta.className) pushMap(simpleToFiles, meta.className, meta.relFile);
    for (const sup of meta.superTypes || []) {
      pushMap(interfaceToImpls, sup, meta.relFile);
    }
  }

  /** @type {Map<string, string[]>} */
  const memo = new Map();

  const resolveTablesForBackendFile = (/** @type {string} */ startFile) => {
    const cached = memo.get(startFile);
    if (cached) return cached;

    /** @type {Set<string>} */
    const tables = new Set(fileToTables.get(startFile) || []);
    const visited = new Set([startFile]);
    const queue = [{ file: startFile, depth: 0 }];

    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur) continue;
      for (const t of fileToTables.get(cur.file) || []) tables.add(t);
      const meta = javaFileInfos[cur.file];
      if (!meta) continue;
      for (const xm of xmlByNamespace.get(meta.fqcn) || []) {
        for (const t of xm.tables) tables.add(t);
      }
      if (cur.depth >= 3) continue;

      /** @type {Set<string>} */
      const nextFiles = new Set();
      for (const imp of meta.imports || []) {
        for (const f of fqcnToFiles.get(imp) || []) nextFiles.add(f);
        const simple = imp.split('.').pop();
        if (simple && !FRAMEWORK_BASE_TYPES.has(simple)) {
          for (const implFile of interfaceToImpls.get(simple) || []) nextFiles.add(implFile);
        }
      }
      for (const ft of [...(meta.fieldTypes || []), ...(meta.superTypes || [])]) {
        if (FRAMEWORK_BASE_TYPES.has(ft)) continue;
        const candidates = simpleToFiles.get(ft) || [];
        if (candidates.length === 1) nextFiles.add(candidates[0]);
        const impls = interfaceToImpls.get(ft) || [];
        if (impls.length === 1) nextFiles.add(impls[0]);
      }
      for (const nf of nextFiles) {
        if (!visited.has(nf)) {
          visited.add(nf);
          queue.push({ file: nf, depth: cur.depth + 1 });
        }
      }
    }
    const out = [...tables];
    memo.set(startFile, out);
    return out;
  };

  return { resolveTablesForBackendFile };
}

/**
 * 4-tier controller/entity correlation (`K-04` + Java Service/Mapper/XML chain):
 * 1) Direct file or literal table word in controller
 * 2) 2-4 hop Java import/field/interface-impl/Mapper.xml chain
 * 3) Unambiguous prefix-stripped Java entity stem match
 * 4) Route & API segment exact match
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
      for (const tbl of javaDbChain.resolveTablesForBackendFile(bf)) {
        matched.add(tbl);
      }
    }
  }

  for (const entity of matchers) {
    if (matched.has(entity.table)) continue;
    if (linkedFileSet.has(entity.file)) {
      matched.add(entity.table);
      continue;
    }
    let controllerRefsEntity = false;
    for (const bf of linkedFiles) {
      const src = backendFileTexts[bf];
      if (src && entity.wordRe.test(src)) {
        controllerRefsEntity = true;
        break;
      }
    }
    if (controllerRefsEntity) {
      matched.add(entity.table);
      continue;
    }
    if (backendStems.length > 0 && backendStems.includes(entity.compactStem)) {
      matched.add(entity.table);
      continue;
    }
    if (
      routeSegmentSet.has(entity.tblLower) ||
      routeSegmentSet.has(entity.singular) ||
      routeSegmentSet.has(entity.plural) ||
      apiSegmentSet.has(entity.tblLower) ||
      apiSegmentSet.has(entity.singular) ||
      apiSegmentSet.has(entity.plural)
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
