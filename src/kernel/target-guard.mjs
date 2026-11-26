import path from 'node:path';
import {
  isLoopbackHttpUrl,
  loadRuntimeConfig,
  validateRuntimeConfig,
} from '../core/runtime-config.mjs';
import {
  applyEnvFileToProcess,
  loadEnvFileIfPresent,
  loadMergedQaEnv,
  parseCsvList,
  parseEnvText,
  parseLowerCsvList,
  readEnvFileIfPresent,
  resolveDefaultMutationPolicy,
} from './target-env.mjs';
import {
  DEFAULT_BLOCKED_ENDPOINTS,
  DEFAULT_SAFE_WRITE_PATHS,
  MAX_REDIRECT_HOPS,
  REDIRECT_STATUSES,
  VALID_EGRESS_MODES,
  compileBlockedEndpointRules,
  computeNextRedirectRequest,
  getVersionStrippedPathCandidates,
  inspectGraphqlPayload,
  normalizeGuardPathname,
  parseSafeHttpUrl,
  validateAllowlistEntries,
} from './target-redirect.mjs';

export {
  DEFAULT_BLOCKED_ENDPOINTS,
  DEFAULT_SAFE_WRITE_PATHS,
  MAX_REDIRECT_HOPS,
  REDIRECT_STATUSES,
  VALID_EGRESS_MODES,
  applyEnvFileToProcess,
  compileBlockedEndpointRules,
  computeNextRedirectRequest,
  inspectGraphqlPayload,
  isLoopbackHttpUrl,
  loadEnvFileIfPresent,
  loadMergedQaEnv,
  loadRuntimeConfig,
  normalizeGuardPathname,
  parseCsvList,
  parseEnvText,
  parseLowerCsvList,
  parseSafeHttpUrl,
  readEnvFileIfPresent,
  resolveDefaultMutationPolicy,
  validateAllowlistEntries,
  validateRuntimeConfig,
};

/**
 * Single source of truth for target URL allowlist/denylist, outbound egress allowlist (`TEST_EGRESS_MODE=allowlist`),
 * production blocking, normalized dangerous endpoint blocking, WebSocket egress blocking, GraphQL mutation blocking,
 * and .env loading (`E-01`, `E-02`, `E-03`, `E-08`).
 * Zero external dependencies. Shared by playwright.config.ts, tests/fixtures/base.ts, explore.mjs, perf.mjs, and CLI.
 */

const ALLOWED_TEST_ENVS = new Set([
  'local',
  'dev',
  'development',
  'test',
  'testing',
  'qa',
  'staging',
  'stage',
  'ci',
  'sandbox',
  'preview',
  'e2e',
  'integration',
  'uat',
]);

const PROD_HOST_LABEL_RE = /(?:^|[.-])(prod|prd|production)(?:$|[.-])/i;

/** @param {Record<string, string | undefined>} [envInput] */
export function evaluateTargetSafety(envInput = {}) {
  const testEnv = (envInput.TEST_ENV || 'local').trim().toLowerCase();
  const baseUrl = (envInput.TEST_BASE_URL || '').trim();
  const requireTarget = envInput.REQUIRE_TEST_TARGET === '1' || envInput.REQUIRE_TEST_TARGET === 'true';
  const allowedHosts = parseLowerCsvList(envInput.TEST_ALLOWED_HOSTS ?? 'localhost,127.0.0.1');
  const allowedOrigins = parseLowerCsvList(envInput.TEST_ALLOWED_ORIGINS ?? '');
  const deniedOrigins = parseLowerCsvList(envInput.TEST_DENIED_ORIGINS ?? '');
  const extraEgressHosts = parseLowerCsvList(envInput.TEST_EGRESS_EXTRA_HOSTS ?? envInput.TEST_EGRESS_ALLOW_HOSTS ?? '');
  const egressMode = (envInput.TEST_EGRESS_MODE || 'allowlist').trim().toLowerCase();

  const errors = [];

  if (['production', 'prod', 'prd', 'live', 'online'].includes(testEnv) || !ALLOWED_TEST_ENVS.has(testEnv)) {
    errors.push(
      `Refusing to run automated tests when TEST_ENV="${testEnv}". Production environments are blocked; allowed TEST_ENV values: ${[...ALLOWED_TEST_ENVS].join(', ')}.`
    );
  }

  if (!VALID_EGRESS_MODES.has(egressMode)) {
    errors.push(
      `Invalid TEST_EGRESS_MODE="${egressMode}". Allowed values: ${[...VALID_EGRESS_MODES].join(', ')}.`
    );
  }

  errors.push(...validateAllowlistEntries(allowedHosts));
  errors.push(...validateAllowlistEntries(allowedOrigins));
  errors.push(...validateAllowlistEntries(extraEgressHosts));

  if (requireTarget && !baseUrl) {
    errors.push('REQUIRE_TEST_TARGET=1 is set, but TEST_BASE_URL is empty.');
  }

  let parsed = null;
  if (baseUrl) {
    try {
      parsed = parseSafeHttpUrl(baseUrl);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
      return {
        ok: false,
        errors,
        parsed: null,
        baseURL: undefined,
        allowedHosts,
        allowedOrigins,
        deniedOrigins,
        extraEgressHosts,
        egressMode,
        allowMutation: envInput.TEST_ALLOW_MUTATION === '1' || envInput.TEST_ALLOW_MUTATION === 'true',
      };
    }

    const hostname = parsed.hostname.toLowerCase();
    const hostWithPort = parsed.host.toLowerCase();
    const origin = parsed.origin.toLowerCase();

    if (deniedOrigins.some((d) => origin === d || hostname === d || hostWithPort === d)) {
      errors.push(`Target URL "${baseUrl}" matches TEST_DENIED_ORIGINS.`);
    }

    if (PROD_HOST_LABEL_RE.test(hostname) && !allowedOrigins.includes(origin)) {
      errors.push(`Target hostname "${hostname}" looks like a production host and is blocked.`);
    }

    const inAllowedOrigins = allowedOrigins.length > 0 && allowedOrigins.includes(origin);
    const inAllowedHosts = allowedHosts.includes(hostname) || allowedHosts.includes(hostWithPort);

    if (allowedHosts.length === 0 && allowedOrigins.length === 0) {
      errors.push('TEST_ALLOWED_HOSTS and TEST_ALLOWED_ORIGINS are both empty; explicit allowlist is required.');
    } else if (!inAllowedOrigins && !inAllowedHosts) {
      errors.push(
        `Target "${hostWithPort}" is not in TEST_ALLOWED_HOSTS (${allowedHosts.join(', ')}) or TEST_ALLOWED_ORIGINS.`
      );
    }
  }

  const finalBaseUrl = parsed ? baseUrl : undefined;
  const mutationPolicy = resolveDefaultMutationPolicy(envInput, finalBaseUrl, testEnv);

  return {
    ok: errors.length === 0,
    errors,
    parsed,
    baseURL: finalBaseUrl,
    allowedHosts,
    allowedOrigins,
    deniedOrigins,
    extraEgressHosts,
    egressMode,
    allowMutation: mutationPolicy.allowMutation,
    strictReadonly: mutationPolicy.strictReadonly,
    isLoopback: mutationPolicy.isLoopback,
  };
}

/** @param {Record<string, string | undefined>} [envInput] */
export function assertTargetSafety(envInput = {}) {
  const result = evaluateTargetSafety(envInput);
  if (!result.ok) {
    throw new Error(`[AI Test Workbench Target Guard] ${result.errors.join(' | ')}`);
  }
  return result;
}

/**
 * @typedef {{
 *   baseURL?: string;
 *   deniedOrigins?: string[];
 *   egressMode?: string;
 *   allowedHosts?: string[];
 *   allowedOrigins?: string[];
 *   extraEgressHosts?: string[];
 *   blockedRules?: Array<{ method: string; pathRegex: RegExp; raw: string }>;
 *   strictReadonly?: boolean;
 *   postData?: string | null;
 *   allowGraphqlQuery?: boolean;
 *   safeWritePaths?: string[];
 *   safePostPaths?: string[];
 * }} OutgoingRequestGuardOptions
 */

/**
 * Checks whether an outgoing HTTP(S) or WebSocket (`ws:`/`wss:`) request violates outbound egress allowlist,
 * denied origins, normalized blocked endpoint rules, GraphQL mutation guards, or strict read-only mode (`E-01..E-03`).
 * @param {string | undefined | null} method
 * @param {string | undefined | null} rawUrl
 * @param {OutgoingRequestGuardOptions} [options]
 */
export function checkOutgoingRequestSafety(method, rawUrl, options = {}) {
  const upperMethod = (method || 'GET').toUpperCase();
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return {
      blocked: true,
      reason: `Blocked empty or non-string outgoing request URL (${upperMethod}) [fail-closed]`,
    };
  }
  let parsed;
  try {
    parsed = new URL(rawUrl, options.baseURL || 'http://localhost');
  } catch {
    return {
      blocked: true,
      reason: `Blocked malformed outgoing request URL "${rawUrl}" (${upperMethod}) [fail-closed]`,
    };
  }

  const isHttp = parsed.protocol === 'http:' || parsed.protocol === 'https:';
  const isWs = parsed.protocol === 'ws:' || parsed.protocol === 'wss:';
  if (!isHttp && !isWs) {
    // Allow inert browser schemes (`data:`, `blob:`, `about:`) only
    if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) {
      return { blocked: false, reason: null };
    }
    return {
      blocked: true,
      reason: `Blocked unsupported outgoing scheme "${parsed.protocol}" (${upperMethod} ${rawUrl})`,
    };
  }

  const origin = parsed.origin.toLowerCase();
  const httpComparableOrigin = origin.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  const hostname = parsed.hostname.toLowerCase();
  const hostWithPort = parsed.host.toLowerCase();
  const pathname = normalizeGuardPathname(parsed.pathname);

  const deniedOrigins = options.deniedOrigins || [];
  if (
    deniedOrigins.some(
      (d) => origin === d || httpComparableOrigin === d || hostname === d || hostWithPort === d
    )
  ) {
    return {
      blocked: true,
      reason: `Blocked request to denied origin "${parsed.origin}" (${upperMethod} ${pathname})`,
    };
  }

  const effectiveEgressMode =
    options.egressMode === undefined || options.egressMode === ''
      ? 'allowlist'
      : String(options.egressMode).trim().toLowerCase();
  if (!VALID_EGRESS_MODES.has(effectiveEgressMode)) {
    return {
      blocked: true,
      reason: `Blocked request under invalid TEST_EGRESS_MODE="${options.egressMode}" (expected allowlist | permissive) [fail-closed]`,
    };
  }

  // Outbound Egress Allowlist (`TEST_EGRESS_MODE=allowlist`, covering HTTP(S) AND WS(S)!)
  if (effectiveEgressMode === 'allowlist') {
    const allowedHosts = options.allowedHosts || ['localhost', '127.0.0.1'];
    const allowedOrigins = options.allowedOrigins || [];
    const extraHosts = options.extraEgressHosts || [];
    let baseHostWithPort = null;
    let baseOrigin = null;
    if (options.baseURL) {
      try {
        const bp = new URL(options.baseURL);
        baseHostWithPort = bp.host.toLowerCase();
        baseOrigin = bp.origin.toLowerCase();
      } catch {
        // ignore
      }
    }
    const hostPermitted =
      allowedHosts.includes(hostname) ||
      allowedHosts.includes(hostWithPort) ||
      extraHosts.includes(hostname) ||
      extraHosts.includes(hostWithPort) ||
      allowedOrigins.includes(origin) ||
      allowedOrigins.includes(httpComparableOrigin) ||
      (baseHostWithPort && hostWithPort === baseHostWithPort) ||
      (baseOrigin && httpComparableOrigin === baseOrigin);

    if (!hostPermitted) {
      return {
        blocked: true,
        reason: `Blocked outbound ${isWs ? 'WebSocket' : 'request'} to non-allowlisted host "${parsed.origin}" (${upperMethod} ${pathname}) under TEST_EGRESS_MODE=allowlist`,
      };
    }
  }

  if (isWs) {
    return { blocked: false, reason: null };
  }

  const pathCandidates = getVersionStrippedPathCandidates(pathname);
  const rules = options.blockedRules || [];
  for (const rule of rules) {
    const methodMatch = rule.method === '*' || rule.method === upperMethod;
    if (methodMatch && pathCandidates.some((cand) => rule.pathRegex.test(cand))) {
      return {
        blocked: true,
        reason: `Blocked dangerous endpoint matching rule "${rule.raw}": ${upperMethod} ${pathname}`,
      };
    }
  }

  if (options.strictReadonly) {
    const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
    if (!readMethods.has(upperMethod)) {
      if (/\/graphql\b/i.test(pathname)) {
        const gql = inspectGraphqlPayload(options.postData);
        if (gql.hasMutation) {
          return {
            blocked: true,
            reason: `TEST_STRICT_READONLY=1 blocked GraphQL mutation on ${pathname}`,
          };
        }
        if (options.allowGraphqlQuery && gql.isPureQuery) {
          return { blocked: false, reason: null };
        }
      }

      const safeWritePaths = (options.safeWritePaths || parseCsvList(DEFAULT_SAFE_WRITE_PATHS)).map(
        normalizeGuardPathname
      );
      const isSafeException = safeWritePaths.some(
        (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
      );
      if (!isSafeException) {
        return {
          blocked: true,
          reason: `TEST_STRICT_READONLY=1 blocked write request ${upperMethod} ${pathname}`,
        };
      }
    }
  }

  return { blocked: false, reason: null };
}

/**
 * Strict Zero-Mutation Request Firewall for 0->1 Exploration (`S-01`, `E-05`).
 * @param {string | undefined | null} method
 * @param {string | undefined | null} rawUrl
 * @param {string | undefined | null} postData
 * @param {OutgoingRequestGuardOptions} [guardConfig]
 */
export function evaluateExploreRequestSafety(method, rawUrl, postData, guardConfig = {}) {
  const upperMethod = (method || 'GET').toUpperCase();
  const baseCheck = checkOutgoingRequestSafety(upperMethod, rawUrl, {
    ...guardConfig,
    postData,
    egressMode: guardConfig.egressMode || 'allowlist',
  });
  if (baseCheck.blocked) return baseCheck;

  if (upperMethod === 'GET' || upperMethod === 'HEAD' || upperMethod === 'OPTIONS') {
    return { blocked: false, reason: null };
  }

  let pathname = '/';
  try {
    if (typeof rawUrl === 'string') {
      pathname = normalizeGuardPathname(new URL(rawUrl, guardConfig.baseURL || 'http://localhost').pathname);
    }
  } catch {
    pathname = '/';
  }

  if (upperMethod === 'POST' && /\/graphql\b/i.test(pathname)) {
    const gql = inspectGraphqlPayload(postData);
    if (gql.hasMutation) {
      return {
        blocked: true,
        reason: `[Explore Read-Only Firewall] Blocked GraphQL mutation on ${pathname}`,
      };
    }
    if (guardConfig.allowGraphqlQuery !== false && gql.isPureQuery) {
      return { blocked: false, reason: null };
    }
  }

  const safePostPaths = (guardConfig.safePostPaths || []).map(normalizeGuardPathname);
  if (
    upperMethod === 'POST' &&
    safePostPaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  ) {
    return { blocked: false, reason: null };
  }

  return {
    blocked: true,
    reason: `[Explore Read-Only Firewall] Default-deny blocked non-read request ${upperMethod} ${pathname}`,
  };
}
