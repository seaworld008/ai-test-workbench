// @ts-check
import path from 'node:path';
import { parseCsvList } from './target-env.mjs';

export const VALID_EGRESS_MODES = new Set(['allowlist', 'permissive']);
export const MAX_REDIRECT_HOPS = 10;
export const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export const DEFAULT_BLOCKED_ENDPOINTS =
  'POST /api/pay*,POST /api/payment*,POST /api/sms*,POST /api/notify/real*,DELETE /api/prod*';

export const DEFAULT_SAFE_WRITE_PATHS = '/api/login,/api/auth/login,/__test__/reset';

/** @param {string[]} entries @returns {string[]} */
export function validateAllowlistEntries(entries) {
  const errors = [];
  for (const entry of entries) {
    if (entry.includes('*')) {
      errors.push(`Wildcard host pattern is forbidden in TEST_ALLOWED_HOSTS: "${entry}"`);
    }
    if (entry === '0.0.0.0') {
      errors.push('0.0.0.0 is not a safe allowlist host; use 127.0.0.1 or localhost.');
    }
  }
  return errors;
}

/** @param {string} rawUrl @returns {URL} */
export function parseSafeHttpUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported test URL protocol "${parsed.protocol}". Only http: and https: are allowed.`);
  }
  return parsed;
}

/**
 * Normalizes a request pathname prior to endpoint rule matching (`E-02`).
 * @param {string} rawPathname
 */
export function normalizeGuardPathname(rawPathname) {
  let p = String(rawPathname || '/');
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const decoded = decodeURIComponent(p);
      if (decoded === p) break;
      p = decoded;
    } catch {
      break;
    }
  }
  p = p
    .split('/')
    .map((seg) => seg.split(';')[0])
    .join('/');
  p = p.replace(/\/{2,}/g, '/');
  p = path.posix.normalize(p.startsWith('/') ? p : `/${p}`);
  return p.startsWith('/') ? p : `/${p}`;
}

/** @param {string} globPattern @returns {RegExp} */
function globToRegExp(globPattern) {
  const norm = normalizeGuardPathname(globPattern);
  const escaped = norm.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/** @param {string} [rawRules] */
export function compileBlockedEndpointRules(rawRules = DEFAULT_BLOCKED_ENDPOINTS) {
  const entries = parseCsvList(rawRules);
  const compiled = [];
  for (const item of entries) {
    const parts = item.trim().split(/\s+/);
    if (parts.length === 1) {
      compiled.push({ method: '*', pathRegex: globToRegExp(parts[0]), raw: item });
    } else {
      const method = parts[0].toUpperCase();
      const pathGlob = parts.slice(1).join(' ');
      compiled.push({ method, pathRegex: globToRegExp(pathGlob), raw: item });
    }
  }
  return compiled;
}

/**
 * Inspects a GraphQL HTTP payload (`application/json` or `application/graphql`) to detect mutations (`S-01`, `S-02`).
 * @param {string | undefined | null} postData
 */
export function inspectGraphqlPayload(postData) {
  if (!postData || typeof postData !== 'string') {
    return { isGraphql: false, hasMutation: false, isPureQuery: false, operationName: null };
  }
  let queryText = postData;
  let operationName = null;
  try {
    const parsed = JSON.parse(postData);
    if (Array.isArray(parsed)) {
      const combined = parsed.map((p) => String(p?.query || '')).join('\n');
      queryText = combined;
      operationName = parsed[0]?.operationName || null;
    } else if (parsed && typeof parsed === 'object') {
      queryText = String(parsed.query || '');
      operationName = typeof parsed.operationName === 'string' ? parsed.operationName : null;
      if (!queryText && parsed.extensions?.persistedQuery) {
        return { isGraphql: true, hasMutation: true, isPureQuery: false, operationName };
      }
    }
  } catch {
    // raw graphql body
  }

  const stripped = queryText.replace(/#[^\r\n]*/g, '').trim();
  if (!stripped) {
    return { isGraphql: false, hasMutation: false, isPureQuery: false, operationName };
  }
  const hasMutation = /\b(?:mutation|subscription)\b/i.test(stripped);
  const isPureQuery = !hasMutation && (/^\s*(?:query\b|\{)/i.test(stripped) || Boolean(operationName));
  return { isGraphql: true, hasMutation, isPureQuery, operationName };
}

/** @param {string} normPathname @returns {string[]} */
export function getVersionStrippedPathCandidates(normPathname) {
  const candidates = [normPathname];
  const stripLeadingVersion = normPathname.replace(/^\/v\d+(?=\/)/i, '');
  if (stripLeadingVersion && stripLeadingVersion !== normPathname) {
    candidates.push(stripLeadingVersion);
  }
  const stripMidVersion = normPathname.replace(/^(\/api)\/v\d+(?=\/)/i, '$1');
  if (stripMidVersion && stripMidVersion !== normPathname) {
    candidates.push(stripMidVersion);
  }
  return [...new Set(candidates)];
}

/**
 * Computes the next HTTP request parameters for a 301/302/303/307/308 redirect response
 * according to Fetch/HTTP semantics while stripping sensitive credentials on cross-origin hops.
 *
 * @param {string} currentMethod
 * @param {number} status
 * @param {string} locationHeader
 * @param {string} currentUrl
 * @param {Record<string, string>} [currentHeaders]
 */
export function computeNextRedirectRequest(currentMethod, status, locationHeader, currentUrl, currentHeaders = {}) {
  const method = String(currentMethod || 'GET').toUpperCase();
  const nextUrl = new URL(String(locationHeader || '').trim(), currentUrl).toString();
  const dropBody = status === 303 ? method !== 'GET' && method !== 'HEAD' : (status === 301 || status === 302) && method === 'POST';
  const nextMethod = dropBody ? 'GET' : method;

  /** @type {Record<string, string>} */
  const nextHeaders = {};
  let sameOrigin = false;
  try {
    sameOrigin = new URL(nextUrl).origin.toLowerCase() === new URL(currentUrl).origin.toLowerCase();
  } catch {
    sameOrigin = false;
  }

  for (const [k, v] of Object.entries(currentHeaders || {})) {
    const lower = k.toLowerCase();
    if (lower === 'host') continue;
    if (dropBody && (lower === 'content-length' || lower === 'content-type' || lower === 'transfer-encoding')) {
      continue;
    }
    if (!sameOrigin && (lower === 'authorization' || lower === 'cookie')) {
      continue;
    }
    if (v !== undefined && v !== null) {
      nextHeaders[k] = String(v);
    }
  }

  return {
    method: nextMethod,
    url: nextUrl,
    headers: nextHeaders,
    dropBody,
    crossOrigin: !sameOrigin,
  };
}
