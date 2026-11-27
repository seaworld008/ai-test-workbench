// @ts-check
import { createCbmGraphProvider } from './cbm-adapter.mjs';
import { compareCodeUnit, createFallbackGraphSnapshot } from './cbm-normalizer.mjs';
import { DEFAULT_GRAPH_ENGINE_ID } from './engine-manifest.mjs';

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
  if (engine === 'builtin') {
    return {
      ok: false,
      provider: 'builtin',
      mode: 'builtin-fallback',
      query,
      degradedReason: 'builtin-engine-requested',
      symbols: [],
      hotspots: [],
      callers: {},
      callees: {},
      truncated: false,
    };
  }
  const targetProviderId = engine === 'auto' ? options.providerId || DEFAULT_GRAPH_ENGINE_ID : engine;
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
