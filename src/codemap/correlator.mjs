// @ts-check
import crypto from 'node:crypto';

/**
 * @typedef {{
 *   table: string,
 *   file: string,
 *   tblLower: string,
 *   singular: string,
 *   plural: string,
 *   wordRe: RegExp,
 * }} CompiledDbEntityMatcher
 */

/** @param {string} s @returns {string} */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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
 * Pre-compiles DB entity matchers ONCE per merge so `correlateDbTablesForRoute` performs
 * zero `new RegExp(...)` allocations inside the `routes x entities x backendFiles` loop.
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
      wordRe: new RegExp(`\\b${escapeRegExp(table)}\\b`, 'i'),
    });
  }
  return compiled;
}

/**
 * Precise controller/entity correlation (`K-04`): avoids naive substring pollution (`user` matching `/user-guide`).
 * @param {{ route: string, linkedApis?: string[], linkedBackendFiles?: string[] }} entry
 * @param {Array<{ table: string, file: string }>} dbEntities
 * @param {Record<string, string>} [backendFileTexts]
 * @param {CompiledDbEntityMatcher[] | null} [compiledEntities]
 * @returns {string[]}
 */
export function correlateDbTablesForRoute(entry, dbEntities, backendFileTexts = {}, compiledEntities = null) {
  const matchers = compiledEntities || compileDbEntityMatchers(dbEntities || []);
  if (matchers.length === 0) return [];

  /** @type {Set<string>} */
  const matched = new Set();
  const routeSegmentSet = new Set(
    entry.route
      .toLowerCase()
      .split('/')
      .filter((s) => s && !s.startsWith(':'))
  );
  const apiSegmentSet = new Set(
    (entry.linkedApis || [])
      .flatMap((a) => a.toLowerCase().split('/'))
      .filter((s) => s && s !== 'api' && !/^v\d+$/.test(s) && !s.startsWith(':'))
  );
  const linkedFiles = entry.linkedBackendFiles || [];
  const linkedFileSet = new Set(linkedFiles);

  for (const entity of matchers) {
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
