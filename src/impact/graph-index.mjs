// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../core/proc.mjs';
import { canonicalFsPath, resolveGitRoot } from '../kernel/gate-kernel.mjs';
import { buildLabeledRepoRoots } from './global-infra-guard.mjs';
import { CONTAINER_SYMBOL_KINDS, HIGH_FAN_IN_CALLER_LIMIT, HIGH_FAN_IN_SENTINEL, ORPHAN_PRUNE_FILE_RE, PIPE_SHARDED_FORMAT, hydrateGraphImpactIndex, isNoiseGraphFile, isNoiseGraphSymbol, selectInnermostHunkSymbols } from './graph-index-codec.mjs';

export const GRAPH_IMPACT_INDEX_SCHEMA_VERSION = 1;
const NON_CODE_PARTIAL_RE = /(?:^|\/)(?:\.env(?:\.[^/]+)?|[^/]+\.(?:md|markdown|txt|rst|log|lock|svg|png|jpe?g|gif|ico|map))$/i;

/** @param {string} a @param {string} b @returns {number} */
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
/** @param {string} p @returns {string} */
const normPath = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '');
/** @param {string} route @returns {string} */
function normRoute(route) {
  const clean = String(route || '').trim().replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|ANY)\s+/i, '').split('?')[0];
  if (!clean) return '';
  const lead = clean.startsWith('/') ? clean : `/${clean}`;
  return lead.length > 1 ? lead.replace(/\/+$/, '') : lead;
}
/** @param {Record<string, string[]>} map @param {string} k @param {string} v */
function pushUniq(map, k, v) { if (k && v) { const a = map[k] || (map[k] = []); if (!a.includes(v)) a.push(v); } }
/** @param {Record<string, string[]>} obj @returns {Record<string, string[]>} */
const sortMapArr = (obj) => Object.fromEntries(Object.keys(obj).sort(cmp).map((k) => [k, [...new Set(obj[k])].sort(cmp)]));
/** @param {Record<string, any>} obj */
const sortKeys = (obj) => Object.fromEntries(Object.keys(obj).sort(cmp).map((k) => [k, obj[k]]));
/** @param {any[]} arr @returns {string[]} */
const sortedNormSet = (arr) => [...new Set((arr || []).map(normPath).filter(Boolean))].sort(cmp);

/**
 * Builds a compact, deterministic `knowledge/graph-impact-index.json` projection from
 * L0 `sourceIndex`, optional sidecar `normalizedGraphSnapshot`, and `codeMap` (v4/v5).
 * @param {Record<string, any> | null} [sourceIndex]
 * @param {Record<string, any> | null} [normalizedGraphSnapshot]
 * @param {Record<string, any> | null} [codeMap]
 */
export function buildGraphImpactIndex(sourceIndex = null, normalizedGraphSnapshot = null, codeMap = null) {
  const src = sourceIndex || {};
  const snap = normalizedGraphSnapshot || {};
  const cm = codeMap || {};
  const meta = snap.meta || {};
  const cov = meta.coverage || {};

  /** @type {Record<string, Array<{ id: string, name: string, kind: string, startLine: number, endLine: number, exported?: boolean }>>} */
  const fileSymbols = {};
  /** @type {Record<string, string[]>} */ const symbolCallers = {};
  /** @type {Record<string, string[]>} */ const feignToImpl = {};
  /** @type {Record<string, string[]>} */ const implToFeign = {};
  /** @type {Record<string, string[]>} */ const mybatisToMapper = {};
  /** @type {Record<string, Array<{ method: string, path: string, controllerFile: string, handler?: string }>>} */ const controllerEndpoints = {};
  /** @type {Record<string, Array<{ apiFile: string, fnName: string, method?: string }>>} */ const routeToVueApis = {};
  /** @type {Record<string, string[]>} */ const vueApiToViews = {};
  /** @type {Record<string, string[]>} */ const vueComponentParents = {};
  /** @type {Record<string, { name: string, tags: string[], consumers: string[], complete: boolean }>} */ const globalComponents = {};
  /** @type {Record<string, string[]>} */ const viewToSpecs = {};
  /** @type {Record<string, string[]>} */ const endpointToSpecs = {};

  const addSym = (/** @type {string} */ rawFile, /** @type {any} */ sym) => {
    const file = normPath(rawFile || sym?.file);
    if (!file || !sym?.name || isNoiseGraphFile(file)) return;
    const id = String(sym.id || `${file}#${sym.name}`);
    const list = fileSymbols[file] || (fileSymbols[file] = []);
    if (!list.some((s) => s.id === id)) list.push({ id, name: String(sym.name), kind: String(sym.kind || 'function'), startLine: Math.max(1, Number(sym.startLine || 1)), endLine: Math.max(1, Number(sym.endLine || sym.startLine || 1)), ...(sym.exported !== undefined ? { exported: Boolean(sym.exported) } : {}) });
  };
  const addEp = (/** @type {string} */ k, /** @type {string} */ cf, /** @type {string} */ rp, /** @type {string} */ m = 'ANY', /** @type {string} */ h = '') => {
    const p = normRoute(rp);
    if (!k || !p) return;
    const arr = controllerEndpoints[k] || (controllerEndpoints[k] = []);
    if (!arr.some((e) => e.path === p && e.method === m && e.controllerFile === cf)) arr.push({ method: String(m || 'ANY').toUpperCase(), path: p, controllerFile: cf, ...(h ? { handler: h } : {}) });
  };

  /** @type {Map<string, { file: string, name: string }>} */
  const symInfoById = new Map();
  for (const sym of snap.symbols || []) {
    addSym(sym.file, sym);
    const nf = normPath(sym?.file);
    if (sym?.id && nf && sym?.name) symInfoById.set(String(sym.id), { file: nf, name: String(sym.name) });
  }
  for (const [f, entry] of Object.entries(snap.fileSymbols || {})) {
    for (const sym of entry?.symbols || []) addSym(f, sym);
    for (const c of entry?.inboundCallers || []) if (c?.toId && c?.fromId) pushUniq(symbolCallers, String(c.toId), String(c.fromId));
  }
  const addCallerEdge = (/** @type {string} */ targetId, /** @type {string} */ callerId, /** @type {string} */ targetAlias, /** @type {string} */ callerAlias) => {
    if (targetId === callerId || isNoiseGraphSymbol(targetId) || isNoiseGraphSymbol(callerId)) return;
    pushUniq(symbolCallers, targetId, callerId);
    if (targetAlias && callerAlias && (targetAlias !== targetId || callerAlias !== callerId)) {
      if (!isNoiseGraphSymbol(targetAlias) && !isNoiseGraphSymbol(callerAlias)) {
        pushUniq(symbolCallers, targetAlias, callerAlias);
        if (targetAlias !== targetId) pushUniq(symbolCallers, targetAlias, callerId);
        if (callerAlias !== callerId) pushUniq(symbolCallers, targetId, callerAlias);
      }
    }
  };
  for (const e of snap.callEdges || []) {
    if (!e?.toId || !e?.fromId) continue;
    const fromId = String(e.fromId);
    const toId = String(e.toId);
    const kind = String(e.kind || 'CALLS').toUpperCase();
    const fromInfo = symInfoById.get(fromId);
    const toInfo = symInfoById.get(toId);
    const fromAlias = fromInfo ? `${fromInfo.file}#${fromInfo.name}` : (normPath(e.fromFile) && fromId.includes('#') ? fromId : '');
    const toAlias = toInfo ? `${toInfo.file}#${toInfo.name}` : (normPath(e.toFile) && toId.includes('#') ? toId : '');
    // For OVERRIDE / IMPLEMENTS (Impl.foo -> Interface.foo), editing Impl.foo affects callers of Interface.foo!
    if (kind === 'OVERRIDE' || kind === 'IMPLEMENTS') addCallerEdge(fromId, toId, fromAlias, toAlias);
    else addCallerEdge(toId, fromId, toAlias, fromAlias);
  }

  for (const xml of [...(src.mybatisXmlLinks || []), ...(src.mybatisMappers || [])]) {
    const xf = normPath(xml?.file); const mf = normPath(xml?.mapperFile || '');
    for (const st of xml?.statements || []) {
      if (!xf || !st?.id) continue;
      const id = `${xf}#${st.id}`;
      addSym(xf, { id, name: st.id, kind: 'mybatis-statement', startLine: st.startLine || 1, endLine: st.endLine || st.startLine || 1 });
      if (mf) { pushUniq(mybatisToMapper, id, `${mf}#${st.id}`); pushUniq(symbolCallers, id, `${mf}#${st.id}`); }
      if (xml.namespace) pushUniq(mybatisToMapper, id, `${xml.namespace}.${st.id}`);
    }
  }
  for (const fb of [...(src.feignBridges || []), ...(src.dubboServices || [])]) {
    const cf = normPath(fb?.clientFile || fb?.interfaceFile || fb?.feignFile || '');
    const imf = normPath(fb?.implFile || fb?.providerFile || '');
    for (const m of fb?.methods || []) {
      const mn = typeof m === 'string' ? m : m?.name;
      const mLine = typeof m === 'object' && typeof m?.line === 'number' ? m.line : 1;
      if (cf && mn) addSym(cf, { id: `${cf}#${mn}`, name: mn, kind: 'feign-method', startLine: mLine, endLine: mLine + 2, exported: true });
      if (cf && imf && mn) { pushUniq(implToFeign, `${imf}#${mn}`, `${cf}#${mn}`); pushUniq(feignToImpl, `${cf}#${mn}`, `${imf}#${mn}`); }
    }
    if (cf && imf) { pushUniq(feignToImpl, cf, imf); pushUniq(implToFeign, imf, cf); }
  }
  for (const fc of src.feignMethodCallers || []) {
    const ff = normPath(fc?.feignFile);
    const cf = normPath(fc?.callerFile);
    if (!ff || !cf || !fc?.feignMethod) continue;
    const callerSym = fc.callerMethod ? `${cf}#${fc.callerMethod}` : cf;
    pushUniq(symbolCallers, `${ff}#${fc.feignMethod}`, callerSym);
    if (fc.callerMethod && fc.callerLine) addSym(cf, { id: callerSym, name: fc.callerMethod, kind: 'method', startLine: fc.callerLine, endLine: fc.callerLine + 1 });
  }
  for (const ep of src.backendEndpoints || []) {
    const cf = normPath(ep?.file); const h = String(ep?.handler || ep?.methodName || '');
    for (const p of [ep?.path, ...(ep?.aliasedPaths || [])].filter(Boolean)) addEp(h ? `${cf}#${h}` : cf, cf, p, ep.method, h);
  }
  const hasPrefixedEp = (/** @type {string} */ k, /** @type {string} */ rawPath) => {
    const p = normRoute(rawPath); const arr = p ? controllerEndpoints[k] : null;
    return Boolean(Array.isArray(arr) && arr.some((e) => e.path === p || (e.path.length > p.length && e.path.endsWith(p))));
  };
  const srcChains = Array.isArray(src.controllerChains) ? src.controllerChains : Object.values(src.controllerChains || {});
  for (const ch of [...(snap.controllerChains || []), ...srcChains]) {
    const cf = normPath(ch?.controllerFile); const hm = String(ch?.controllerMethod || '');
    const k = hm ? `${cf}#${hm}` : cf;
    if (cf && ch?.routePath && !hasPrefixedEp(k, ch.routePath)) addEp(k, cf, ch.routePath, ch.httpMethod || 'ANY', hm);
  }
  const prefMap = src.axiosPrefixByFile || {};
  for (const c of src.frontendApiCalls || []) {
    const af = normPath(c?.file); const rp = normRoute(c?.path);
    if (!af || !rp) continue;
    const pref = normRoute(prefMap[af] || '');
    const fp = pref && !rp.startsWith(`${pref}/`) && rp !== pref ? normRoute(`${pref}${rp}`) : rp;
    const fn = String(c?.fnName || c?.name || ''); const method = c?.method ? String(c.method).toUpperCase() : undefined;
    for (const p of [...new Set([fp, rp])]) {
      const arr = routeToVueApis[p] || (routeToVueApis[p] = []);
      if (!arr.some((a) => a.apiFile === af && a.fnName === fn)) arr.push({ apiFile: af, fnName: fn, ...(method ? { method } : {}) });
    }
    if (fn && c?.startLine) addSym(af, { id: `${af}#${fn}`, name: fn, kind: 'api-function', startLine: c.startLine, endLine: c.endLine || c.startLine, exported: true });
  }
  for (const [impRaw, targets] of Object.entries(src.frontendImports || {})) {
    const imp = normPath(impRaw);
    for (const t of Array.isArray(targets) ? targets : []) {
      const tf = normPath(typeof t === 'string' ? t : t?.file || '');
      if (!tf) continue;
      if (tf.endsWith('.vue')) {
        if (/\.(?:vue|[jt]sx|svelte|astro)$/i.test(imp)) pushUniq(vueComponentParents, tf, imp);
      } else {
        pushUniq(vueApiToViews, tf, imp);
      }
      if (typeof t === 'object' && Array.isArray(t.namedImports)) for (const fn of t.namedImports) pushUniq(vueApiToViews, `${tf}#${fn}`, imp);
    }
  }
  for (const namedMap of [src.vueApiImports || {}, src.frontendNamedImports || {}]) {
    for (const [vRaw, nMap] of Object.entries(namedMap)) {
      for (const [aRaw, fns] of Object.entries(nMap || {})) for (const fn of Array.isArray(fns) ? fns : []) pushUniq(vueApiToViews, `${normPath(aRaw)}#${fn}`, normPath(vRaw));
    }
  }
  if (Array.isArray(src.vueTemplateRefs)) {
    for (const ref of src.vueTemplateRefs) if (ref?.componentFile && ref?.parentFile) pushUniq(vueComponentParents, normPath(ref.componentFile), normPath(ref.parentFile));
  } else if (src.vueTemplateRefs && typeof src.vueTemplateRefs === 'object') {
    for (const [parentRaw, children] of Object.entries(src.vueTemplateRefs)) {
      for (const childRaw of Array.isArray(children) ? children : []) pushUniq(vueComponentParents, normPath(childRaw), normPath(parentRaw));
    }
  }
  for (const gc of Array.isArray(src.globalComponents) ? src.globalComponents : Object.values(src.globalComponents || {})) {
    const f = normPath(gc?.file);
    if (!f) continue;
    const consumers = sortedNormSet(Array.isArray(gc.consumers) && gc.consumers.length > 0 ? gc.consumers : vueComponentParents[f] || []);
    const tags = [...new Set([...(Array.isArray(gc.tags) ? gc.tags : []), gc.name, gc.kebabName].filter(Boolean).map(String))].sort(cmp);
    globalComponents[f] = { name: String(gc.name || path.basename(f, path.extname(f))), tags, consumers, complete: Boolean(gc.complete) };
  }
  for (const r of Object.values(cm.routes || {})) {
    const vf = normPath(r?.frontendFile || '');
    for (const sp of Array.isArray(r?.coveringSpecs) ? r.coveringSpecs.map(normPath) : []) {
      if (vf) pushUniq(viewToSpecs, vf, sp);
      for (const api of r?.linkedApis || []) pushUniq(endpointToSpecs, normRoute(api), sp);
    }
  }
  for (const [k, api] of Array.isArray(cm.apis) ? cm.apis.map((/** @type {any} */ a, /** @type {number} */ i) => [String(i), a]) : Object.entries(cm.apis || {})) {
    for (const sp of Array.isArray(api?.coveringSpecs) ? api.coveringSpecs.map(normPath) : []) pushUniq(endpointToSpecs, normRoute(api?.path || api?.route || k), sp);
  }
  for (const ch of Array.isArray(cm.serviceChains) ? cm.serviceChains : Object.values(cm.serviceChains || {})) {
    const specs = Array.isArray(ch?.coveringSpecs) ? ch.coveringSpecs.map(normPath) : (cm.routes?.[ch?.route]?.coveringSpecs || []).map(normPath);
    const vf = normPath(ch?.viewFile || ch?.frontendFile || ''); const apiP = normRoute(ch?.apiPath || '');
    for (const sp of specs) { if (vf) pushUniq(viewToSpecs, vf, sp); if (apiP) pushUniq(endpointToSpecs, apiP, sp); }
    const af = normPath(ch?.frontendApiFile || ch?.apiFile || '');
    if (af && vf) pushUniq(vueApiToViews, ch?.apiFnName ? `${af}#${ch.apiFnName}` : af, vf);
  }

  /** @type {Record<string, Array<{ id: string, name: string, kind: string, startLine: number, endLine: number, exported?: boolean }>>} */
  const sortedSyms = {};
  for (const f of Object.keys(fileSymbols).sort(cmp)) {
    const syms = fileSymbols[f];
    const hasCallable = syms.some((s) => !CONTAINER_SYMBOL_KINDS.has(String(s.kind || '').toLowerCase()));
    const kept = hasCallable ? syms.filter((s) => !CONTAINER_SYMBOL_KINDS.has(String(s.kind || '').toLowerCase()) || Boolean(controllerEndpoints[s.id])) : syms;
    if (ORPHAN_PRUNE_FILE_RE.test(f) && !controllerEndpoints[f] && !feignToImpl[f] && !implToFeign[f] && !kept.some((s) => Boolean(symbolCallers[s.id] || controllerEndpoints[s.id] || feignToImpl[s.id] || implToFeign[s.id] || mybatisToMapper[s.id]))) continue;
    if (kept.length > 0) sortedSyms[f] = [...kept].sort((a, b) => a.startLine - b.startLine || cmp(a.id, b.id));
  }
  const cappedCallers = Object.fromEntries(Object.keys(symbolCallers).sort(cmp).map((k) => {
    const uniq = [...new Set(symbolCallers[k])];
    return [k, uniq.length > HIGH_FAN_IN_CALLER_LIMIT ? [HIGH_FAN_IN_SENTINEL] : uniq.sort(cmp)];
  }));
  return {
    schemaVersion: GRAPH_IMPACT_INDEX_SCHEMA_VERSION,
    graphEngine: { provider: String(meta.provider || 'builtin'), version: meta.version ? String(meta.version) : null, binarySha256: meta.binarySha256 ? String(meta.binarySha256) : null, mode: String(meta.mode || (meta.provider && meta.provider !== 'builtin' ? 'enriched' : 'builtin')), degradedReason: meta.degradedReason ? String(meta.degradedReason) : null },
    coverage: { clean: cov.clean !== undefined ? Boolean(cov.clean) : Object.keys(sortedSyms).length > 0, parsePartialFiles: sortedNormSet(cov.parsePartialFiles), skippedFiles: sortedNormSet(cov.skippedFiles), unresolvedRatio: typeof cov.unresolvedRatio === 'number' ? cov.unresolvedRatio : 0 },
    fileSymbols: sortedSyms, symbolCallers: cappedCallers,
    crossModuleBridges: { feignToImpl: sortMapArr(feignToImpl), implToFeign: sortMapArr(implToFeign), mybatisToMapper: sortMapArr(mybatisToMapper) },
    controllerEndpoints: sortKeys(controllerEndpoints), routeToVueApis: sortKeys(routeToVueApis),
    vueApiToViews: sortMapArr(vueApiToViews), vueComponentParents: sortMapArr(vueComponentParents),
    globalComponents: sortKeys(globalComponents), viewToSpecs: sortMapArr(viewToSpecs), endpointToSpecs: sortMapArr(endpointToSpecs),
    globalInfra: { springAutoConfigFiles: sortedNormSet(src.globalInfra?.springAutoConfigFiles), springAutoConfigTargets: sortedNormSet(src.globalInfra?.springAutoConfigTargets), globalFiles: sortedNormSet(src.globalInfra?.globalFiles) },
  };
}

/**
 * Loads `<qaDir>/knowledge/graph-impact-index.json` synchronously in `<20ms` (zero external spawns).
 * @param {string} qaDir
 */
export function loadGraphImpactIndex(qaDir) {
  const t0 = performance.now();
  const indexPath = path.join(qaDir, 'knowledge', 'graph-impact-index.json');
  const res = (/** @type {boolean} */ ok, /** @type {any} */ index, /** @type {string | null} */ reason) =>
    ({ ok, index, reason, path: indexPath, readMs: Number((performance.now() - t0).toFixed(2)) });
  if (!fs.existsSync(indexPath)) return res(false, null, 'missing-graph-index');
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
    if (!parsed || parsed.schemaVersion !== GRAPH_IMPACT_INDEX_SCHEMA_VERSION || (typeof parsed.fileSymbols !== 'object' && !Array.isArray(parsed._ft) && parsed._fmt !== PIPE_SHARDED_FORMAT)) {
      return res(false, null, 'incompatible-graph-index-schema');
    }
    return res(true, hydrateGraphImpactIndex(parsed), null);
  } catch { return res(false, null, 'corrupt-graph-index-json'); }
}

/**
 * Parses `git diff -U0` unified output into per-file changed line ranges (UTF-8/Chinese path safe).
 * @param {string} diffText @param {string} [repoPrefix]
 * @returns {Record<string, Array<{ startLine: number, endLine: number }>>}
 */
export function parseUnifiedDiffHunks(diffText, repoPrefix = '') {
  /** @type {Record<string, Array<{ startLine: number, endLine: number }>>} */ const out = {};
  let cur = '';
  for (const line of String(diffText || '').split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4).trim().replace(/^"(.*)"$/, '$1');
      cur = raw === '/dev/null' ? '' : (repoPrefix ? `${repoPrefix}/${normPath(raw.replace(/^b\//, ''))}` : normPath(raw.replace(/^b\//, '')));
    } else if (cur && line.startsWith('@@ ')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
      if (m) { const s = Math.max(1, Number(m[1])); const c = m[2] === undefined ? 1 : Number(m[2]); (out[cur] || (out[cur] = [])).push({ startLine: s, endLine: c === 0 ? s : s + c - 1 }); }
    }
  }
  return out;
}

/**
 * Collects changed line hunks across one or more Git repos using `-c core.quotepath=false diff -U0`.
 * @param {string[]} repoRoots @param {string} [baseRef]
 */
export async function collectGitDiffHunks(repoRoots, baseRef = 'HEAD~1') {
  /** @type {Record<string, Array<{ startLine: number, endLine: number }>>} */ const hunksByFile = {};
  const merge = (/** @type {Record<string, Array<{ startLine: number, endLine: number }>>} */ part, /** @type {string} */ relSub, /** @type {string} */ label) => {
    for (const [k, v] of Object.entries(part)) {
      const s = relSub && k.startsWith(`${relSub}/`) ? k.slice(relSub.length + 1) : k;
      if (s && !s.startsWith('..')) (hunksByFile[label ? `${label}/${s}` : s] || (hunksByFile[label ? `${label}/${s}` : s] = [])).push(...v);
    }
  };
  try {
    await Promise.all(buildLabeledRepoRoots(repoRoots || []).map(async ({ root, label }) => {
      const gitRoot = resolveGitRoot(root);
      if (!gitRoot) return;
      const relSub = normPath(path.relative(gitRoot, canonicalFsPath(root)));
      const [vRes, brDiff, wtDiff] = await Promise.all([
        baseRef ? runProcess('git', ['-c', 'core.quotepath=false', 'rev-parse', '--verify', baseRef], { cwd: gitRoot, timeoutMs: 4000 }) : Promise.resolve(null),
        baseRef ? runProcess('git', ['-c', 'core.quotepath=false', 'diff', '-U0', `${baseRef}...HEAD`], { cwd: gitRoot, timeoutMs: 6000 }) : Promise.resolve(null),
        runProcess('git', ['-c', 'core.quotepath=false', 'diff', '-U0', 'HEAD'], { cwd: gitRoot, timeoutMs: 6000 }),
      ]);
      if (vRes?.code === 0 && brDiff?.code === 0 && brDiff.stdout) merge(parseUnifiedDiffHunks(brDiff.stdout), relSub, label);
      if (wtDiff?.code === 0 && wtDiff.stdout) merge(parseUnifiedDiffHunks(wtDiff.stdout), relSub, label);
    }));
    return { ok: true, hunksByFile };
  } catch (err) { return { ok: false, hunksByFile: {}, reason: err instanceof Error ? err.message : String(err) }; }
}

/**
 * Evaluates Additive-Only + Fail-Closed symbol-level graph impact using pre-synced `graph-impact-index.json`.
 * @param {{ changedFiles: string[], diffHunks: Record<string, Array<{ startLine: number, endLine: number }>> | null | undefined, graphIndex: Record<string, any> | null | undefined, codeMap?: Record<string, any> | null, globalGuard?: { isGlobal: boolean, reasons?: string[] } | null, allSpecs?: string[] }} params
 */
export function evaluateGraphAssistedImpact({ changedFiles, diffHunks, graphIndex, codeMap = null, globalGuard = null, allSpecs = [] }) {
  const baseEngine = { provider: String(graphIndex?.graphEngine?.provider || 'builtin'), version: graphIndex?.graphEngine?.version ?? null, binarySha256: graphIndex?.graphEngine?.binarySha256 ?? null, mode: String(graphIndex?.graphEngine?.mode || 'builtin'), usedForNarrowing: false };
  const fail = (/** @type {string} */ reason) => ({ eligible: false, reason, matchedSpecs: /** @type {string[]} */ ([]), why: /** @type {Array<{ spec: string, via: string }>} */ ([]), touchedSymbols: /** @type {string[]} */ ([]), affectedControllers: /** @type {string[]} */ ([]), affectedViews: /** @type {string[]} */ ([]), affectedJavaFiles: /** @type {string[]} */ ([]), graphEngine: baseEngine });

  if (!graphIndex || graphIndex.schemaVersion !== GRAPH_IMPACT_INDEX_SCHEMA_VERSION) return fail('missing-graph-index');
  if (globalGuard?.isGlobal) return fail('global-infra-detected');
  const cov = graphIndex.coverage || {};
  const gapSet = new Set([...(cov.parsePartialFiles || []), ...(cov.skippedFiles || [])].map(normPath));
  if (cov.clean === false && gapSet.size === 0) return fail('graph-coverage-unclean');
  const files = (changedFiles || []).map(normPath).filter(Boolean);
  if (files.length === 0) return fail('no-changed-files');
  for (const f of files) if (gapSet.has(f)) return fail(`coverage-gap-on-touched-file:${f}`);

  /** @type {Map<string, { file: string, name: string }> | null} */ let lazySymById = null;
  const resolveSymInfo = (/** @type {string} */ id) => {
    const hash = id.indexOf('#');
    if (hash > 0) return { file: id.slice(0, hash), name: id.slice(hash + 1) };
    if (!lazySymById) {
      lazySymById = new Map();
      for (const [f, syms] of Object.entries(graphIndex.fileSymbols || {})) for (const s of syms || []) lazySymById.set(String(s.id || `${f}#${s.name}`), { file: f, name: s.name });
    }
    return lazySymById.get(id) || { file: id, name: '' };
  };
  const allSpecSet = allSpecs.length > 0 ? new Set(allSpecs.map(normPath)) : null;
  /** @type {Record<string, string[]>} */
  const viewSpecsMap = Object.fromEntries(Object.entries(graphIndex.viewToSpecs || {}).map(([k, v]) => [k, [...v]]));
  for (const r of Object.values(codeMap?.routes || {})) {
    const vf = normPath(r?.frontendFile || '');
    for (const sp of r?.coveringSpecs || []) if (vf) pushUniq(viewSpecsMap, vf, normPath(sp));
  }

  /** @type {Map<string, string[]>} */ const whyBySpec = new Map();
  const addWhy = (/** @type {string} */ sp, /** @type {string} */ ch) => {
    if (allSpecSet && !allSpecSet.has(sp)) return false;
    const arr = whyBySpec.get(sp) || []; if (!arr.includes(ch)) arr.push(ch); whyBySpec.set(sp, arr); return true;
  };
  const affectedViews = new Set(); const affectedControllers = new Set(); const affectedJavaFiles = new Set(); const touchedSymbols = new Set();

  const resolveViewToSpecs = (/** @type {string} */ startView, /** @type {string} */ prefix) => {
    /** @type {string[]} */ const terminals = [];
    const seen = new Set([startView]); const q = [startView];
    while (q.length > 0) {
      const cur = q.shift(); if (!cur) continue;
      const parents = (graphIndex.vueComponentParents?.[cur] || []).filter((/** @type {string} */ p) => !seen.has(p));
      if (parents.length === 0 || viewSpecsMap[cur]?.length > 0) terminals.push(cur);
      for (const p of parents) { seen.add(p); q.push(p); }
    }
    let ok = terminals.length > 0;
    for (const v of terminals) {
      affectedViews.add(v);
      const specs = (viewSpecsMap[v] || []).filter((sp) => !allSpecSet || allSpecSet.has(sp));
      if (specs.length === 0) ok = false;
      for (const sp of specs) addWhy(sp, `${prefix} -> ${v}`);
    }
    return ok;
  };

  for (const file of files) {
    const gc = graphIndex.globalComponents?.[file];
    if (gc?.complete === true && Array.isArray(gc.consumers) && gc.consumers.length > 0) {
      const hasCodePartial = [...gapSet].some((g) => !NON_CODE_PARTIAL_RE.test(g));
      if ((cov.clean !== true && gapSet.size === 0) || hasCodePartial) return fail(`coverage-gap-on-global-component:${file}`);
      touchedSymbols.add(`${file}#${gc.name}`);
      for (const c of gc.consumers) if (!resolveViewToSpecs(normPath(c), `graph-v3: ${file}(<${gc.tags?.[0] || gc.name}>)`)) return fail(`unmapped-affected-view:${c}`);
      continue;
    }
    const hunks = diffHunks?.[file];
    if (!Array.isArray(hunks) || hunks.length === 0) return fail(`no-diff-hunks:${file}`);
    const fileSyms = graphIndex.fileSymbols?.[file];
    if (!Array.isArray(fileSyms) || fileSyms.length === 0) return fail(`no-indexed-symbols:${file}`);

    /** @type {string[]} */ const startIds = [];
    for (const h of hunks) {
      const pickedIds = selectInnermostHunkSymbols(fileSyms, h, file);
      if (pickedIds.length === 0) return fail(`unmapped-diff-hunk:${file}:${h.startLine}-${h.endLine}`);
      for (const sid of pickedIds) if (!startIds.includes(sid)) startIds.push(sid);
    }

    for (const startId of startIds) {
      touchedSymbols.add(startId);
      const visited = new Set([startId]); const q = [{ id: startId, chain: [startId] }];
      let resolved = false;
      while (q.length > 0) {
        const cur = q.shift(); if (!cur) continue;
        const mSym = resolveSymInfo(cur.id);
        const cf = mSym.file;
        const cn = mSym.name;
        const key = cf && cn ? `${cf}#${cn}` : '';
        if (cf.endsWith('.java') || cf.endsWith('.xml')) affectedJavaFiles.add(cf);

        const br = graphIndex.crossModuleBridges || {};
        const nextIds = new Set([
          ...(graphIndex.symbolCallers?.[cur.id] || []), ...(key ? graphIndex.symbolCallers?.[key] || [] : []),
          ...(br.mybatisToMapper?.[cur.id] || []), ...(br.implToFeign?.[cur.id] || []), ...(br.feignToImpl?.[cur.id] || []),
          ...(key ? [...(br.implToFeign?.[key] || []), ...(br.feignToImpl?.[key] || []), ...[...(br.implToFeign?.[cf] || []), ...(br.feignToImpl?.[cf] || [])].map((/** @type {string} */ t) => `${t}#${cn}`)] : []),
        ]);
        if (nextIds.has(HIGH_FAN_IN_SENTINEL)) return fail(`high-fan-in-symbol:${cur.id}`);
        const eps = graphIndex.controllerEndpoints?.[cur.id] || (key ? graphIndex.controllerEndpoints?.[key] : null);
        if (Array.isArray(eps) && eps.length > 0) {
          resolved = true; affectedControllers.add(cf);
          let methodEpCovered = false;
          for (const ep of eps) {
            for (const va of graphIndex.routeToVueApis?.[ep.path] || []) {
              for (const vf of graphIndex.vueApiToViews?.[`${va.apiFile}#${va.fnName}`] || graphIndex.vueApiToViews?.[va.apiFile] || []) {
                if (!resolveViewToSpecs(vf, `graph-v3: ${cur.chain.join(' -> ')} -> ${ep.path} -> ${va.fnName || va.apiFile}`)) return fail(`unmapped-affected-view:${vf}`);
                methodEpCovered = true;
              }
            }
            for (const sp of graphIndex.endpointToSpecs?.[ep.path] || []) if (addWhy(sp, `graph-v3: ${cur.chain.join(' -> ')} -> ${ep.path}`)) methodEpCovered = true;
          }
          if (!methodEpCovered) return fail(`unmapped-affected-controller:${cur.id}(${eps[0].path})`);
        }
        const directViews = graphIndex.vueApiToViews?.[cur.id] || (key ? graphIndex.vueApiToViews?.[key] : null);
        if (Array.isArray(directViews) && directViews.length > 0) {
          resolved = true;
          for (const vf of directViews) if (!resolveViewToSpecs(vf, `graph-v3: ${cur.chain.join(' -> ')}`)) return fail(`unmapped-affected-view:${vf}`);
        }
        if (cf.endsWith('.vue')) { resolved = true; if (!resolveViewToSpecs(cf, `graph-v3: ${cur.chain.join(' -> ')}`)) return fail(`unmapped-affected-view:${cf}`); }
        for (const nxt of nextIds) if (!visited.has(nxt) && cur.chain.length < 10) { visited.add(nxt); q.push({ id: nxt, chain: [...cur.chain, nxt] }); }
      }
      if (!resolved) return fail(`unresolved-symbol-callers:${startId}`);
    }
  }

  if (whyBySpec.size === 0) return fail('zero-specs-resolved');
  const matchedSpecs = [...whyBySpec.keys()].sort(cmp);
  return {
    eligible: true, reason: 'graph-symbol-narrowed', matchedSpecs,
    why: matchedSpecs.map((spec) => ({ spec, via: (whyBySpec.get(spec) || []).join('; ') })),
    touchedSymbols: [...touchedSymbols].sort(cmp), affectedControllers: [...affectedControllers].sort(cmp),
    affectedViews: [...affectedViews].sort(cmp), affectedJavaFiles: [...affectedJavaFiles].sort(cmp),
    graphEngine: { ...baseEngine, usedForNarrowing: true },
  };
}
