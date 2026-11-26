// @ts-check
import { parseLowerCsvList } from './target-env.mjs';

const FORBIDDEN_LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/**
 * Extracts a normalized bare hostname from an allowed host or origin entry.
 * @param {string} raw
 * @returns {string}
 */
function extractComparableHostname(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (s.includes('://')) {
    try {
      return new URL(s).hostname.toLowerCase();
    } catch {
      return s;
    }
  }
  if (s.startsWith('[') && s.includes(']')) {
    const end = s.indexOf(']');
    return s.slice(1, end);
  }
  const colonIdx = s.indexOf(':');
  return colonIdx > 0 ? s.slice(0, colonIdx) : s;
}

/**
 * Parses and strictly validates `TEST_ABORT_THIRD_PARTY_HOSTS` (fail-closed).
 * Rejects wildcards (`*`), scheme/path/port syntax, loopback hosts, the `TEST_BASE_URL` host,
 * and ANY host present in `TEST_ALLOWED_HOSTS` or `TEST_ALLOWED_ORIGINS`.
 *
 * @param {string | string[] | undefined | null} rawCsv
 * @param {{
 *   baseURL?: string | null;
 *   baseUrl?: string | null;
 *   allowedHosts?: string[];
 *   allowedOrigins?: string[];
 * }} [contextHosts]
 * @returns {{ ok: boolean, hosts: string[], errors: string[] }}
 */
export function parseAndValidateAbortThirdPartyHosts(rawCsv, contextHosts = {}) {
  const entries = Array.isArray(rawCsv)
    ? rawCsv.map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
    : parseLowerCsvList(rawCsv);

  if (entries.length === 0) {
    return { ok: true, hosts: [], errors: [] };
  }

  /** @type {Set<string>} */
  const protectedHosts = new Set();
  const baseRaw = contextHosts.baseURL || contextHosts.baseUrl || '';
  if (baseRaw) {
    try {
      const bp = new URL(baseRaw);
      protectedHosts.add(bp.hostname.toLowerCase());
    } catch {
      // invalid baseURL handled by caller
    }
  }
  for (const h of contextHosts.allowedHosts || []) {
    const cmp = extractComparableHostname(h);
    if (cmp) protectedHosts.add(cmp);
  }
  for (const o of contextHosts.allowedOrigins || []) {
    const cmp = extractComparableHostname(o);
    if (cmp) protectedHosts.add(cmp);
  }

  /** @type {string[]} */
  const validHosts = [];
  /** @type {string[]} */
  const errors = [];

  for (const host of entries) {
    if (host.includes('*')) {
      errors.push(`wildcard host "${host}" is forbidden`);
      continue;
    }
    if (FORBIDDEN_LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\./.test(host)) {
      errors.push(`loopback host "${host}" cannot be silently aborted`);
      continue;
    }
    if (/[:/\s\\@?#[\]]/.test(host)) {
      errors.push(`host "${host}" must be a bare hostname without scheme, port, or path`);
      continue;
    }
    if (protectedHosts.has(host)) {
      errors.push(`host "${host}" conflicts with TEST_BASE_URL / TEST_ALLOWED_HOSTS / TEST_ALLOWED_ORIGINS`);
      continue;
    }
    if (!validHosts.includes(host)) {
      validHosts.push(host);
    }
  }

  return {
    ok: errors.length === 0,
    hosts: validHosts,
    errors,
  };
}

/**
 * Determines whether an outgoing request URL matches a validated `TEST_ABORT_THIRD_PARTY_HOSTS` entry
 * and should be silently aborted (`route.abort('blockedbyclient')`) without failing the test.
 *
 * @param {string | undefined | null} rawUrl
 * @param {{
 *   abortThirdPartyHosts?: string[];
 *   TEST_ABORT_THIRD_PARTY_HOSTS?: string;
 *   TEST_BASE_URL?: string;
 *   TEST_ALLOWED_HOSTS?: string;
 *   TEST_ALLOWED_ORIGINS?: string;
 *   baseURL?: string;
 *   allowedHosts?: string[];
 *   allowedOrigins?: string[];
 * } | null | undefined} envOrSafety
 * @returns {boolean}
 */
export function shouldAbortThirdPartyRequest(rawUrl, envOrSafety) {
  if (!rawUrl || typeof rawUrl !== 'string' || !envOrSafety) return false;

  /** @type {string[]} */
  let abortHosts = [];
  if (Array.isArray(envOrSafety.abortThirdPartyHosts)) {
    abortHosts = envOrSafety.abortThirdPartyHosts.map((h) => String(h || '').trim().toLowerCase()).filter(Boolean);
  } else if (typeof envOrSafety.TEST_ABORT_THIRD_PARTY_HOSTS === 'string' && envOrSafety.TEST_ABORT_THIRD_PARTY_HOSTS.trim()) {
    const validated = parseAndValidateAbortThirdPartyHosts(envOrSafety.TEST_ABORT_THIRD_PARTY_HOSTS, {
      baseURL: envOrSafety.TEST_BASE_URL || envOrSafety.baseURL || '',
      allowedHosts: envOrSafety.allowedHosts || parseLowerCsvList(envOrSafety.TEST_ALLOWED_HOSTS ?? 'localhost,127.0.0.1'),
      allowedOrigins: envOrSafety.allowedOrigins || parseLowerCsvList(envOrSafety.TEST_ALLOWED_ORIGINS ?? ''),
    });
    if (!validated.ok) return false;
    abortHosts = validated.hosts;
  }

  if (abortHosts.length === 0) return false;

  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  return abortHosts.includes(hostname);
}
