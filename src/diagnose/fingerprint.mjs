// @ts-check
import crypto from 'node:crypto';
import { parsePlaywrightErrorEvidence } from './classifier.mjs';

/**
 * @typedef {{
 *   fingerprintId: string;
 *   routePattern: string;
 *   categoryCode: string;
 *   matcher: string | null;
 *   statusPair: string | null;
 *   jsonPath: string | null;
 *   summarySignature: string;
 * }} DiagnosticFingerprint
 */

/**
 * Normalizes volatile dynamic segments (UUIDs, numeric IDs, hex hashes) in an HTTP route path.
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeRoutePattern(rawPath) {
  return String(rawPath || '')
    .trim()
    .split('?')[0]
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?=\/|$)/gi, '/:uuid')
    .replace(/\/[0-9a-f]{24,64}(?=\/|$)/gi, '/:hexId')
    .replace(/\/\d+(?=\/|$)/g, '/:id')
    .replace(/\/{2,}/g, '/');
}

/**
 * Extracts a normalized route or spec-file pattern for root-cause clustering.
 * @param {Record<string, any>} failure
 * @returns {string}
 */
export function extractFailureRoutePattern(failure) {
  const routes = failure?.codeCorrelation?.routes;
  if (Array.isArray(routes) && routes.length > 0 && typeof routes[0] === 'string') {
    return normalizeRoutePattern(routes[0]);
  }
  const snippet = String(failure?.errorSnippet || '');
  const httpMatch = /\b(GET|POST|PUT|PATCH|DELETE|HEAD)\s+(?:https?:\/\/[^/\s]+)?(\/[^\s"'`),]+)/i.exec(snippet);
  if (httpMatch) {
    return `${httpMatch[1].toUpperCase()} ${normalizeRoutePattern(httpMatch[2])}`;
  }
  const urlMatch = /https?:\/\/[^/\s]+(\/[^\s"'`),]+)/i.exec(snippet);
  if (urlMatch) {
    return normalizeRoutePattern(urlMatch[1]);
  }
  const apiMatch = /\b(\/api\/[^\s"'`),]+)/i.exec(snippet);
  if (apiMatch) {
    return normalizeRoutePattern(apiMatch[1]);
  }
  const file = String(failure?.file || 'unknown').replace(/\\/g, '/');
  return file || 'unknown';
}

/**
 * Extracts an HTTP status transition pair (e.g. `200->500`) if present in error text/evidence.
 * @param {string} cleanErr
 * @param {ReturnType<typeof parsePlaywrightErrorEvidence>} parsedEv
 * @returns {string | null}
 */
function extractStatusPair(cleanErr, parsedEv) {
  if (parsedEv.expectedValue && parsedEv.receivedValue) {
    const expNum = /^\d{3}$/.exec(parsedEv.expectedValue.trim());
    const recNum = /^\d{3}$/.exec(parsedEv.receivedValue.trim());
    if (expNum && recNum) return `${expNum[0]}->${recNum[0]}`;
  }
  const statusMatch = /expected\s+(?:http\s+)?(?:status\s+)?(\d{3})[^0-9]{1,24}(?:got|received|actual)\s+(\d{3})/i.exec(cleanErr);
  if (statusMatch) return `${statusMatch[1]}->${statusMatch[2]}`;
  const serverErr = /\b(50[0234]|40[01349]|422)\b/.exec(cleanErr);
  return serverErr ? `status:${serverErr[1]}` : null;
}

/**
 * Extracts a JSON contract path (e.g. `$.items[0].price`) if mentioned in error evidence.
 * @param {string} cleanErr
 * @returns {string | null}
 */
function extractContractJsonPath(cleanErr) {
  const m = /(\$(?:\.[A-Za-z0-9_$-]+|\[\d+\]|\[\*\])+)/.exec(cleanErr);
  return m ? m[1].replace(/\[\d+\]/g, '[*]') : null;
}

/**
 * Produces a line-number-free, timestamp-free normalized exception signature.
 * @param {string} cleanErr
 * @param {ReturnType<typeof parsePlaywrightErrorEvidence>} parsedEv
 * @returns {string}
 */
export function normalizeErrorSignature(cleanErr, parsedEv) {
  const firstLines = String(cleanErr || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s+/.test(l) && !/^Call log:/i.test(l) && !/^-\s+waiting/i.test(l))
    .slice(0, 2)
    .join(' | ');
  const base = firstLines || 'unknown-error';
  const stripped = base
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g, '<ts>')
    .replace(/\[\d+\]/g, '[*]')
    .replace(/([?&][a-zA-Z0-9_-]+=)\d+/g, '$1<n>')
    .replace(/:\d+:\d+\b/g, ':<line>')
    .replace(/\bline\s+\d+\b/gi, 'line <n>')
    .replace(/\btimeout\s+\d+ms\b/gi, 'timeout <ms>')
    .replace(/\/\d+(?=\/|\s|$)/g, '/:id')
    .replace(/\b\d{5,}\b/g, '<num>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
  return parsedEv.matcher ? `${parsedEv.matcher}:${stripped}` : stripped;
}

/**
 * Computes a deterministic root-cause fingerprint (`fp_<12hex>`) for a diagnosed test failure.
 * @param {Record<string, any>} failure
 * @returns {DiagnosticFingerprint}
 */
export function computeDiagnosticFingerprint(failure) {
  const cleanErr = String(failure?.errorSnippet || '');
  const parsedEv = parsePlaywrightErrorEvidence(cleanErr);
  const routePattern = extractFailureRoutePattern(failure);
  const categoryCode = String(failure?.categoryCode || 'D');
  const matcher = parsedEv.matcherLower || null;
  const statusPair = extractStatusPair(cleanErr, parsedEv);
  const jsonPath = extractContractJsonPath(cleanErr);
  const summarySignature = normalizeErrorSignature(cleanErr, parsedEv);

  const canonical = {
    routePattern,
    categoryCode,
    matcher,
    statusPair,
    jsonPath,
    summarySignature,
  };
  const digest = crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex').slice(0, 12);
  return {
    fingerprintId: `fp_${digest}`,
    routePattern,
    categoryCode,
    matcher,
    statusPair,
    jsonPath,
    summarySignature,
  };
}
