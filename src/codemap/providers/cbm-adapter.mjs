// @ts-check
import path from 'node:path';
import { createCbmClient } from './cbm-client.mjs';
import {
  compareCodeUnit,
  createFallbackGraphSnapshot,
  extractCypherRows,
  normalizeCbmGraphSnapshot,
  normalizeCoverageReport,
  normalizeRepoFilePath,
  sanitizeGraphMetadataText,
} from './cbm-normalizer.mjs';
import { probeEngineHealth } from './engine-installer.mjs';
import { DEFAULT_GRAPH_ENGINE_ID } from './engine-manifest.mjs';

// Compact v0.12.1 Cypher queries (omitting 136-char qualified_name prefix & avoiding unsupported WHERE type(r))
const SYMBOLS_CYPHER =
  "MATCH (n) WHERE n.label IN ['Function','Method','Class','Interface'] " +
  'RETURN n.file_path AS file, n.name AS name, n.label AS kind, ' +
  'n.start_line AS startLine, n.end_line AS endLine LIMIT 100000';
const CALL_EDGES_CYPHER =
  'MATCH (a)-[r:CALLS|IMPLEMENTS|INHERITS|HTTP_CALLS|OVERRIDE|HANDLES]->(b) ' +
  'RETURN a.file_path AS fromFile, a.name AS fromName, ' +
  'b.file_path AS toFile, b.name AS toName, type(r) AS kind, r.confidence AS confidence, r.strategy AS strategy LIMIT 100000';
const ROUTE_NODES_CYPHER =
  'MATCH (m)-[:HANDLES]->(r:Route) RETURN m.file_path AS file, m.name AS name, ' +
  'r.method AS httpMethod, r.name AS routePath LIMIT 10000';

/**
 * Fetches paginated Cypher rows via CBM `cursor` / `has_more` with bounded max pages and high output token budget.
 * @param {ReturnType<typeof createCbmClient>} client
 * @param {string} project
 * @param {string} cypher
 * @param {{ maxRows?: number, maxOutputTokens?: number, maxPages?: number, timeoutMs?: number }} [opts]
 */
async function queryAllGraphPages(client, project, cypher, opts = {}) {
  const maxRows = opts.maxRows ?? 100_000;
  const maxOutputTokens = opts.maxOutputTokens ?? 1_500_000;
  const maxPages = opts.maxPages ?? 12;
  /** @type {Array<Record<string, any>>} */
  const allRows = [];
  /** @type {string | undefined} */
  let cursor;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await client.queryGraph(project, cypher, { maxRows, maxOutputTokens, cursor, timeoutMs: opts.timeoutMs });
    if (!res.ok) return { ok: page > 0, rows: allRows, error: res.error || 'query_graph failed' };
    const rows = extractCypherRows(res.data);
    for (const r of rows) allRows.push(r);
    const nextCursor = typeof res.data?.next_cursor === 'string' && res.data.next_cursor ? res.data.next_cursor : undefined;
    if (!res.data?.has_more || !nextCursor || nextCursor === cursor || rows.length === 0) break;
    cursor = nextCursor;
  }
  return { ok: true, rows: allRows, error: null };
}

/** @param {string} p @returns {string} */
function normFsKey(p) {
  return path.resolve(String(p || '')).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

/**
 * @typedef {{ path: string; label?: string; role?: string }} RepoSpecInput
 * @typedef {{ qaDir?: string; binaryPath?: string; pinnedVersion?: string; binarySha256?: string; strictChecksum?: boolean; runtimeDir?: string; cacheDir?: string; binBaseDir?: string; timeoutMs?: number; indexTimeoutMs?: number; maxRssMb?: number; indexMode?: 'full' | 'moderate' | 'fast'; env?: NodeJS.ProcessEnv; platform?: string; runProcessImpl?: any; clientFactory?: typeof createCbmClient }} GraphProviderContext
 */

/** @param {Array<string | RepoSpecInput>} repoSpecs @returns {Array<{ path: string, label: string }>} */
function normalizeRepoSpecs(repoSpecs) {
  /** @type {Array<{ path: string, label: string }>} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of repoSpecs || []) {
    const rawPath = typeof item === 'string' ? item : item?.path;
    if (!rawPath || typeof rawPath !== 'string') continue;
    const resolved = path.resolve(rawPath);
    const dedup = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    out.push({ path: resolved, label: (typeof item === 'object' && item?.label) || path.basename(resolved) || 'repo' });
  }
  return out;
}

/** @param {any} indexData @param {string} fallbackLabel @returns {string} */
function extractProjectName(indexData, fallbackLabel) {
  if (indexData && typeof indexData === 'object') {
    if (typeof indexData.project === 'string' && indexData.project.trim()) return indexData.project.trim();
    if (typeof indexData.name === 'string' && indexData.name.trim()) return indexData.name.trim();
  }
  return fallbackLabel;
}

/**
 * Extracts bounded caller/callee entries from CBM `trace_path` JSON payload (array OR v0.12.1 `{ cols, groups }`).
 * @param {any} rawTrace @param {string} key @param {string} [projectName]
 */
function extractTraceNeighbors(rawTrace, key, projectName = '') {
  if (!rawTrace || typeof rawTrace !== 'object') return [];
  const sub = rawTrace[key];
  const rawList = Array.isArray(sub)
    ? sub
    : sub && typeof sub === 'object'
      ? extractCypherRows(sub)
      : Array.isArray(rawTrace.results)
        ? rawTrace.results
        : Array.isArray(rawTrace.nodes)
          ? rawTrace.nodes
          : [];
  const projPrefix = projectName ? `${projectName}.` : '';
  /** @type {Array<{ id: string, file: string, hop: number, kind: string }>} */
  const out = [];
  for (const item of rawList.slice(0, 25)) {
    if (!item || typeof item !== 'object') continue;
    const file = normalizeRepoFilePath(item.file_path || item.file || '');
    const rawQn = String(item.qualified_name || item.qn || item.id || '').trim();
    const isLongOrPrefixed = Boolean((projPrefix && rawQn.startsWith(projPrefix)) || rawQn.length > 200);
    const trimmedQn = projPrefix && rawQn.startsWith(projPrefix) ? rawQn.slice(projPrefix.length) : rawQn;
    const shortName = sanitizeGraphMetadataText(item.name || (trimmedQn ? trimmedQn.split(/[.:/#]/).pop() : ''), 120);
    const id = isLongOrPrefixed
      ? (file && shortName ? `${file}#${shortName}` : sanitizeGraphMetadataText(trimmedQn, 200) || shortName)
      : sanitizeGraphMetadataText(trimmedQn, 200) || (file && shortName ? `${file}#${shortName}` : shortName);
    if (!id) continue;
    out.push({
      id,
      file,
      hop: Math.max(1, Number(item.hop ?? item.depth ?? 1) || 1),
      kind: sanitizeGraphMetadataText(item.edge_type || item.relation || item.kind || 'CALLS', 40),
    });
  }
  return out.sort((a, b) => a.hop - b.hop || compareCodeUnit(a.id, b.id));
}

/**
 * Merges multiple repo-scoped `NormalizedGraphSnapshot` objects into one deterministic snapshot.
 * @param {import('./cbm-normalizer.mjs').NormalizedGraphSnapshot[]} snapshots
 * @param {{ version: string | null, binarySha256: string | null }} meta
 */
function mergeRepoSnapshots(snapshots, meta) {
  if (snapshots.length === 1) return snapshots[0];
  /** @type {Array<Record<string, any>>} */
  const allSymbols = [];
  /** @type {Array<Record<string, any>>} */
  const allEdges = [];
  /** @type {Array<Record<string, any>>} */
  const allRoutes = [];
  /** @type {Set<string>} */
  const partialFiles = new Set();
  /** @type {Set<string>} */
  const skippedFiles = new Set();
  let allClean = true;
  let maxUnresolved = 0;
  for (const snap of snapshots) {
    for (const s of snap.symbols) allSymbols.push(s);
    for (const e of snap.callEdges) allEdges.push(e);
    for (const ch of snap.controllerChains) {
      if (ch.routePath) allRoutes.push({ file: ch.controllerFile, name: ch.controllerMethod, httpMethod: ch.httpMethod, routePath: ch.routePath });
    }
    if (!snap.meta.coverage.clean) allClean = false;
    for (const f of snap.meta.coverage.parsePartialFiles) partialFiles.add(f);
    for (const f of snap.meta.coverage.skippedFiles) skippedFiles.add(f);
    if (snap.meta.coverage.unresolvedRatio > maxUnresolved) maxUnresolved = snap.meta.coverage.unresolvedRatio;
  }
  return normalizeCbmGraphSnapshot({
    provider: DEFAULT_GRAPH_ENGINE_ID,
    version: meta.version,
    binarySha256: meta.binarySha256,
    rawSymbols: allSymbols,
    rawEdges: allEdges,
    rawRoutes: allRoutes,
    coverage: { clean: allClean, parsePartialFiles: [...partialFiles].sort(compareCodeUnit), skippedFiles: [...skippedFiles].sort(compareCodeUnit), unresolvedRatio: maxUnresolved },
  });
}

/** Creates the built-in `codebase-memory-mcp` Graph Provider SPI adapter. */
export function createCbmGraphProvider() {
  return {
    id: DEFAULT_GRAPH_ENGINE_ID,
    displayName: 'Codebase Memory MCP Sidecar Provider',

    /** @param {GraphProviderContext} [ctx] */
    async probe(ctx = {}) {
      const health = await probeEngineHealth(DEFAULT_GRAPH_ENGINE_ID, ctx);
      return {
        ...health,
        capabilities: {
          cypherQuery: health.ok,
          incrementalIndex: health.ok,
          coverageDiagnostics: health.ok,
          tracePath: health.ok,
          detectChanges: health.ok,
          possibleCallees: false,
        },
      };
    },

    /**
     * Incrementally indexes each target repo, checks coverage, runs bounded Cypher queries,
     * and returns a deterministic `NormalizedGraphSnapshot` (or fail-safe `builtin-fallback`).
     * @param {Array<string | RepoSpecInput>} repoSpecs
     * @param {GraphProviderContext} [ctx]
     */
    async syncRepos(repoSpecs, ctx = {}) {
      const repos = normalizeRepoSpecs(repoSpecs);
      if (repos.length === 0) return createFallbackGraphSnapshot('No repositories supplied for graph sync.');
      const health = await this.probe(ctx);
      if (!health.ok || !health.binaryPath) {
        return createFallbackGraphSnapshot(
          health.reason || `Graph engine unavailable (${health.blockerKind || 'UNKNOWN'}).`,
          { version: health.installedVersion, binarySha256: health.binarySha256 }
        );
      }
      const client = (ctx.clientFactory || createCbmClient)({
        binaryPath: health.binaryPath, runtimeDir: health.dirs.runtimeDir, cacheDir: health.dirs.cacheDir,
        timeoutMs: ctx.timeoutMs, indexTimeoutMs: ctx.indexTimeoutMs, maxRssMb: ctx.maxRssMb, baseEnv: ctx.env,
      });

      const multiRepo = repos.length > 1;
      /** @type {import('./cbm-normalizer.mjs').NormalizedGraphSnapshot[]} */
      const snapshots = [];
      for (const repo of repos) {
        const indexRes = await client.indexRepository(repo.path, { mode: ctx.indexMode || 'moderate', timeoutMs: ctx.indexTimeoutMs });
        if (!indexRes.ok) {
          return createFallbackGraphSnapshot(`index_repository failed for "${repo.label}": ${indexRes.error || 'unknown error'}`, {
            version: health.installedVersion, binarySha256: health.binarySha256,
          });
        }
        const project = extractProjectName(indexRes.data, repo.label);
        const coverageRes = await client.checkIndexCoverage(project, { scopes: ['.'], diagnostics: 'full', pathLimit: 200 });
        const repoPrefix = multiRepo ? repo.label : '';
        const coverage = normalizeCoverageReport(coverageRes.ok ? coverageRes.data : null, indexRes.data, repoPrefix);
        const symbolsRes = await queryAllGraphPages(client, project, SYMBOLS_CYPHER, { maxRows: 100_000, maxOutputTokens: 1_500_000, timeoutMs: ctx.timeoutMs ?? 45_000 });
        if (!symbolsRes.ok) {
          return createFallbackGraphSnapshot(`query_graph(symbols) failed for "${project}": ${symbolsRes.error || 'unknown error'}`, {
            version: health.installedVersion, binarySha256: health.binarySha256,
          });
        }
        const edgesRes = await queryAllGraphPages(client, project, CALL_EDGES_CYPHER, { maxRows: 100_000, maxOutputTokens: 1_500_000, timeoutMs: ctx.timeoutMs ?? 45_000 });
        const routesRes = await queryAllGraphPages(client, project, ROUTE_NODES_CYPHER, { maxRows: 10_000, maxOutputTokens: 500_000, maxPages: 3 }).catch(() => ({ ok: false, rows: [] }));

        snapshots.push(
          normalizeCbmGraphSnapshot({
            provider: DEFAULT_GRAPH_ENGINE_ID,
            version: health.installedVersion,
            binarySha256: health.binarySha256,
            rawSymbols: symbolsRes.rows,
            rawEdges: edgesRes.ok ? edgesRes.rows : [],
            rawRoutes: routesRes.ok ? routesRes.rows : [],
            coverage,
            repoRoot: repo.path,
            repoPrefix,
          })
        );
      }
      return mergeRepoSnapshots(snapshots, { version: health.installedVersion, binarySha256: health.binarySha256 });
    },

    /**
     * Pro-inspired 1-call composite query returning bounded symbols, hotspots, and 1-hop callers/callees.
     * @param {string} query
     * @param {Array<string | RepoSpecInput>} repoSpecs
     * @param {GraphProviderContext & { limit?: number, hotspotLimit?: number }} [ctx]
     */
    async queryComposite(query, repoSpecs, ctx = {}) {
      const cleanQuery = sanitizeGraphMetadataText(query, 160);
      const repos = normalizeRepoSpecs(repoSpecs);
      const empty = (/** @type {string} */ degradedReason) => ({
        ok: false, provider: DEFAULT_GRAPH_ENGINE_ID,
        mode: /** @type {'enriched' | 'builtin-fallback'} */ ('builtin-fallback'),
        query: cleanQuery, degradedReason, symbols: [], hotspots: [], callers: {}, callees: {}, truncated: false,
      });
      if (!cleanQuery || repos.length === 0) return empty(!cleanQuery ? 'Empty query string.' : 'No repositories supplied.');
      const health = await this.probe(ctx);
      if (!health.ok || !health.binaryPath) return empty(health.reason || 'Graph engine unavailable.');

      const client = (ctx.clientFactory || createCbmClient)({
        binaryPath: health.binaryPath, runtimeDir: health.dirs.runtimeDir, cacheDir: health.dirs.cacheDir,
        timeoutMs: ctx.timeoutMs, baseEnv: ctx.env,
      });
      const limit = Math.min(25, Math.max(1, Number(ctx.limit || 15)));
      const hotspotLimit = Math.min(5, Math.max(1, Number(ctx.hotspotLimit || 5)));
      /** @type {Array<{ id: string, name: string, kind: string, file: string, startLine: number, inDegree: number, outDegree: number, project: string, traceTarget: string }>} */
      const symbols = [];
      let truncated = false;

      /** @type {Map<string, string>} */
      const projectByRoot = new Map();
      /** @type {Map<string, string>} */
      const projectByName = new Map();
      const listed = await client.listProjects().catch(() => ({ ok: false, data: null }));
      const projArr = Array.isArray(listed?.data?.projects) ? listed.data.projects : Array.isArray(listed?.data) ? listed.data : [];
      for (const p of projArr) {
        if (!p || typeof p !== 'object') continue;
        const pName = String(p.name || p.project || '').trim();
        if (!pName) continue;
        projectByName.set(pName.toLowerCase(), pName);
        if (typeof p.root_path === 'string' && p.root_path.trim()) projectByRoot.set(normFsKey(p.root_path), pName);
      }

      for (const repo of repos) {
        const project = projectByRoot.get(normFsKey(repo.path)) || projectByName.get(repo.label.toLowerCase()) || repo.label;
        const res = await client.searchGraph(project, { query: cleanQuery, limit, maxOutputTokens: 3200 });
        if (!res.ok) continue;
        if (res.data?.truncated || res.data?.has_more) truncated = true;
        for (const row of extractCypherRows(res.data)) {
          const file = normalizeRepoFilePath(row.file_path || row.file || '', repo.path, repos.length > 1 ? repo.label : '');
          const rawQn = String(row.qualified_name || row.qn || row.id || '').trim();
          const shortName = sanitizeGraphMetadataText(row.name || (rawQn ? rawQn.split(/[.:/#]/).pop() : ''), 120);
          const isPathPrefixedQn = rawQn.startsWith(`${project}.`) || rawQn.length > 200;
          const cleanQn = rawQn.startsWith(`${project}.`) ? rawQn.slice(project.length + 1) : rawQn;
          const id = isPathPrefixedQn
            ? (file && shortName ? `${file}#${shortName}` : sanitizeGraphMetadataText(cleanQn, 200) || shortName)
            : sanitizeGraphMetadataText(cleanQn, 200) || (file && shortName ? `${file}#${shortName}` : shortName);
          if (!id) continue;
          symbols.push({
            id,
            name: shortName || sanitizeGraphMetadataText(id.split(/[.:/#]/).pop(), 120),
            kind: sanitizeGraphMetadataText(row.label || row.kind || 'Symbol', 48),
            file,
            startLine: Math.max(0, Number(row.start_line ?? row.startLine ?? 0) || 0),
            inDegree: Math.max(0, Number(row.in_degree ?? row.inDegree ?? 0) || 0),
            outDegree: Math.max(0, Number(row.out_degree ?? row.outDegree ?? 0) || 0),
            project,
            traceTarget: rawQn || shortName || id,
          });
        }
      }

      symbols.sort((a, b) => b.inDegree + b.outDegree - (a.inDegree + a.outDegree) || compareCodeUnit(a.file, b.file) || compareCodeUnit(a.id, b.id));
      const bounded = symbols.slice(0, limit);
      const hotspots = bounded.slice(0, hotspotLimit);
      /** @type {Record<string, Array<{ id: string, file: string, hop: number, kind: string }>>} */
      const callers = {};
      /** @type {Record<string, Array<{ id: string, file: string, hop: number, kind: string }>>} */
      const callees = {};
      for (const spot of hotspots) {
        const traceRes = await client.tracePath(spot.project, spot.traceTarget, { direction: 'both', depth: 1, limit: 20 });
        if (traceRes.ok && traceRes.data) {
          callers[spot.id] = extractTraceNeighbors(traceRes.data, 'callers', spot.project);
          callees[spot.id] = extractTraceNeighbors(traceRes.data, 'callees', spot.project);
        }
      }
      return {
        ok: true, provider: DEFAULT_GRAPH_ENGINE_ID, version: health.installedVersion,
        mode: /** @type {'enriched' | 'builtin-fallback'} */ ('enriched'),
        query: cleanQuery,
        symbols: bounded.map(({ project: _p, traceTarget: _t, ...rest }) => rest),
        hotspots: hotspots.map(({ project: _p, traceTarget: _t, ...rest }) => rest),
        callers, callees, truncated: truncated || symbols.length > limit,
      };
    },
  };
}
