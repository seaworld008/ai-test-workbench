// @ts-check
import { performance } from 'node:perf_hooks';
import { computeNextRedirectRequest, MAX_REDIRECT_HOPS, REDIRECT_STATUSES } from '../kernel/target-redirect.mjs';
import {
  DEFAULT_BLOCKED_ENDPOINTS,
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  evaluateTargetSafety,
  loadMergedQaEnv,
} from '../origin-guard.mjs';
import { buildAuthHeadersForTarget } from './auth-context.mjs';

/**
 * @param {ReturnType<typeof evaluateTargetSafety>} s
 * @param {Record<string, string | undefined>} env
 */
function buildGuardFromSafety(s, env) {
  return {
    baseURL: s.baseURL,
    allowedHosts: s.allowedHosts,
    allowedOrigins: s.allowedOrigins,
    deniedOrigins: s.deniedOrigins,
    extraEgressHosts: s.extraEgressHosts,
    abortThirdPartyHosts: s.abortThirdPartyHosts || [],
    egressMode: s.egressMode || 'allowlist',
    blockedRules: compileBlockedEndpointRules(env.TEST_BLOCKED_ENDPOINTS ?? DEFAULT_BLOCKED_ENDPOINTS),
    strictReadonly: !s.allowMutation,
  };
}

/**
 * Validates BOTH `baselineUrl` and `candidateUrl` (plus optional `baselineApiUrl` / `candidateApiUrl`)
 * against Target Safety Guard fail-closed.
 * @param {string} qaDir
 * @param {string} baselineUrl
 * @param {string} candidateUrl
 * @param {{ allowMutation?: boolean, baselineApiUrl?: string, candidateApiUrl?: string }} [options]
 */
export function validateDualTargetSafety(qaDir, baselineUrl, candidateUrl, options = {}) {
  /** @type {Record<string, string>} */
  const overrides = {};
  if (options.allowMutation === true) overrides.TEST_ALLOW_MUTATION = '1';
  else if (options.allowMutation === false) overrides.TEST_ALLOW_MUTATION = '0';

  const baseEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides, TEST_BASE_URL: baselineUrl });
  const candEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides, TEST_BASE_URL: candidateUrl });
  const baseSafety = evaluateTargetSafety(baseEnv);
  const candSafety = evaluateTargetSafety(candEnv);
  /** @type {string[]} */
  const errors = [];
  if (!baseSafety.ok || !baseSafety.baseURL) {
    errors.push(
      ...(baseSafety.errors.length > 0 ? baseSafety.errors : ['baselineUrl failed target safety validation']).map(
        (e) => `[Baseline] ${e}`
      )
    );
  }
  if (!candSafety.ok || !candSafety.baseURL) {
    errors.push(
      ...(candSafety.errors.length > 0 ? candSafety.errors : ['candidateUrl failed target safety validation']).map(
        (e) => `[Candidate] ${e}`
      )
    );
  }

  let baseApiGuard = null;
  if (options.baselineApiUrl) {
    const baseApiEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides, TEST_BASE_URL: options.baselineApiUrl });
    const baseApiSafety = evaluateTargetSafety(baseApiEnv);
    if (!baseApiSafety.ok || !baseApiSafety.baseURL) {
      errors.push(
        ...(baseApiSafety.errors.length > 0 ? baseApiSafety.errors : ['baselineApiUrl failed target safety validation']).map(
          (e) => `[Baseline API] ${e}`
        )
      );
    } else {
      baseApiGuard = buildGuardFromSafety(baseApiSafety, baseApiEnv);
    }
  }

  let candApiGuard = null;
  if (options.candidateApiUrl) {
    const candApiEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides, TEST_BASE_URL: options.candidateApiUrl });
    const candApiSafety = evaluateTargetSafety(candApiEnv);
    if (!candApiSafety.ok || !candApiSafety.baseURL) {
      errors.push(
        ...(candApiSafety.errors.length > 0 ? candApiSafety.errors : ['candidateApiUrl failed target safety validation']).map(
          (e) => `[Candidate API] ${e}`
        )
      );
    } else {
      candApiGuard = buildGuardFromSafety(candApiSafety, candApiEnv);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, baseGuard: null, candGuard: null, baseApiGuard: null, candApiGuard: null };
  }

  return {
    ok: true,
    errors: /** @type {string[]} */ ([]),
    baseGuard: buildGuardFromSafety(baseSafety, baseEnv),
    candGuard: buildGuardFromSafety(candSafety, candEnv),
    baseApiGuard,
    candApiGuard,
  };
}

/**
 * Merges per-request corpus headers with target-scoped auth headers (replacing `[REDACTED]` placeholders
 * and allowing explicit `--auth-headers` overrides).
 * @param {Record<string, string> | undefined} reqHeaders
 * @param {ReturnType<import('./auth-context.mjs').loadParityAuthContext> | null} authCtx
 * @param {string} targetUrl
 * @returns {Record<string, string>}
 */
function mergeRequestWithAuthHeaders(reqHeaders, authCtx, targetUrl) {
  /** @type {Record<string, string>} */
  const merged = {};
  const authHeaders = authCtx ? buildAuthHeadersForTarget(authCtx, targetUrl) : {};
  const authLowerKeys = new Set(Object.keys(authHeaders).map((k) => k.toLowerCase()));

  for (const [k, v] of Object.entries(reqHeaders || {})) {
    const valStr = String(v ?? '');
    if (valStr.includes('[REDACTED]') && authLowerKeys.has(k.toLowerCase())) continue;
    merged[k] = valStr;
  }

  const existingLower = new Set(Object.keys(merged).map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(authHeaders)) {
    if (!existingLower.has(k.toLowerCase())) merged[k] = v;
  }

  for (const [k, v] of Object.entries(authCtx?.explicitHeaders || {})) {
    for (const prev of Object.keys(merged)) {
      if (prev.toLowerCase() === k.toLowerCase()) delete merged[prev];
    }
    merged[k] = v;
  }
  return merged;
}

/**
 * Executes a single HTTP or SSE request with 10-hop manual redirect validation (`maxRedirects: 0` per hop).
 * @param {string} baseUrl
 * @param {import('./normalizer.mjs').ParityRequestItem} reqItem
 * @param {Record<string, any>} guardConfig
 * @param {number} timeoutMs
 * @param {ReturnType<import('./auth-context.mjs').loadParityAuthContext> | null} authCtx
 */
export async function executeSampleRequest(baseUrl, reqItem, guardConfig, timeoutMs, authCtx) {
  let curMethod = String(reqItem.method || 'GET').toUpperCase();
  let curUrl = new URL(reqItem.path || '/', baseUrl).toString();
  let curHeaders = mergeRequestWithAuthHeaders(reqItem.headers, authCtx, curUrl);
  let curBody =
    curMethod === 'GET' || curMethod === 'HEAD' || reqItem.body === null || reqItem.body === undefined
      ? undefined
      : typeof reqItem.body === 'string'
        ? reqItem.body
        : JSON.stringify(reqItem.body);
  if (curBody !== undefined && !Object.keys(curHeaders).some((k) => k.toLowerCase() === 'content-type')) {
    curHeaders['content-type'] = 'application/json';
  }

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(new Error('Parity request timed out')), timeoutMs);
  const t0 = performance.now();
  try {
    /** @type {Response | null} */
    let finalRes = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const check = checkOutgoingRequestSafety(curMethod, curUrl, guardConfig);
      if (check.blocked) {
        return {
          blocked: true,
          blockedReason: check.reason || 'Blocked by outgoing request guard',
          status: 0,
          headers: /** @type {Record<string, string>} */ ({}),
          bodyText: '',
          durationMs: Number((performance.now() - t0).toFixed(2)),
          ttftMs: null,
          isSse: false,
        };
      }
      const res = await fetch(curUrl, {
        method: curMethod,
        headers: curHeaders,
        body: curBody,
        redirect: 'manual',
        signal: ac.signal,
      });
      const loc = res.headers.get('location');
      if (REDIRECT_STATUSES.has(res.status) && loc) {
        if (hop >= MAX_REDIRECT_HOPS) {
          return {
            blocked: true,
            blockedReason: `Exceeded ${MAX_REDIRECT_HOPS} redirect hops`,
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            bodyText: '',
            durationMs: Number((performance.now() - t0).toFixed(2)),
            ttftMs: null,
            isSse: false,
          };
        }
        const next = computeNextRedirectRequest(curMethod, res.status, loc, curUrl, curHeaders);
        curMethod = next.method;
        curUrl = next.url;
        curHeaders = next.headers;
        if (curMethod === 'GET' || curMethod === 'HEAD') curBody = undefined;
        continue;
      }
      finalRes = res;
      break;
    }

    if (!finalRes) throw new Error('No HTTP response received');

    const headers = Object.fromEntries(finalRes.headers.entries());
    const isSse = /text\/event-stream/i.test(headers['content-type'] || '');
    let bodyText = '';
    /** @type {number | null} */
    let ttftMs = null;

    if (isSse && finalRes.body) {
      const reader = finalRes.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const piece = decoder.decode(value, { stream: true });
        bodyText += piece;
        if (ttftMs === null && piece.trim().length > 0) {
          ttftMs = Number((performance.now() - t0).toFixed(2));
        }
      }
      bodyText += decoder.decode();
    } else {
      bodyText = await finalRes.text();
    }

    return {
      blocked: false,
      blockedReason: null,
      status: finalRes.status,
      headers,
      bodyText,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      ttftMs,
      isSse,
    };
  } finally {
    clearTimeout(tid);
  }
}
