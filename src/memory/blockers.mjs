// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { normalizeRoutePattern } from '../diagnose/fingerprint.mjs';

export const KNOWN_BLOCKERS_REL_PATH = 'known-blockers.json';

/**
 * @typedef {{
 *   id: string;
 *   title: string;
 *   status: 'open' | 'resolved';
 *   categoryCode: string;
 *   routePattern: string;
 *   checkpoint?: string;
 *   fingerprintIds?: string[];
 *   reason: string;
 *   trackingIssue?: string;
 *   approvedBy?: string;
 * }} KnownBlockerEntry
 */

/**
 * Normalizes a route pattern with optional leading HTTP verb (`POST /api/v1/orders/123` -> `{ method: 'POST', path: '/api/v1/orders/:id' }`).
 * @param {string | null | undefined} raw
 */
function parseRouteSpec(raw) {
  const s = String(raw || '').trim();
  if (!s) return { method: null, path: '' };
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.+)$/i.exec(s);
  if (m) {
    return { method: m[1].toUpperCase(), path: normalizeRoutePattern(m[2]) };
  }
  return { method: null, path: normalizeRoutePattern(s) };
}

/**
 * Loads and validates `<qaDir>/known-blockers.json` (protected by `.aitest/governance.lock`).
 * When absent, returns an empty non-error list with zero overhead.
 * @param {string | null | undefined} qaDir
 * @returns {{
 *   ok: boolean;
 *   exists: boolean;
 *   path: string | null;
 *   blockers: KnownBlockerEntry[];
 *   openBlockers: KnownBlockerEntry[];
 *   errors: string[];
 * }}
 */
export function loadKnownBlockers(qaDir) {
  if (!qaDir) {
    return { ok: true, exists: false, path: null, blockers: [], openBlockers: [], errors: [] };
  }
  const filePath = path.join(qaDir, KNOWN_BLOCKERS_REL_PATH);
  if (!fs.existsSync(filePath)) {
    return { ok: true, exists: false, path: filePath, blockers: [], openBlockers: [], errors: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      exists: true,
      path: filePath,
      blockers: [],
      openBlockers: [],
      errors: [`Malformed JSON in ${KNOWN_BLOCKERS_REL_PATH}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const rawList = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.blockers) ? parsed.blockers : null;
  if (!rawList) {
    return {
      ok: false,
      exists: true,
      path: filePath,
      blockers: [],
      openBlockers: [],
      errors: [`${KNOWN_BLOCKERS_REL_PATH} must contain a "blockers" array.`],
    };
  }

  /** @type {KnownBlockerEntry[]} */
  const blockers = [];
  /** @type {string[]} */
  const errors = [];

  rawList.forEach((/** @type {unknown} */ raw, /** @type {number} */ idx) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`blockers[${idx}] must be an object.`);
      return;
    }
    const b = /** @type {Record<string, unknown>} */ (raw);
    const id = typeof b.id === 'string' ? b.id.trim() : '';
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    const status = b.status === 'resolved' ? 'resolved' : b.status === 'open' ? 'open' : null;
    const routePattern = typeof b.routePattern === 'string' ? b.routePattern.trim() : '';
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (!id || !status || !reason) {
      errors.push(`blockers[${idx}] requires non-empty id, status ("open"|"resolved"), and reason.`);
      return;
    }
    const fingerprintIds = Array.isArray(b.fingerprintIds)
      ? b.fingerprintIds.filter((x) => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim())
      : [];
    blockers.push({
      id,
      title: title || id,
      status,
      categoryCode: typeof b.categoryCode === 'string' && b.categoryCode.trim() ? b.categoryCode.trim() : 'C',
      routePattern,
      ...(typeof b.checkpoint === 'string' && b.checkpoint.trim() ? { checkpoint: b.checkpoint.trim() } : {}),
      ...(fingerprintIds.length > 0 ? { fingerprintIds } : {}),
      reason,
      ...(typeof b.trackingIssue === 'string' && b.trackingIssue.trim() ? { trackingIssue: b.trackingIssue.trim() } : {}),
      ...(typeof b.approvedBy === 'string' && b.approvedBy.trim() ? { approvedBy: b.approvedBy.trim() } : {}),
    });
  });

  return {
    ok: errors.length === 0,
    exists: true,
    path: filePath,
    blockers,
    openBlockers: blockers.filter((b) => b.status === 'open'),
    errors,
  };
}

/**
 * Matches a failure or diagnostic/parity cluster against open known blockers by:
 * 1) exact `fingerprintId` inclusion in `blocker.fingerprintIds`, OR
 * 2) normalized `routePattern` match (plus optional `checkpoint` match when both declare a checkpoint),
 *    handling shifted byte-offset derivative fingerprints on the same blocked route.
 *
 * @param {Record<string, any>} item
 * @param {KnownBlockerEntry[]} openBlockers
 * @returns {KnownBlockerEntry | null}
 */
export function matchKnownBlocker(item, openBlockers) {
  if (!item || !Array.isArray(openBlockers) || openBlockers.length === 0) return null;
  const itemFp = typeof item.fingerprintId === 'string' ? item.fingerprintId.trim() : '';

  // Pass 1: exact fingerprintId match takes highest priority
  if (itemFp) {
    for (const blocker of openBlockers) {
      if (Array.isArray(blocker.fingerprintIds) && blocker.fingerprintIds.includes(itemFp)) {
        return blocker;
      }
    }
  }

  // Pass 2: routePattern (+ optional checkpoint) match for shifted derivative fingerprints
  const candidateRoutes = new Set();
  if (typeof item.routePattern === 'string' && item.routePattern.trim()) {
    candidateRoutes.add(item.routePattern.trim());
  }
  if (Array.isArray(item.codeCorrelation?.routes)) {
    for (const r of item.codeCorrelation.routes) candidateRoutes.add(String(r));
  }
  if (Array.isArray(item.codeCorrelation?.apis)) {
    for (const a of item.codeCorrelation.apis) candidateRoutes.add(String(a));
  }
  if (typeof item.file === 'string' && item.file.trim()) {
    candidateRoutes.add(item.file.trim());
  }
  const snippet = String(item.errorSnippet || '');
  const httpInSnippet = /\b(GET|POST|PUT|PATCH|DELETE)\s+(?:https?:\/\/[^/\s]+)?(\/[^\s"'`),]+)/i.exec(snippet);
  if (httpInSnippet) candidateRoutes.add(`${httpInSnippet[1].toUpperCase()} ${httpInSnippet[2]}`);
  const apiInSnippet = /\b(\/api\/[^\s"'`),]+)/i.exec(snippet);
  if (apiInSnippet) candidateRoutes.add(apiInSnippet[1]);

  const parsedCandidates = [...candidateRoutes].map(parseRouteSpec).filter((p) => p.path);
  const itemCheckpoint = typeof item.checkpoint === 'string' ? item.checkpoint.trim() : '';

  for (const blocker of openBlockers) {
    if (!blocker.routePattern) continue;
    if (blocker.checkpoint && itemCheckpoint && blocker.checkpoint !== itemCheckpoint) continue;
    const bSpec = parseRouteSpec(blocker.routePattern);
    if (!bSpec.path) continue;
    for (const cSpec of parsedCandidates) {
      if (bSpec.method && cSpec.method && bSpec.method !== cSpec.method) continue;
      if (cSpec.path === bSpec.path || cSpec.path.endsWith(bSpec.path) || bSpec.path.endsWith(cSpec.path)) {
        return blocker;
      }
    }
  }

  return null;
}

/**
 * Annotates diagnosed failures and deduplicated clusters in-place with `linkedKnownBlockerId`
 * and `knownBlockerReason` whenever they match an `open` blocker in `<qaDir>/known-blockers.json`.
 *
 * @param {string | null | undefined} qaDir
 * @param {Array<Record<string, any>>} failures
 * @param {Array<Record<string, any>>} clusters
 */
export function annotateDiagnosedWithKnownBlockers(qaDir, failures, clusters) {
  const loaded = loadKnownBlockers(qaDir);
  if (loaded.openBlockers.length === 0) {
    return { linkedFailureCount: 0, linkedClusterCount: 0, openBlockers: loaded.openBlockers };
  }

  let linkedFailureCount = 0;
  for (const f of failures || []) {
    const matched = matchKnownBlocker(f, loaded.openBlockers);
    if (matched) {
      f.linkedKnownBlockerId = matched.id;
      f.knownBlockerReason = matched.reason;
      linkedFailureCount += 1;
    }
  }

  let linkedClusterCount = 0;
  for (const c of clusters || []) {
    const matched = matchKnownBlocker(c, loaded.openBlockers);
    if (matched) {
      c.linkedKnownBlockerId = matched.id;
      c.knownBlockerReason = matched.reason;
      linkedClusterCount += 1;
    }
  }

  return { linkedFailureCount, linkedClusterCount, openBlockers: loaded.openBlockers };
}
