// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCbmGraphProvider } from './cbm-adapter.mjs';
import { compareCodeUnit, createFallbackGraphSnapshot } from './cbm-normalizer.mjs';
import { DEFAULT_GRAPH_ENGINE_ID } from './engine-manifest.mjs';

/**
 * Resolves a path (following existing symlinks/8.3 aliases) for containment checks.
 * @param {string} targetPath
 * @returns {string}
 */
function canonicalComparePath(targetPath) {
  const resolved = path.resolve(targetPath);
  let real = resolved;
  try {
    if (fs.existsSync(resolved)) {
      real = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    }
  } catch {
    real = resolved;
  }
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

/**
 * Returns true when every repository path resides under `os.tmpdir()` (ephemeral test/smoke scratch repos).
 * @param {Array<string | { path: string; label?: string; role?: string }>} repoSpecs
 * @returns {boolean}
 */
export function isEphemeralTempRepoList(repoSpecs) {
  if (!Array.isArray(repoSpecs) || repoSpecs.length === 0) return false;
  const tmpCanon = canonicalComparePath(os.tmpdir());
  const tmpPrefix = tmpCanon.endsWith(path.sep) ? tmpCanon : `${tmpCanon}${path.sep}`;
  let count = 0;
  for (const item of repoSpecs) {
    const rawPath = typeof item === 'string' ? item : item?.path;
    if (!rawPath || typeof rawPath !== 'string') return false;
    const repoCanon = canonicalComparePath(rawPath);
    if (repoCanon !== tmpCanon && !repoCanon.startsWith(tmpPrefix)) return false;
    count += 1;
  }
  return count > 0;
}

/**
 * Returns an optional external-skip reason when `engine === 'auto'` should stay on `builtin-fallback`.
 * Prevents throwaway `os.tmpdir()` test/smoke/demo runs from leaking permanent SQLite DBs into CBM cache.
 * @param {string} engine
 * @param {string} targetProviderId
 * @param {Array<string | { path: string; label?: string; role?: string }>} repoSpecs
 * @param {Record<string, any>} ctx
 * @returns {string | null}
 */
function resolveAutoSkipReason(engine, targetProviderId, repoSpecs, ctx) {
  if (engine !== 'auto') return null;
  const disabledFlag = String(ctx?.env?.AITEST_DISABLE_EXTERNAL_GRAPH ?? process.env.AITEST_DISABLE_EXTERNAL_GRAPH ?? '').trim();
  if (disabledFlag === '1') return 'external-graph-disabled-by-env';
  if (
    targetProviderId === DEFAULT_GRAPH_ENGINE_ID &&
    !ctx?.clientFactory &&
    !ctx?.runProcessImpl &&
    !ctx?.binaryPath &&
    !ctx?.binBaseDir &&
    ctx?.allowTempRepos !== true &&
    isEphemeralTempRepoList(repoSpecs)
  ) {
    return 'ephemeral-tmpdir-repo-skipped';
  }
  return null;
}

/**
 * @typedef {{
 *   id: string;
 *   displayName?: string;
 *   probe: (ctx?: Record<string, any>) => Promise<Record<string, any>>;
 *   syncRepos: (repoSpecs: Array<string | { path: string; label?: string; role?: string }>, ctx?: Record<string, any>) => Promise<import('./cbm-normalizer.mjs').NormalizedGraphSnapshot>;
 *   queryComposite?: (query: string, repoSpecs: Array<string | { path: string; label?: string; role?: string }>, ctx?: Record<string, any>) => Promise<Record<string, any>>;
 * }} GraphProvider
 */

/** @type {Map<string, GraphProvider>} */
const providerRegistry = new Map();

// Register built-in pinned Codebase Memory MCP provider by default
const defaultCbmProvider = createCbmGraphProvider();
providerRegistry.set(defaultCbmProvider.id, defaultCbmProvider);

/**
 * Registers a pluggable Graph Provider SPI implementation.
 * @param {GraphProvider} provider
 * @param {{ overwrite?: boolean }} [options]
 */
export function registerGraphProvider(provider, options = {}) {
  if (!provider || typeof provider !== 'object') {
    throw new TypeError('Graph provider must be an object.');
  }
  const id = String(provider.id || '').trim();
  if (!id || id === 'auto' || id === 'builtin') {
    throw new Error(`Invalid graph provider id "${id}" (cannot be empty, "auto", or "builtin").`);
  }
  if (typeof provider.probe !== 'function' || typeof provider.syncRepos !== 'function') {
    throw new Error(`Graph provider "${id}" must implement probe(ctx) and syncRepos(repoSpecs, ctx).`);
  }
  if (providerRegistry.has(id) && options.overwrite !== true) {
    throw new Error(`Graph provider "${id}" is already registered. Pass { overwrite: true } to replace it.`);
  }
  providerRegistry.set(id, provider);
  return provider;
}

/**
 * Unregisters a graph provider by id (primarily for plugins and tests).
 * @param {string} id
 * @returns {boolean}
 */
export function unregisterGraphProvider(id) {
  return providerRegistry.delete(id);
}

/**
 * Retrieves a registered graph provider by id.
 * @param {string} id
 * @returns {GraphProvider | null}
 */
export function getGraphProvider(id) {
  return providerRegistry.get(id) || null;
}

/**
 * Lists all registered graph providers deterministically.
 * @returns {Array<{ id: string, displayName: string, supportsCompositeQuery: boolean }>}
 */
export function listGraphProviders() {
  return [...providerRegistry.values()]
    .map((p) => ({
      id: p.id,
      displayName: p.displayName || p.id,
      supportsCompositeQuery: typeof p.queryComposite === 'function',
    }))
    .sort((a, b) => compareCodeUnit(a.id, b.id));
}

/**
 * Resolves a normalized graph snapshot using the requested engine strategy:
 * - `'builtin'`: returns zero-dep `builtin-fallback` immediately with zero subprocesses.
 * - `'auto'` (default): probes preferred provider (`codebase-memory-mcp`) and degrades cleanly to
 *   `builtin-fallback` with `degradedReason` if unavailable or unhealthy.
 * - `'codebase-memory-mcp'` (or custom provider id): invokes that provider; if `strict: true`
 *   throws on failure, otherwise returns fail-safe `builtin-fallback` with explicit `degradedReason`.
 * @param {Array<string | { path: string; label?: string; role?: string }>} repoSpecs
 * @param {{
 *   engine?: 'auto' | 'builtin' | 'codebase-memory-mcp' | string;
 *   providerId?: string;
 *   strict?: boolean;
 *   ctx?: Record<string, any>;
 * }} [options]
 * @returns {Promise<import('./cbm-normalizer.mjs').NormalizedGraphSnapshot>}
 */
export async function resolveGraphSnapshot(repoSpecs, options = {}) {
  const engine = String(options.engine || 'auto').trim();
  const ctx = options.ctx || {};

  if (engine === 'builtin') {
    return createFallbackGraphSnapshot('builtin-engine-requested', { provider: 'builtin' });
  }

  const targetProviderId = engine === 'auto' ? options.providerId || DEFAULT_GRAPH_ENGINE_ID : engine;
  const skipReason = resolveAutoSkipReason(engine, targetProviderId, repoSpecs, ctx);
  if (skipReason) {
    return createFallbackGraphSnapshot(skipReason, { provider: 'builtin' });
  }
  const provider = getGraphProvider(targetProviderId);
  if (!provider) {
    const reason = `Graph provider "${targetProviderId}" is not registered.`;
    if (options.strict) throw new Error(reason);
    return createFallbackGraphSnapshot(reason, { provider: targetProviderId });
  }

  try {
    const snapshot = await provider.syncRepos(repoSpecs, ctx);
    if (snapshot && snapshot.meta && snapshot.meta.mode === 'enriched') {
      return snapshot;
    }
    const reason = snapshot?.meta?.degradedReason || `Provider "${targetProviderId}" degraded to builtin-fallback.`;
    if (options.strict) throw new Error(reason);
    return snapshot || createFallbackGraphSnapshot(reason, { provider: targetProviderId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (options.strict) throw err;
    return createFallbackGraphSnapshot(
      `Provider "${targetProviderId}" threw during sync: ${msg}`,
      { provider: targetProviderId }
    );
  }
}

/**
 * Runs a bounded composite symbol/hotspot/caller/callee query through the active graph provider,
 * failing safely to `builtin-fallback` when unavailable.
 * @param {string} query
 * @param {Array<string | { path: string; label?: string; role?: string }>} repoSpecs
 * @param {{
 *   engine?: 'auto' | 'builtin' | 'codebase-memory-mcp' | string;
 *   providerId?: string;
 *   ctx?: Record<string, any>;
 * }} [options]
 */
export async function queryGraphComposite(query, repoSpecs, options = {}) {
  const engine = String(options.engine || 'auto').trim();
  const ctx = options.ctx || {};
  const makeFallbackQuery = (/** @type {string} */ degradedReason, providerName = 'builtin') => ({
    ok: false,
    provider: providerName,
    mode: /** @type {'builtin-fallback'} */ ('builtin-fallback'),
    query,
    degradedReason,
    symbols: [],
    hotspots: [],
    callers: {},
    callees: {},
    truncated: false,
  });
  if (engine === 'builtin') {
    return makeFallbackQuery('builtin-engine-requested');
  }
  const targetProviderId = engine === 'auto' ? options.providerId || DEFAULT_GRAPH_ENGINE_ID : engine;
  const skipReason = resolveAutoSkipReason(engine, targetProviderId, repoSpecs, ctx);
  if (skipReason) {
    return makeFallbackQuery(skipReason);
  }
  const provider = getGraphProvider(targetProviderId);
  if (!provider || typeof provider.queryComposite !== 'function') {
    return {
      ok: false,
      provider: targetProviderId,
      mode: 'builtin-fallback',
      query,
      degradedReason: `Graph provider "${targetProviderId}" does not support composite queries.`,
      symbols: [],
      hotspots: [],
      callers: {},
      callees: {},
      truncated: false,
    };
  }
  try {
    return await provider.queryComposite(query, repoSpecs, options.ctx || {});
  } catch (err) {
    return {
      ok: false,
      provider: targetProviderId,
      mode: 'builtin-fallback',
      query,
      degradedReason: err instanceof Error ? err.message : String(err),
      symbols: [],
      hotspots: [],
      callers: {},
      callees: {},
      truncated: false,
    };
  }
}
