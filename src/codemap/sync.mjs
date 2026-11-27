// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { loadAndValidateAitestConfigFile } from '../core/config.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { SCHEMA_VERSIONS } from '../core/version.mjs';
import { buildLabeledRepoRoots, collectSpringAutoConfigRegistry } from '../impact/global-infra-guard.mjs';
import { buildGraphImpactIndex, loadGraphImpactIndex } from '../impact/graph-index.mjs';
import { serializeGraphImpactIndex } from '../impact/graph-index-codec.mjs';
import { sanitizeUntrustedCodeMetadata } from '../mcp-hub/auditor.mjs';
import { DEFAULT_PER_REPO_SCAN_FILES, indexQaSpecs, indexRepositoriesSource } from './adapters.mjs';
import { mergeLivingCodeMap } from './merger.mjs';
import { queryGraphComposite, resolveGraphSnapshot } from './providers/registry.mjs';
import { generateLivingSystemMapMarkdown, syncImpactMapFromCodeMap } from './reporter.mjs';

/** @param {string} filePath @returns {any} */
function readJsonOptional(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {unknown} val @param {number} [maxLen] @returns {string} */
function cleanMeta(val, maxLen = 260) {
  const s = sanitizeUntrustedCodeMetadata(redactSecrets(String(val ?? ''))).replace(/\s+/g, ' ').trim();
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

/** @param {string | string[] | undefined} raw @param {string} baseDir @returns {string[]} */
function parseRepoEntries(raw, baseDir) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    const s = String(item || '').trim();
    if (!s) continue;
    const direct = path.isAbsolute(s) ? s : path.resolve(baseDir, s);
    if (fs.existsSync(direct)) {
      out.push(direct);
    } else if (s.includes(',')) {
      for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
        out.push(path.isAbsolute(part) ? part : path.resolve(baseDir, part));
      }
    } else {
      out.push(direct);
    }
  }
  return [...new Set(out)];
}

/**
 * Builds deterministic `{ path, label }` repo specs matching `indexRepositoriesSource` multi-repo labeling.
 * @param {string[]} repos
 * @returns {Array<{ path: string, label: string }>}
 */
function buildLabeledRepoSpecs(repos) {
  const used = new Set();
  return (repos || []).map((r) => {
    const resolved = path.resolve(r);
    const base = path.basename(resolved) || 'repo';
    let label = base;
    for (let idx = 2; used.has(label); idx += 1) label = `${base}-${idx}`;
    used.add(label);
    return { path: resolved, label };
  });
}

/**
 * Resolves `sourceRepos`, `maxScanFiles`, `apiPrefixes`, and `codeMap` engine config without mutating locked config.
 * @param {string} qaDir
 * @param {any} existingMap
 * @param {{ repoDir?: string, repo?: string | string[], repos?: string[], maxScanFiles?: number, apiPrefixes?: string[], engine?: string }} options
 */
export function resolveCodeMapInputs(qaDir, existingMap, options) {
  const defaultRoot = path.dirname(qaDir);
  const cfgRes = loadAndValidateAitestConfigFile(qaDir);
  const cfg = cfgRes.config;

  const explicitRepos = [
    ...parseRepoEntries(options.repos, process.cwd()),
    ...parseRepoEntries(options.repo, process.cwd()),
    ...parseRepoEntries(options.repoDir, process.cwd()),
  ];
  const cfgRepos = (cfg.sourceRepos || []).map((/** @type {string} */ entry) => {
    if (path.isAbsolute(entry)) return entry;
    const fromParent = path.resolve(defaultRoot, entry);
    return fs.existsSync(fromParent) ? fromParent : path.resolve(qaDir, entry);
  });
  const metaRepos = Array.isArray(existingMap?.meta?.sourceRepos)
    ? existingMap.meta.sourceRepos.filter((/** @type {string} */ p) => typeof p === 'string' && fs.existsSync(p))
    : [];

  const sourceRepos = explicitRepos.length > 0
    ? [...new Set(explicitRepos)]
    : cfgRepos.length > 0
      ? [...new Set(cfgRepos)]
      : metaRepos.length > 0
        ? [...new Set(metaRepos)]
        : [defaultRoot];

  const maxScanFiles = options.maxScanFiles || cfg.maxScanFiles || existingMap?.meta?.maxScanFiles || DEFAULT_PER_REPO_SCAN_FILES;
  const apiPrefixes = [...new Set([...(options.apiPrefixes || []), ...(cfg.apiPrefixes || [])])];
  const codeMapConfig = cfg.codeMap || {};
  const engine = String(options.engine || codeMapConfig.engine || 'auto').trim() || 'auto';
  return { sourceRepos, maxScanFiles, apiPrefixes, engine, codeMapConfig };
}

/**
 * Builds a bounded, sanitized 1-call composite full-stack query view over merged `codeMap`,
 * `graphImpactIndex`, and optional live CBM `queryGraphComposite` results.
 * @param {string} rawQuery
 * @param {Record<string, any>} codeMap
 * @param {Record<string, any>} graphIndex
 * @param {Record<string, any> | null} [liveQueryRes]
 */
export function buildCompositeCodeMapQuery(rawQuery, codeMap, graphIndex, liveQueryRes = null) {
  const query = cleanMeta(rawQuery, 160);
  const needle = query.toLowerCase();
  if (!needle) {
    return {
      query: '', mode: 'builtin-fallback', matchedRoutes: [], matchedApis: [], matchedServiceChains: [],
      symbols: [], hotspots: [], callers: {}, callees: {}, truncated: false,
    };
  }

  /** @param {unknown} v */
  const hit = (v) => String(v ?? '').toLowerCase().includes(needle);

  const matchedRoutes = Object.values(codeMap?.routes || {})
    .filter((r) => !r.stale && (hit(r.route) || hit(r.frontendFile) || (r.linkedApis || []).some(hit) || (r.linkedBackendFiles || []).some(hit) || (r.linkedDbTables || []).some(hit)))
    .slice(0, 15)
    .map((r) => ({
      route: cleanMeta(r.route, 200),
      frontendFile: r.frontendFile ? cleanMeta(r.frontendFile, 260) : null,
      linkedApis: (r.linkedApis || []).slice(0, 8).map((/** @type {string} */ a) => cleanMeta(a, 200)),
      linkedBackendFiles: (r.linkedBackendFiles || []).slice(0, 6).map((/** @type {string} */ b) => cleanMeta(b, 260)),
      linkedDbTables: (r.linkedDbTables || []).slice(0, 8).map((/** @type {string} */ t) => cleanMeta(t, 120)),
      coveringSpecs: (r.coveringSpecs || []).slice(0, 8).map((/** @type {string} */ s) => cleanMeta(s, 260)),
    }));

  const matchedApis = Object.entries(codeMap?.apis || {})
    .filter(([k, api]) => hit(k) || hit(api?.path) || hit(api?.controllerFile) || hit(api?.controllerMethod) || (api?.frontendApiFiles || []).some(hit) || (api?.frontendFnNames || []).some(hit) || (api?.linkedDbTables || []).some(hit))
    .slice(0, 20)
    .map(([key, api]) => ({
      key: cleanMeta(key, 240),
      method: cleanMeta(api?.method || 'ANY', 16),
      path: cleanMeta(api?.path || '', 200),
      controllerFile: api?.controllerFile ? cleanMeta(api.controllerFile, 260) : null,
      controllerMethod: api?.controllerMethod ? cleanMeta(api.controllerMethod, 120) : null,
      frontendApiFiles: (api?.frontendApiFiles || []).slice(0, 6).map((/** @type {string} */ f) => cleanMeta(f, 260)),
      frontendFnNames: (api?.frontendFnNames || []).slice(0, 8).map((/** @type {string} */ fn) => cleanMeta(fn, 120)),
      linkedRoutes: (api?.linkedRoutes || []).slice(0, 8).map((/** @type {string} */ rt) => cleanMeta(rt, 200)),
      linkedDbTables: (api?.linkedDbTables || []).slice(0, 8).map((/** @type {string} */ tb) => cleanMeta(tb, 120)),
    }));

  const matchedServiceChains = (Array.isArray(codeMap?.serviceChains) ? codeMap.serviceChains : [])
    .filter((ch) =>
      hit(ch.route) || hit(ch.viewFile) || hit(ch.apiPath) || hit(ch.apiFnName) ||
      hit(ch.controllerFile) || hit(ch.controllerMethod) ||
      (ch.serviceFiles || []).some(hit) || (ch.feignFiles || []).some(hit) || (ch.dbTables || []).some(hit)
    )
    .slice(0, 15)
    .map((ch) => ({
      route: cleanMeta(ch.route, 200),
      viewFile: ch.viewFile ? cleanMeta(ch.viewFile, 260) : null,
      apiMethod: cleanMeta(ch.apiMethod || 'ANY', 16),
      apiPath: cleanMeta(ch.apiPath, 200),
      apiFnName: ch.apiFnName ? cleanMeta(ch.apiFnName, 120) : null,
      controllerFile: ch.controllerFile ? cleanMeta(ch.controllerFile, 260) : null,
      controllerMethod: ch.controllerMethod ? cleanMeta(ch.controllerMethod, 120) : null,
      serviceFiles: (ch.serviceFiles || []).slice(0, 6).map((/** @type {string} */ s) => cleanMeta(s, 260)),
      feignFiles: (ch.feignFiles || []).slice(0, 6).map((/** @type {string} */ f) => cleanMeta(f, 260)),
      dbTables: (ch.dbTables || []).slice(0, 8).map((/** @type {string} */ t) => cleanMeta(t, 120)),
      coveringSpecs: (ch.coveringSpecs || []).slice(0, 6).map((/** @type {string} */ s) => cleanMeta(s, 260)),
    }));

  /** @type {Array<{ id: string, name: string, kind: string, file: string, startLine: number, inDegree: number, outDegree: number }>} */
  const symbols = [];
  /** @type {Set<string>} */
  const seenSym = new Set();
  if (liveQueryRes?.ok && Array.isArray(liveQueryRes.symbols)) {
    for (const s of liveQueryRes.symbols.slice(0, 20)) {
      const id = cleanMeta(s?.id, 200);
      if (!id || seenSym.has(id)) continue;
      seenSym.add(id);
      symbols.push({
        id, name: cleanMeta(s?.name, 120), kind: cleanMeta(s?.kind || 'Symbol', 48),
        file: cleanMeta(s?.file, 260), startLine: Math.max(0, Number(s?.startLine || 0)),
        inDegree: Math.max(0, Number(s?.inDegree || 0)), outDegree: Math.max(0, Number(s?.outDegree || 0)),
      });
    }
  }
  const callersMap = graphIndex?.symbolCallers || {};
  for (const [file, list] of Object.entries(graphIndex?.fileSymbols || {})) {
    for (const sym of Array.isArray(list) ? list : []) {
      if (symbols.length >= 25) break;
      const rawSid = String(sym?.id || (sym?.name ? `${file}#${sym.name}` : ''));
      if (!hit(rawSid) && !hit(sym?.name) && !hit(file)) continue;
      const id = cleanMeta(rawSid, 200);
      if (!id || seenSym.has(id)) continue;
      seenSym.add(id);
      symbols.push({
        id, name: cleanMeta(sym.name, 120), kind: cleanMeta(sym.kind || 'Symbol', 48),
        file: cleanMeta(file, 260), startLine: Math.max(0, Number(sym.startLine || 0)),
        inDegree: Array.isArray(callersMap[rawSid]) ? callersMap[rawSid].length : 0, outDegree: 0,
      });
    }
  }

  const hotspots = (liveQueryRes?.ok && Array.isArray(liveQueryRes.hotspots) && liveQueryRes.hotspots.length > 0
    ? liveQueryRes.hotspots.slice(0, 5).map((/** @type {any} */ h) => ({
        id: cleanMeta(h?.id, 200), name: cleanMeta(h?.name, 120), kind: cleanMeta(h?.kind, 48),
        file: cleanMeta(h?.file, 260), startLine: Math.max(0, Number(h?.startLine || 0)),
        inDegree: Math.max(0, Number(h?.inDegree || 0)), outDegree: Math.max(0, Number(h?.outDegree || 0)),
      }))
    : symbols.slice(0, 5));

  /** @type {Record<string, Array<{ id: string, file: string, hop: number, kind: string }>>} */
  const callers = {};
  /** @type {Record<string, Array<{ id: string, file: string, hop: number, kind: string }>>} */
  const callees = {};
  if (liveQueryRes?.ok) {
    for (const [k, arr] of Object.entries(liveQueryRes.callers || {})) {
      callers[cleanMeta(k, 200)] = (Array.isArray(arr) ? arr : []).slice(0, 15).map((/** @type {any} */ c) => ({
        id: cleanMeta(c?.id, 200), file: cleanMeta(c?.file, 260), hop: Math.max(1, Number(c?.hop || 1)), kind: cleanMeta(c?.kind || 'CALLS', 32),
      }));
    }
    for (const [k, arr] of Object.entries(liveQueryRes.callees || {})) {
      callees[cleanMeta(k, 200)] = (Array.isArray(arr) ? arr : []).slice(0, 15).map((/** @type {any} */ c) => ({
        id: cleanMeta(c?.id, 200), file: cleanMeta(c?.file, 260), hop: Math.max(1, Number(c?.hop || 1)), kind: cleanMeta(c?.kind || 'CALLS', 32),
      }));
    }
  }
  for (const spot of hotspots) {
    if (!callers[spot.id] && Array.isArray(callersMap[spot.id])) {
      callers[spot.id] = callersMap[spot.id].slice(0, 15).map((/** @type {string} */ cid) => ({
        id: cleanMeta(cid, 200), file: cleanMeta(cid.includes('#') ? cid.split('#')[0] : '', 260), hop: 1, kind: 'CALLS',
      }));
    }
  }

  return {
    query,
    mode: liveQueryRes?.ok ? 'enriched' : String(codeMap?.meta?.graphEngine?.mode || 'builtin-fallback'),
    matchedRoutes,
    matchedApis,
    matchedServiceChains,
    symbols: symbols.slice(0, 20),
    hotspots,
    callers,
    callees,
    truncated: Boolean(liveQueryRes?.truncated || symbols.length >= 25),
  };
}

/**
 * Synchronizes Living Code Map v5 (`<qaDir>/knowledge/code-map.json`, `SYSTEM_MAP.md`,
 * `graph-impact-index.json`, and `impact-map.auto.json`) fusing L0 full-stack extractors
 * with optional pinned sidecar graph providers (`codebase-memory-mcp` or SPI plugins).
 * @param {string} qaDir
 * @param {{
 *   lang?: string,
 *   repoDir?: string,
 *   repo?: string | string[],
 *   repos?: string[],
 *   maxScanFiles?: number,
 *   apiPrefixes?: string[],
 *   engine?: 'auto' | 'builtin' | 'codebase-memory-mcp' | string,
 *   query?: string,
 *   providerId?: string,
 *   providerCtx?: Record<string, any>,
 *   strictEngine?: boolean,
 *   graphSnapshot?: import('./providers/cbm-normalizer.mjs').NormalizedGraphSnapshot | null,
 *   skipWriteIfUnchanged?: boolean,
 *   syncImpact?: boolean | 'force',
 *   force?: boolean,
 * }} [options]
 */
export async function syncLivingCodeMap(qaDir, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const knowledgeDir = path.join(qaDir, 'knowledge');
  const codeMapPath = path.join(knowledgeDir, 'code-map.json');
  const systemMapMdPath = path.join(knowledgeDir, 'SYSTEM_MAP.md');
  const graphImpactIndexPath = path.join(knowledgeDir, 'graph-impact-index.json');

  const existingMap = readJsonOptional(codeMapPath);
  const { sourceRepos, maxScanFiles, apiPrefixes, engine, codeMapConfig } = resolveCodeMapInputs(qaDir, existingMap, options);
  const providerCtx = { qaDir, ...(codeMapConfig.externalEngine || {}), ...(options.providerCtx || {}) };
  const queryStr = typeof options.query === 'string' ? options.query.trim() : '';
  const hasExplicitRepos = Boolean(options.repos || options.repo || options.repoDir);
  const sameRepos =
    !hasExplicitRepos ||
    JSON.stringify(sourceRepos.map((r) => path.resolve(r))) ===
      JSON.stringify((existingMap?.meta?.sourceRepos || []).map((/** @type {string} */ r) => path.resolve(r)));

  // Fast-path cached composite --query (~1-2s instead of 60s full re-index) when v5 artifacts exist and !force
  if (queryStr && !options.force && !options.graphSnapshot && sameRepos && existingMap?.schemaVersion === SCHEMA_VERSIONS.codeMap && fs.existsSync(graphImpactIndexPath)) {
    const cachedIdx = loadGraphImpactIndex(qaDir);
    if (cachedIdx.ok && cachedIdx.index) {
      const liveQueryRes = engine !== 'builtin'
        ? await queryGraphComposite(queryStr, buildLabeledRepoSpecs(sourceRepos), { engine, providerId: options.providerId, ctx: providerCtx })
        : null;
      const queryResult = buildCompositeCodeMapQuery(queryStr, existingMap, cachedIdx.index, liveQueryRes);
      return {
        codeMapPath, systemMapMdPath, graphImpactIndexPath, revision: existingMap.revision, unchanged: true,
        truncated: Boolean(existingMap.meta?.truncated), warnings: existingMap.sourceSummary?.warnings || [],
        coverage: existingMap.coverage, graphEngine: existingMap.meta?.graphEngine || null,
        apisCount: Object.keys(existingMap.apis || {}).length,
        serviceChainsCount: Array.isArray(existingMap.serviceChains) ? existingMap.serviceChains.length : 0,
        crossServiceBridges: existingMap.crossServiceBridges || {}, impactSync: { manualRulesCount: 0, autoRulesCount: 0 },
        openDefects: (existingMap.defects || []).filter((/** @type {any} */ d) => d.status === 'open').length, queryResult,
      };
    }
  }

  const sourceIndex = indexRepositoriesSource(sourceRepos, { maxScanFiles, apiPrefixes });
  const effectiveRepos = Array.isArray(sourceIndex.repos) && sourceIndex.repos.length > 0 ? sourceIndex.repos : sourceRepos;
  const repoSpecs = buildLabeledRepoSpecs(effectiveRepos);

  const normalizedGraphSnapshot = options.graphSnapshot
    ? options.graphSnapshot
    : await resolveGraphSnapshot(repoSpecs, { engine, providerId: options.providerId, strict: Boolean(options.strictEngine), ctx: providerCtx });

  const specIndex = indexQaSpecs(qaDir);
  const topology = readJsonOptional(path.join(qaDir, 'reports', 'system-topology.json'));
  const resultsJson = readJsonOptional(path.join(qaDir, 'reports', 'results.json'));
  const perfReport = readJsonOptional(path.join(qaDir, 'reports', 'perf-report.json'));

  const nextMap = mergeLivingCodeMap(existingMap, {
    sourceIndex,
    specIndex,
    topology,
    resultsJson,
    perfReport,
    sourceRepos,
    maxScanFiles,
    apiPrefixes,
    normalizedGraphSnapshot,
  });

  const springAutoReg = collectSpringAutoConfigRegistry(buildLabeledRepoRoots(effectiveRepos));
  /** @type {Set<string>} */
  const autoTargets = new Set();
  for (const meta of Object.values(sourceIndex.javaFileInfos || {})) {
    if (!meta?.relFile) continue;
    if (springAutoReg.referencedFqcns.has(meta.fqcn) || (/(?:Filter|Interceptor|Advice|Properties)$/.test(meta.className) && springAutoReg.referencedSimpleNames.has(meta.className))) {
      autoTargets.add(meta.relFile);
    }
  }
  const sourceIndexWithInfra = {
    ...sourceIndex,
    globalInfra: {
      springAutoConfigFiles: [...springAutoReg.autoConfigRelFiles],
      springAutoConfigTargets: [...autoTargets],
      globalFiles: [...springAutoReg.autoConfigRelFiles, ...autoTargets],
    },
  };
  const graphImpactIndex = buildGraphImpactIndex(sourceIndexWithInfra, normalizedGraphSnapshot, nextMap);

  let queryResult = null;
  if (typeof options.query === 'string' && options.query.trim()) {
    const liveQueryRes =
      normalizedGraphSnapshot?.meta?.mode === 'enriched'
        ? await queryGraphComposite(options.query, repoSpecs, { engine, providerId: options.providerId, ctx: providerCtx })
        : null;
    queryResult = buildCompositeCodeMapQuery(options.query, nextMap, graphImpactIndex, liveQueryRes);
  }

  const canSkipWrite =
    Boolean(options.skipWriteIfUnchanged) &&
    !options.force &&
    existingMap?.schemaVersion === nextMap.schemaVersion &&
    existingMap?.contentFingerprint === nextMap.contentFingerprint &&
    fs.existsSync(graphImpactIndexPath);

  if (canSkipWrite) {
    return {
      codeMapPath, systemMapMdPath, graphImpactIndexPath, revision: existingMap.revision, unchanged: true,
      truncated: Boolean(sourceIndex.truncated), warnings: sourceIndex.warnings || [], coverage: existingMap.coverage,
      graphEngine: existingMap.meta?.graphEngine || nextMap.meta.graphEngine, apisCount: Object.keys(existingMap.apis || {}).length,
      serviceChainsCount: Array.isArray(existingMap.serviceChains) ? existingMap.serviceChains.length : 0,
      crossServiceBridges: existingMap.crossServiceBridges || nextMap.crossServiceBridges,
      impactSync: { manualRulesCount: 0, autoRulesCount: 0 },
      openDefects: (existingMap.defects || []).filter((/** @type {any} */ d) => d.status === 'open').length,
      ...(queryResult ? { queryResult } : {}),
    };
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(codeMapPath, JSON.stringify(nextMap, null, 2) + '\n', 'utf8');
  fs.writeFileSync(systemMapMdPath, generateLivingSystemMapMarkdown(nextMap, lang), 'utf8');
  fs.writeFileSync(graphImpactIndexPath, serializeGraphImpactIndex(graphImpactIndex) + '\n', 'utf8');

  /** @type {{ manualRulesCount: number, autoRulesCount: number, mode?: string, suggestedPath?: string, autoImpactPath?: string }} */
  let impactSync = { manualRulesCount: 0, autoRulesCount: 0 };
  if (options.syncImpact !== false) {
    const autoImpactPath = path.join(knowledgeDir, 'impact-map.auto.json');
    const autoOut = syncImpactMapFromCodeMap(autoImpactPath, nextMap);

    const impactPath = path.join(qaDir, 'impact-map.json');
    const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
    let impactLocked = false;
    if (fs.existsSync(lockPath)) {
      try {
        const lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        impactLocked = Boolean(lockObj?.files && 'impact-map.json' in lockObj.files);
      } catch {
        impactLocked = true;
      }
    }

    if (impactLocked && options.syncImpact !== 'force') {
      const existing = readJsonOptional(impactPath);
      const manualCount = Array.isArray(existing?.rules) ? existing.rules.filter((/** @type {any} */ r) => !r.autoGenerated).length : 0;
      const suggestedPath = path.join(knowledgeDir, 'impact-map.suggested.json');
      syncImpactMapFromCodeMap(suggestedPath, nextMap);
      impactSync = {
        manualRulesCount: Math.max(manualCount, autoOut.manualRulesCount),
        autoRulesCount: autoOut.autoRulesCount,
        mode: 'auto-union',
        suggestedPath,
        autoImpactPath,
      };
    } else {
      impactSync = { ...syncImpactMapFromCodeMap(impactPath, nextMap), autoImpactPath };
    }
  }

  return {
    codeMapPath, systemMapMdPath, graphImpactIndexPath, revision: nextMap.revision, unchanged: false,
    truncated: Boolean(sourceIndex.truncated), warnings: sourceIndex.warnings || [], coverage: nextMap.coverage,
    graphEngine: nextMap.meta.graphEngine, apisCount: Object.keys(nextMap.apis || {}).length,
    serviceChainsCount: (nextMap.serviceChains || []).length, crossServiceBridges: nextMap.crossServiceBridges,
    impactSync, openDefects: nextMap.defects.filter((d) => d.status === 'open').length,
    ...(queryResult ? { queryResult } : {}),
  };
}
