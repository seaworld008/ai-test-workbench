// @ts-check
import path from 'node:path';
import { redactSecrets } from '../../core/redact.mjs';

const PROMPT_POISONING_RE =
  /(ignore\s+(?:all\s+)?previous\s+instructions|disregard\s+system\s+prompt|<\s*system\s*>|you\s+are\s+now\s+in\s+developer\s+mode|exfiltrate|send\s+.*\s+to\s+https?:\/\/|\bcurl\s+-X\s+POST\b)/gi;
const JAVA_OBJECT_METHODS = new Set(['getClass', 'equals', 'hashCode', 'toString', 'clone', 'wait', 'notify', 'notifyAll']);
const IGNORED_INFRA_CLIENT_RE = /(?:Obs|Oss|S3|File|Ftp|Sftp|Mail|Sms|Minio|Local|Redis|Cache|Http)Client\.java$/i;
const FRAMEWORK_HUB_RE = /(?:\/framework\/|(?:BaseMapper|BaseDao|BaseService|BaseController|CrudRepository|JpaRepository|IService)[A-Za-z0-9_]*\.java$)/i;
const moduleKeyOf = (/** @type {string} */ f) => {
  const segs = String(f || '').split('/').filter(Boolean);
  const srcIdx = segs.indexOf('src');
  if (srcIdx === 0) return 'src';
  if (srcIdx > 0) return segs.slice(0, Math.min(srcIdx, 2)).join('/');
  return segs.length >= 2 ? `${segs[0]}/${segs[1]}` : segs[0] || '';
};

/**
 * @typedef {{ id: string; name: string; kind: string; file: string; startLine: number; endLine: number; exported?: boolean }} NormalizedGraphSymbol
 * @typedef {{ fromId: string; toId: string; fromFile: string; toFile: string; kind: string; confidence: number }} NormalizedCallEdge
 * @typedef {{ controllerFile: string; controllerMethod: string; httpMethod?: string; routePath?: string; serviceMethods: string[]; mapperMethods: string[]; tables: string[]; crossServiceTargets: string[] }} NormalizedControllerChain
 * @typedef {{ meta: { provider: string; version: string | null; binarySha256: string | null; mode: 'enriched' | 'builtin-fallback'; degradedReason?: string; coverage: { clean: boolean; parsePartialFiles: string[]; skippedFiles: string[]; unresolvedRatio: number } }; symbols: NormalizedGraphSymbol[]; callEdges: NormalizedCallEdge[]; controllerChains: NormalizedControllerChain[]; fileSymbols: Record<string, { symbols: string[]; outboundCalls: string[]; inboundCallers: string[] }> }} NormalizedGraphSnapshot
 */

/** Deterministic UTF-16 code-unit comparator. @param {string} a @param {string} b @returns {number} */
export function compareCodeUnit(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

/**
 * Sanitizes structural graph metadata strings: redacts secrets, neutralizes triple backticks
 * and control chars, and strips prompt-injection payloads (never persists code bodies/comments).
 * @param {unknown} raw
 * @param {number} [maxLen]
 * @returns {string}
 */
export function sanitizeGraphMetadataText(raw, maxLen = 320) {
  if (raw === null || raw === undefined) return '';
  const text = redactSecrets(String(raw))
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/```+/g, "'''")
    .replace(PROMPT_POISONING_RE, '[REDACTED_INJECTION]')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen) : text;
}

/**
 * Normalizes a repository-relative POSIX file path deterministically.
 * @param {unknown} rawPath
 * @param {string} [repoRoot]
 * @param {string} [repoPrefix]
 * @returns {string}
 */
export function normalizeRepoFilePath(rawPath, repoRoot = '', repoPrefix = '') {
  let s = sanitizeGraphMetadataText(rawPath, 512).replace(/\\/g, '/').trim();
  if (!s) return '';
  if (repoRoot) {
    const normRoot = path.resolve(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    if (s.toLowerCase().startsWith(`${normRoot.toLowerCase()}/`)) s = s.slice(normRoot.length + 1);
  }
  s = s.replace(/^\.\/+/, '').replace(/\/{2,}/g, '/');
  if (repoPrefix) {
    const cleanPrefix = repoPrefix.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (cleanPrefix && !s.startsWith(`${cleanPrefix}/`)) s = `${cleanPrefix}/${s}`;
  }
  return s;
}

/** @param {unknown} rawLines @returns {{ startLine: number, endLine: number } | null} */
function parseLineRange(rawLines) {
  if (typeof rawLines !== 'string') return null;
  const m = rawLines.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
  if (!m) return null;
  const s = Number.parseInt(m[1], 10);
  const e = m[2] ? Number.parseInt(m[2], 10) : s;
  return { startLine: Math.max(0, s), endLine: Math.max(s, e) };
}

/**
 * Unwraps CBM `query_graph` / `search_graph` JSON payloads into uniform key-value row objects.
 * Supports `{ columns|cols, rows: [[...]] }`, `{ cols, groups: [{ qn_prefix, file, rows: [[...]] }] }`,
 * object `rows[]`, `results[]`, and `groups[]`.
 * @param {any} rawPayload
 * @returns {Array<Record<string, any>>}
 */
export function extractCypherRows(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return [];
  if (Array.isArray(rawPayload)) return rawPayload.filter((x) => x && typeof x === 'object');
  const rawCols = Array.isArray(rawPayload.columns) ? rawPayload.columns : Array.isArray(rawPayload.cols) ? rawPayload.cols : null;
  const cols = rawCols ? rawCols.map((/** @type {any} */ c) => String(c || '').trim()) : null;
  const unpackRow = (/** @type {any} */ row, /** @type {Record<string, any>} */ base = {}) => {
    /** @type {Record<string, any>} */
    const obj = { ...base };
    if (Array.isArray(row) && cols) {
      for (let i = 0; i < cols.length; i += 1) obj[cols[i]] = row[i];
    } else if (row && typeof row === 'object') {
      Object.assign(obj, row);
    } else return null;
    if (obj.lines && obj.startLine === undefined && obj.start_line === undefined) {
      const lr = parseLineRange(obj.lines);
      if (lr) { obj.startLine = lr.startLine; obj.endLine = lr.endLine; }
    }
    if (!obj.qualified_name && obj.qn_prefix && obj.name) obj.qualified_name = `${obj.qn_prefix}.${obj.name}`;
    return obj;
  };
  if (Array.isArray(rawPayload.rows)) {
    /** @type {Array<Record<string, any>>} */
    const out = [];
    for (const row of rawPayload.rows) { const u = unpackRow(row); if (u) out.push(u); }
    return out;
  }
  if (Array.isArray(rawPayload.results)) {
    return rawPayload.results.filter((/** @type {any} */ r) => r && typeof r === 'object').map((/** @type {any} */ r) => unpackRow(r)).filter(Boolean);
  }
  if (Array.isArray(rawPayload.groups)) {
    /** @type {Array<Record<string, any>>} */
    const flat = [];
    for (const grp of rawPayload.groups) {
      if (!grp || typeof grp !== 'object') continue;
      const base = { ...(grp.file ? { file: grp.file, file_path: grp.file } : {}), ...(grp.qn_prefix ? { qn_prefix: grp.qn_prefix } : {}) };
      const items = Array.isArray(grp.items) ? grp.items : Array.isArray(grp.rows) ? grp.rows : [grp];
      for (const item of items) { const u = unpackRow(item, base); if (u) flat.push(u); }
    }
    return flat;
  }
  return [];
}

/**
 * Normalizes CBM `check_index_coverage` and `index_repository` diagnostics into canonical coverage telemetry.
 * @param {any} rawCoverage
 * @param {any} [rawIndexResult]
 * @param {string} [repoPrefix]
 */
export function normalizeCoverageReport(rawCoverage, rawIndexResult = null, repoPrefix = '') {
  /** @type {Set<string>} */
  const parsePartialSet = new Set();
  /** @type {Set<string>} */
  const skippedSet = new Set();
  const addList = (/** @type {unknown} */ items, /** @type {Set<string>} */ target) => {
    if (!Array.isArray(items)) return;
    for (const item of items) {
      const p = typeof item === 'string' ? item : item && typeof item === 'object' ? /** @type {any} */ (item).path || /** @type {any} */ (item).file || /** @type {any} */ (item).file_path : '';
      const norm = normalizeRepoFilePath(p, '', repoPrefix);
      if (norm) target.add(norm);
    }
  };

  if (rawCoverage && typeof rawCoverage === 'object') {
    addList(rawCoverage.parsePartialFiles || rawCoverage.parse_partial_files, parsePartialSet);
    addList(rawCoverage.skippedFiles || rawCoverage.skipped_files, skippedSet);
    const inspectEntry = (/** @type {any} */ entry) => {
      if (!entry || typeof entry !== 'object') return;
      const st = String(entry.kind || entry.status || '').toLowerCase();
      const fp = normalizeRepoFilePath(entry.path || entry.requested_path || entry.file || entry.file_path, '', repoPrefix);
      if (!fp) return;
      if (st.includes('partial') || st.includes('unusable') || st.includes('error')) parsePartialSet.add(fp);
      else if (st.includes('skip') || st.includes('ignored') || st.includes('missing') || st.includes('not_indexed')) skippedSet.add(fp);
    };
    for (const entry of Array.isArray(rawCoverage.paths) ? rawCoverage.paths : []) inspectEntry(entry);
    for (const sc of Array.isArray(rawCoverage.scopes) ? rawCoverage.scopes : []) {
      for (const entry of Array.isArray(sc?.entries) ? sc.entries : []) inspectEntry(entry);
    }
  }

  let totalFiles = 0;
  let partialCount = parsePartialSet.size;
  let skippedCount = skippedSet.size;
  if (rawIndexResult && typeof rawIndexResult === 'object') {
    totalFiles = Number(rawIndexResult.files_indexed || rawIndexResult.filesIndexed || 0);
    partialCount = Math.max(partialCount, Number(rawIndexResult.parse_partial_count || 0) + Number(rawIndexResult.parse_unusable_count || 0));
    skippedCount = Math.max(skippedCount, Number(rawIndexResult.skipped_count || rawIndexResult.ignored_files_total || 0));
    addList(rawIndexResult.parse_partial_files, parsePartialSet);
    addList(rawIndexResult.skipped_files, skippedSet);
  }

  const parsePartialFiles = [...parsePartialSet].sort(compareCodeUnit);
  const skippedFiles = [...skippedSet].sort(compareCodeUnit);
  const denom = Math.max(1, totalFiles || parsePartialFiles.length + skippedFiles.length);
  const rawRatio =
    typeof rawCoverage?.unresolvedRatio === 'number'
      ? rawCoverage.unresolvedRatio
      : typeof rawCoverage?.unresolved_ratio === 'number'
        ? rawCoverage.unresolved_ratio
        : totalFiles > 0
          ? Number(((partialCount + skippedCount) / denom).toFixed(4))
          : parsePartialFiles.length > 0 ? 1 : 0;
  return {
    clean: parsePartialFiles.length === 0 && partialCount === 0 && String(rawIndexResult?.status || '').toLowerCase() !== 'degraded',
    parsePartialFiles,
    skippedFiles,
    unresolvedRatio: Math.min(1, Math.max(0, Number.isFinite(rawRatio) ? rawRatio : 0)),
  };
}

/**
 * Synthesizes Java Controller -> Service/Impl -> Mapper/Feign call chains from normalized symbols and edges.
 * @param {NormalizedGraphSymbol[]} symbols
 * @param {NormalizedCallEdge[]} callEdges
 * @param {Map<string, { httpMethod?: string, routePath?: string }>} routeMetaBySymbol
 * @returns {NormalizedControllerChain[]}
 */
function buildControllerChains(symbols, callEdges, routeMetaBySymbol) {
  /** @type {Map<string, NormalizedGraphSymbol>} */
  const symById = new Map(symbols.map((s) => [s.id, s]));
  /** @type {Map<string, NormalizedCallEdge[]>} */
  const outByFrom = new Map();
  /** @type {Map<string, string[]>} */
  const implsByInterface = new Map();
  /** @type {Map<string, string[]>} */
  const overrideImplsByIfaceMethod = new Map();
  for (const edge of callEdges) {
    if (edge.kind === 'OVERRIDE') {
      const ov = overrideImplsByIfaceMethod.get(edge.toId) || [];
      if (!ov.includes(edge.fromId)) ov.push(edge.fromId);
      overrideImplsByIfaceMethod.set(edge.toId, ov);
      continue;
    }
    if (edge.kind === 'IMPLEMENTS') {
      const impls = implsByInterface.get(edge.toId) || [];
      impls.push(edge.fromId);
      implsByInterface.set(edge.toId, impls);
    }
    const out = outByFrom.get(edge.fromId) || [];
    out.push(edge);
    outByFrom.set(edge.fromId, out);
  }

  /** @type {NormalizedControllerChain[]} */
  const chains = [];
  for (const ctrl of symbols) {
    if (!/(?:Controller|Endpoint|Resource)\.(?:java|kt|ts|js)$/i.test(ctrl.file)) continue;
    if (ctrl.kind !== 'Method' && ctrl.kind !== 'Function') continue;
    /** @type {Set<string>} */
    const services = new Set();
    /** @type {Set<string>} */
    const mappers = new Set();
    /** @type {Set<string>} */
    const crossService = new Set();
    /** @type {Set<string>} */
    const visited = new Set([ctrl.id]);
    const queue = [{ id: ctrl.id, depth: 0 }];

    const ctrlMod = moduleKeyOf(ctrl.file);
    while (queue.length > 0) {
      const cur = queue.shift();
      if (!cur || cur.depth >= 4) continue;
      for (const edge of outByFrom.get(cur.id) || []) {
        const fromFile = edge.fromFile || symById.get(cur.id)?.file || '';
        const targetFile = edge.toFile || symById.get(edge.toId)?.file || '';
        if (targetFile && FRAMEWORK_HUB_RE.test(targetFile)) continue;
        if (edge.kind === 'CALLS' && edge.confidence < 0.5 && fromFile && targetFile && moduleKeyOf(fromFile) !== moduleKeyOf(targetFile)) continue;
        const isCrossService = edge.kind === 'HTTP_CALLS' || (/(?:Feign|Client|Rpc|Api)\.java$/i.test(targetFile) && !IGNORED_INFRA_CLIENT_RE.test(targetFile));
        if (isCrossService) { crossService.add(edge.toId); continue; }
        const sameCtrlMod = !ctrlMod || !targetFile || moduleKeyOf(targetFile) === ctrlMod;
        if (/(?:Mapper|Dao|Repository)\.(?:java|xml)$/i.test(targetFile)) { if (sameCtrlMod) mappers.add(edge.toId); }
        else if (/(?:Service|Manager|Handler|Biz)(?:Impl)?\.java$/i.test(targetFile)) services.add(edge.toId);
        if (!visited.has(edge.toId)) {
          visited.add(edge.toId); queue.push({ id: edge.toId, depth: cur.depth + 1 });
          const ovImpls = overrideImplsByIfaceMethod.get(edge.toId) || [];
          if (ovImpls.length <= 4) {
            for (const ovImpl of ovImpls) {
              const ovFile = symById.get(ovImpl)?.file || (ovImpl.includes('#') ? ovImpl.split('#')[0] : '');
              if ((ovFile && FRAMEWORK_HUB_RE.test(ovFile)) || visited.has(ovImpl)) continue;
              visited.add(ovImpl); services.add(ovImpl); queue.push({ id: ovImpl, depth: cur.depth + 1 });
            }
          }
          const sep = edge.toId.includes('#') ? '#' : '.';
          const idx = edge.toId.lastIndexOf(sep);
          const implClasses = idx > 0 ? implsByInterface.get(edge.toId.slice(0, idx)) || [] : [];
          if (idx > 0 && implClasses.length <= 4) {
            const method = edge.toId.slice(idx + 1);
            for (const implClass of implClasses) {
              const implMethod = `${implClass.includes('#') ? implClass.split('#')[0] : implClass}${sep}${method}`;
              if (symById.has(implMethod) && !visited.has(implMethod)) { visited.add(implMethod); services.add(implMethod); queue.push({ id: implMethod, depth: cur.depth + 1 }); }
            }
          }
        }
      }
    }

    const routeMeta = routeMetaBySymbol.get(ctrl.id) || routeMetaBySymbol.get(`${ctrl.file}#${ctrl.name}`);
    if (services.size > 0 || mappers.size > 0 || crossService.size > 0 || routeMeta) {
      chains.push({
        controllerFile: ctrl.file,
        controllerMethod: ctrl.name,
        ...(routeMeta?.httpMethod ? { httpMethod: routeMeta.httpMethod } : {}),
        ...(routeMeta?.routePath ? { routePath: routeMeta.routePath } : {}),
        serviceMethods: [...services].sort(compareCodeUnit),
        mapperMethods: [...mappers].sort(compareCodeUnit),
        tables: [],
        crossServiceTargets: [...crossService].sort(compareCodeUnit),
      });
    }
  }
  return chains.sort((a, b) => compareCodeUnit(a.controllerFile, b.controllerFile) || compareCodeUnit(a.controllerMethod, b.controllerMethod));
}

/**
 * Normalizes raw CBM query responses into a deterministic, sanitized `NormalizedGraphSnapshot`.
 * @param {{ provider?: string; version?: string | null; binarySha256?: string | null; rawSymbols?: Array<Record<string, any>>; rawEdges?: Array<Record<string, any>>; rawRoutes?: Array<Record<string, any>>; coverage?: { clean: boolean; parsePartialFiles: string[]; skippedFiles: string[]; unresolvedRatio: number }; repoRoot?: string; repoPrefix?: string }} input
 * @returns {NormalizedGraphSnapshot}
 */
export function normalizeCbmGraphSnapshot(input) {
  const repoRoot = input.repoRoot || '';
  const repoPrefix = input.repoPrefix || '';
  /** @type {Map<string, NormalizedGraphSymbol>} */
  const symbolMap = new Map();

  for (const row of input.rawSymbols || []) {
    if (!row || typeof row !== 'object') continue;
    const file = normalizeRepoFilePath(row.file || row.file_path || row.path, repoRoot, repoPrefix);
    const rawName = sanitizeGraphMetadataText(row.name || '', 160);
    const rawId = sanitizeGraphMetadataText(row.id || row.qualified_name || row.qn, 256);
    const id = rawId || (file && rawName ? `${file}#${rawName}` : '');
    if (!id || !file) continue;
    const startLine = Math.max(0, Number.parseInt(String(row.startLine ?? row.start_line ?? 0), 10) || 0);
    const endLine = Math.max(startLine, Number.parseInt(String(row.endLine ?? row.end_line ?? startLine), 10) || startLine);
    symbolMap.set(id, {
      id,
      name: rawName || sanitizeGraphMetadataText(id.split(/[.:/#]/).pop(), 160),
      kind: sanitizeGraphMetadataText(row.kind || row.label || 'Symbol', 64),
      file,
      startLine,
      endLine,
      ...(typeof row.exported === 'boolean' ? { exported: row.exported } : {}),
    });
  }
  const symbols = [...symbolMap.values()].sort(
    (a, b) => compareCodeUnit(a.file, b.file) || a.startLine - b.startLine || compareCodeUnit(a.id, b.id)
  );

  /** @type {Map<string, NormalizedCallEdge>} */
  const edgeMap = new Map();
  /** @type {Map<string, { httpMethod?: string, routePath?: string }>} */
  const routeMeta = new Map();
  for (const row of input.rawEdges || []) {
    if (!row || typeof row !== 'object') continue;
    const kind = sanitizeGraphMetadataText(row.kind || row.type || 'CALLS', 64).toUpperCase();
    const rawConf = row.confidence !== undefined && row.confidence !== null && row.confidence !== '' ? Number(row.confidence) : NaN;
    const strategy = String(row.strategy || '').trim().toLowerCase();
    const fromFile = normalizeRepoFilePath(row.fromFile || row.from_file, repoRoot, repoPrefix);
    const toFile = normalizeRepoFilePath(row.toFile || row.to_file, repoRoot, repoPrefix);
    const fromName = sanitizeGraphMetadataText(row.fromName || row.from_name || '', 160);
    const toName = sanitizeGraphMetadataText(row.toName || row.to_name || '', 160);
    const fromId = sanitizeGraphMetadataText(row.fromId || row.from_id || row.source || row.from, 256) || (fromFile && fromName ? `${fromFile}#${fromName}` : '');
    const toId = sanitizeGraphMetadataText(row.toId || row.to_id || row.target || row.to, 256) || (toFile && toName ? `${toFile}#${toName}` : '');
    // Keep unique_name mapper calls (>=0.35) & high-conf Spring field suffix_match (>=0.5), drop low-conf noise & Object.*
    if (kind === 'CALLS' && Number.isFinite(rawConf)) {
      const targetShort = toName || (toId ? toId.split(/[.#:/]/).pop() || '' : '');
      if (rawConf < 0.35) continue;
      if (strategy === 'suffix_match' && rawConf < 0.5) continue;
      if (JAVA_OBJECT_METHODS.has(targetShort) && rawConf < 0.7) continue;
    }
    if (kind === 'HANDLES' && fromId && (toName || toId)) {
      const rp = sanitizeGraphMetadataText(row.routePath || row.path || toName || toId, 240);
      if (rp.startsWith('/')) routeMeta.set(fromId, { httpMethod: sanitizeGraphMetadataText(row.httpMethod || row.method, 16).toUpperCase() || undefined, routePath: rp });
      continue;
    }
    if (!fromId || !toId) continue;
    const key = `${fromId}\0${toId}\0${kind}`;
    if (edgeMap.has(key)) continue;
    edgeMap.set(key, {
      fromId,
      toId,
      fromFile: fromFile || symbolMap.get(fromId)?.file || '',
      toFile: toFile || symbolMap.get(toId)?.file || '',
      kind,
      confidence: Number.isFinite(rawConf) ? Math.min(1, Math.max(0, Number(rawConf.toFixed(3)))) : 0.9,
    });
  }
  const callEdges = [...edgeMap.values()].sort(
    (a, b) =>
      compareCodeUnit(a.fromFile, b.fromFile) || compareCodeUnit(a.fromId, b.fromId) ||
      compareCodeUnit(a.toFile, b.toFile) || compareCodeUnit(a.toId, b.toId) || compareCodeUnit(a.kind, b.kind)
  );

  for (const row of input.rawRoutes || []) {
    if (!row || typeof row !== 'object') continue;
    const rFile = normalizeRepoFilePath(row.file || row.file_path, repoRoot, repoPrefix);
    const rName = sanitizeGraphMetadataText(row.name || '', 160);
    const symId = sanitizeGraphMetadataText(row.symbolId || row.id || row.qualified_name, 256) || (rFile && rName ? `${rFile}#${rName}` : '');
    if (!symId) continue;
    routeMeta.set(symId, {
      httpMethod: sanitizeGraphMetadataText(row.httpMethod || row.method, 16).toUpperCase() || undefined,
      routePath: sanitizeGraphMetadataText(row.routePath || row.path || (rName.startsWith('/') ? rName : ''), 240) || undefined,
    });
  }

  /** @type {Map<string, { symbols: Set<string>, outboundCalls: Set<string>, inboundCallers: Set<string> }>} */
  const fileMap = new Map();
  const ensure = (/** @type {string} */ f) => {
    let e = fileMap.get(f);
    if (!e) { e = { symbols: new Set(), outboundCalls: new Set(), inboundCallers: new Set() }; fileMap.set(f, e); }
    return e;
  };
  for (const s of symbols) ensure(s.file).symbols.add(s.id);
  for (const e of callEdges) {
    if (e.fromFile) ensure(e.fromFile).outboundCalls.add(e.toId);
    if (e.toFile) ensure(e.toFile).inboundCallers.add(e.fromId);
  }
  /** @type {Record<string, { symbols: string[], outboundCalls: string[], inboundCallers: string[] }>} */
  const fileSymbols = {};
  for (const fk of [...fileMap.keys()].sort(compareCodeUnit)) {
    const entry = fileMap.get(fk);
    if (entry) {
      fileSymbols[fk] = {
        symbols: [...entry.symbols].sort(compareCodeUnit),
        outboundCalls: [...entry.outboundCalls].sort(compareCodeUnit),
        inboundCallers: [...entry.inboundCallers].sort(compareCodeUnit),
      };
    }
  }

  const baseCov = input.coverage || { clean: true, parsePartialFiles: [], skippedFiles: [], unresolvedRatio: 0 };
  const gapCnt = (baseCov.parsePartialFiles?.length || 0) + (baseCov.skippedFiles?.length || 0);
  const coverage = baseCov.unresolvedRatio >= 1 && fileMap.size > gapCnt
    ? { ...baseCov, unresolvedRatio: Number((gapCnt / Math.max(1, fileMap.size)).toFixed(4)) }
    : baseCov;
  return {
    meta: { provider: input.provider || 'codebase-memory-mcp', version: input.version ?? null, binarySha256: input.binarySha256 ?? null, mode: 'enriched', coverage },
    symbols, callEdges, controllerChains: buildControllerChains(symbols, callEdges, routeMeta), fileSymbols,
  };
}

/** Produces a deterministic empty `builtin-fallback` `NormalizedGraphSnapshot`. @param {string} degradedReason @param {{ provider?: string, version?: string | null, binarySha256?: string | null }} [meta] @returns {NormalizedGraphSnapshot} */
export function createFallbackGraphSnapshot(degradedReason, meta = {}) {
  return {
    meta: {
      provider: meta.provider || 'codebase-memory-mcp', version: meta.version ?? null, binarySha256: meta.binarySha256 ?? null,
      mode: 'builtin-fallback', degradedReason: sanitizeGraphMetadataText(degradedReason, 320) || 'external-engine-unavailable',
      coverage: { clean: false, parsePartialFiles: [], skippedFiles: [], unresolvedRatio: 1 },
    },
    symbols: [], callEdges: [], controllerChains: [], fileSymbols: {},
  };
}
