// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { loadAitestConfig } from '../kernel/gate-kernel.mjs';

const DEFAULT_TOKEN_KEYS = ['ACCESS_TOKEN', 'access_token', 'accessToken', 'token', 'jwt'];
const API_ROUTE_RE = /^\/(?:api|admin-api|platform-api|app-api)(?:\/|$|\?)/i;

/**
 * Parses explicit `--auth-headers` input (`Record<string, string>`, `'Header: Value'[]`, or single string).
 * @param {Record<string, string> | string[] | string | null | undefined} rawHeaders
 * @returns {Record<string, string>}
 */
export function parseExplicitAuthHeaders(rawHeaders) {
  /** @type {Record<string, string>} */
  const out = {};
  if (!rawHeaders) return out;
  if (Array.isArray(rawHeaders) || typeof rawHeaders === 'string') {
    const list = Array.isArray(rawHeaders) ? rawHeaders : String(rawHeaders).split(/\r?\n/);
    for (const item of list) {
      const idx = String(item || '').indexOf(':');
      if (idx <= 0) continue;
      const name = item.slice(0, idx).trim();
      const val = item.slice(idx + 1).trim();
      if (name && val) out[name] = val;
    }
    return out;
  }
  if (typeof rawHeaders === 'object') {
    for (const [k, v] of Object.entries(rawHeaders)) {
      if (k && v !== undefined && v !== null && String(v).trim() !== '') {
        out[String(k).trim()] = String(v).trim();
      }
    }
  }
  return out;
}

/**
 * Loads `<qaDir>/playwright/.auth/user.json` and `session.json` unless `options.noAuth === true`,
 * extracting storageState cookies, localStorage tokens, and session entries for parity requests.
 * @param {string} qaDir
 * @param {{ noAuth?: boolean, authHeaders?: Record<string, string> | string[] | string, authStorageKeys?: string[] }} [options]
 */
export function loadParityAuthContext(qaDir, options = {}) {
  const explicitHeaders = parseExplicitAuthHeaders(options.authHeaders);
  if (options.noAuth === true) {
    return {
      hasStorageState: false,
      userStatePath: null,
      cookies: /** @type {Array<Record<string, any>>} */ ([]),
      origins: /** @type {Array<{ origin: string, localStorage: Array<{ name: string, value: string }> }>} */ ([]),
      sessionData: null,
      authStorageKeys: options.authStorageKeys || [],
      explicitHeaders,
    };
  }

  const cfg = loadAitestConfig(qaDir);
  const authStorageKeys = [
    ...(Array.isArray(options.authStorageKeys) ? options.authStorageKeys : []),
    ...(Array.isArray(cfg.parity?.authStorageKeys) ? cfg.parity.authStorageKeys : []),
    ...DEFAULT_TOKEN_KEYS,
  ];

  const authDir = path.join(qaDir, 'playwright', '.auth');
  const userStatePath = path.join(authDir, 'user.json');
  const sessionStatePath = path.join(authDir, 'session.json');

  /** @type {Array<Record<string, any>>} */
  let cookies = [];
  /** @type {Array<{ origin: string, localStorage: Array<{ name: string, value: string }> }>} */
  let origins = [];
  let hasStorageState = false;

  if (fs.existsSync(userStatePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(userStatePath, 'utf8'));
      cookies = Array.isArray(parsed?.cookies) ? parsed.cookies : [];
      origins = Array.isArray(parsed?.origins) ? parsed.origins : [];
      hasStorageState = cookies.length > 0 || origins.some((o) => Array.isArray(o?.localStorage) && o.localStorage.length > 0);
    } catch {
      // ignore malformed user.json
    }
  }

  /** @type {{ origin?: string, entries?: Array<[string, string]> } | null} */
  let sessionData = null;
  if (fs.existsSync(sessionStatePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(sessionStatePath, 'utf8'));
      if (parsed && Array.isArray(parsed.entries)) {
        sessionData = { origin: parsed.origin, entries: parsed.entries };
      }
    } catch {
      // ignore malformed session.json
    }
  }

  return {
    hasStorageState,
    userStatePath: fs.existsSync(userStatePath) ? userStatePath : null,
    cookies,
    origins,
    sessionData,
    authStorageKeys: [...new Set(authStorageKeys)],
    explicitHeaders,
  };
}

/** @param {string} cookieDomain @param {string} hostname */
function cookieMatchesHost(cookieDomain, hostname) {
  const dom = String(cookieDomain || '').trim().toLowerCase();
  const host = String(hostname || '').trim().toLowerCase();
  if (!dom || !host) return false;
  if (dom.startsWith('.')) {
    const bare = dom.slice(1);
    return host === bare || host.endsWith(`.${bare}`);
  }
  return host === dom;
}

/**
 * Builds `Cookie`, `Authorization`, `platform-id`, and explicit auth headers for a specific parity target URL.
 * @param {ReturnType<typeof loadParityAuthContext>} authCtx
 * @param {string} targetUrl
 * @returns {Record<string, string>}
 */
export function buildAuthHeadersForTarget(authCtx, targetUrl) {
  /** @type {Record<string, string>} */
  const headers = {};
  if (!authCtx) return headers;

  let parsedUrl = null;
  try {
    parsedUrl = new URL(targetUrl);
  } catch {
    parsedUrl = null;
  }

  const nowSec = Date.now() / 1000;
  if (parsedUrl && authCtx.cookies.length > 0) {
    const matched = authCtx.cookies.filter((c) => {
      if (!c || !c.name) return false;
      if (typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec) return false;
      if (c.secure && parsedUrl.protocol !== 'https:') return false;
      if (!cookieMatchesHost(c.domain, parsedUrl.hostname)) return false;
      const cPath = String(c.path || '/');
      return parsedUrl.pathname.startsWith(cPath);
    });
    if (matched.length > 0) {
      headers.cookie = matched.map((c) => `${c.name}=${c.value}`).join('; ');
    }
  }

  const orderedOrigins = parsedUrl
    ? [
        ...authCtx.origins.filter((o) => String(o?.origin || '').toLowerCase() === parsedUrl.origin.toLowerCase()),
        ...authCtx.origins.filter((o) => String(o?.origin || '').toLowerCase() !== parsedUrl.origin.toLowerCase()),
      ]
    : authCtx.origins;

  /** @type {Map<string, string>} */
  const lsMap = new Map();
  for (const o of orderedOrigins) {
    for (const item of o?.localStorage || []) {
      if (item?.name && item?.value !== undefined && item?.value !== null && !lsMap.has(item.name)) {
        lsMap.set(String(item.name), String(item.value));
      }
    }
  }

  for (const key of authCtx.authStorageKeys) {
    const tokenVal = lsMap.get(key);
    if (tokenVal && tokenVal.trim()) {
      const trimmed = tokenVal.trim();
      headers.authorization = /^Bearer\s+/i.test(trimmed) ? trimmed : `Bearer ${trimmed}`;
      break;
    }
  }

  const platformId = lsMap.get('PLATFORM_ID') || lsMap.get('platform_id');
  if (platformId && platformId.trim()) {
    headers['platform-id'] = platformId.trim();
  }

  for (const [k, v] of Object.entries(authCtx.explicitHeaders || {})) {
    const lower = k.toLowerCase();
    for (const existingKey of Object.keys(headers)) {
      if (existingKey.toLowerCase() === lower) delete headers[existingKey];
    }
    headers[k] = v;
  }

  return headers;
}

/**
 * Returns whether a parity path targets an API endpoint (built-in prefixes or `aitestConfig.apiPrefixes`).
 * @param {string} reqPath
 * @param {string[]} [extraApiPrefixes]
 * @returns {boolean}
 */
export function isApiRoutePath(reqPath, extraApiPrefixes = []) {
  const clean = String(reqPath || '/').split('?')[0];
  if (API_ROUTE_RE.test(clean)) return true;
  return (extraApiPrefixes || []).some((prefix) => {
    const p = String(prefix || '').trim();
    if (!p) return false;
    const norm = p.endsWith('/') && p.length > 1 ? p.slice(0, -1) : p;
    return clean === norm || clean.startsWith(`${norm}/`);
  });
}

/**
 * @param {Record<string, any>} res
 * @param {boolean} expectApiOrJson
 */
function inspectAuthOrShellSingle(res, expectApiOrJson) {
  if (!res) return null;
  if (res.status === 401 || res.status === 403) {
    return `http-${res.status}`;
  }
  const ct = String(res.headers?.['content-type'] || '');
  if (expectApiOrJson && /text\/html/i.test(ct)) {
    return 'html-shell-on-api';
  }
  const trimmed = String(res.bodyText || '').trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        (parsed.code === 401 || parsed.code === 403 || parsed.status === 401 || parsed.status === 403)
      ) {
        return `envelope-${parsed.code ?? parsed.status}`;
      }
    } catch {
      // ignore non-JSON body
    }
  }
  return null;
}

/**
 * Detects `AUTH_OR_SHELL_INVALID` anti-fake-green conditions where BOTH baseline and candidate
 * return HTTP 401/403, wrapped `{ code: 401|403 }`, `text/html` shell on an API/JSON route,
 * or redirect a non-login UI route to `/login` during `checkAria`.
 *
 * @param {{ method: string, path: string, headers?: Record<string, string>, expectJson?: boolean, featureCohort?: string[] }} reqItem
 * @param {{ status: number, headers: Record<string, string>, bodyText: string }} baseRes
 * @param {{ status: number, headers: Record<string, string>, bodyText: string }} candRes
 * @param {{ base?: { authRedirected?: boolean }, cand?: { authRedirected?: boolean } } | undefined} ariaRec
 * @param {string[]} [apiPrefixes]
 * @returns {{ invalid: boolean, reasonCode: string | null, detail: string | null }}
 */
export function detectAuthOrShellInvalidPair(reqItem, baseRes, candRes, ariaRec, apiPrefixes = []) {
  const accept = String(reqItem.headers?.accept || reqItem.headers?.Accept || '');
  const expectApiOrJson =
    isApiRoutePath(reqItem.path, apiPrefixes) ||
    Boolean(reqItem.expectJson) ||
    /application\/json/i.test(accept) ||
    (Array.isArray(reqItem.featureCohort) && reqItem.featureCohort.includes('json-payload'));

  const baseSignal = inspectAuthOrShellSingle(baseRes, expectApiOrJson);
  const candSignal = inspectAuthOrShellSingle(candRes, expectApiOrJson);
  if (baseSignal && candSignal) {
    return {
      invalid: true,
      reasonCode: baseSignal === candSignal ? baseSignal : `${baseSignal}/${candSignal}`,
      detail: `Both baseline (${baseSignal}) and candidate (${candSignal}) returned invalid auth/HTML-shell responses.`,
    };
  }

  if (ariaRec?.base?.authRedirected && ariaRec?.cand?.authRedirected) {
    return {
      invalid: true,
      reasonCode: 'ui-auth-redirect',
      detail: 'Both baseline and candidate redirected non-login UI route to /login or /signin.',
    };
  }

  return { invalid: false, reasonCode: null, detail: null };
}
