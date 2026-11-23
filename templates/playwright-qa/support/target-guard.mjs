import fs from 'node:fs';
import path from 'node:path';

/**
 * Single source of truth for target URL allowlist/denylist, production blocking,
 * dangerous endpoint blocking, and .env loading (using Node native process.loadEnvFile).
 * Zero external dependencies. Shared by playwright.config.ts, tests/fixtures/base.ts, and CLI.
 */

export function parseCsvList(value) {
  if (!value || typeof value !== 'string') return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function parseLowerCsvList(value) {
  return parseCsvList(value).map((s) => s.toLowerCase());
}

/**
 * Loads a .env file into process.env using Node >=22.12 built-in process.loadEnvFile if present,
 * without overriding already-set environment variables.
 */
export function loadEnvFileIfPresent(envFilePath) {
  if (!envFilePath || !fs.existsSync(envFilePath)) return {};
  const raw = fs.readFileSync(envFilePath, 'utf8');
  const parsed = parseEnvText(raw);
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
  return parsed;
}

export function parseEnvText(content) {
  const out = {};
  if (!content || typeof content !== 'string') return out;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const cleaned = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eqIndex = cleaned.indexOf('=');
    if (eqIndex <= 0) continue;
    const key = cleaned.slice(0, eqIndex).trim();
    let val = cleaned.slice(eqIndex + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function loadMergedQaEnv(qaDir, overrideEnv = process.env) {
  const fileEnv = fs.existsSync(path.join(qaDir, '.env'))
    ? parseEnvText(fs.readFileSync(path.join(qaDir, '.env'), 'utf8'))
    : {};
  return { ...fileEnv, ...overrideEnv };
}

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

export function parseSafeHttpUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported test URL protocol "${parsed.protocol}". Only http: and https: are allowed.`);
  }
  return parsed;
}

/**
 * Evaluates target environment safety at config load or CLI preflight.
 */
export function evaluateTargetSafety(envInput = {}) {
  const testEnv = (envInput.TEST_ENV || 'local').trim().toLowerCase();
  const baseUrl = (envInput.TEST_BASE_URL || '').trim();
  const requireTarget = envInput.REQUIRE_TEST_TARGET === '1' || envInput.REQUIRE_TEST_TARGET === 'true';
  const allowedHosts = parseLowerCsvList(envInput.TEST_ALLOWED_HOSTS ?? 'localhost,127.0.0.1');
  const allowedOrigins = parseLowerCsvList(envInput.TEST_ALLOWED_ORIGINS ?? '');
  const deniedOrigins = parseLowerCsvList(envInput.TEST_DENIED_ORIGINS ?? '');

  const errors = [];

  if (['production', 'prod', 'live', 'online'].includes(testEnv)) {
    errors.push(`Refusing to run automated tests when TEST_ENV="${testEnv}". Production environments are blocked.`);
  }

  errors.push(...validateAllowlistEntries(allowedHosts));
  errors.push(...validateAllowlistEntries(allowedOrigins));

  if (requireTarget && !baseUrl) {
    errors.push('REQUIRE_TEST_TARGET=1 is set, but TEST_BASE_URL is empty.');
  }

  let parsed = null;
  if (baseUrl) {
    try {
      parsed = parseSafeHttpUrl(baseUrl);
    } catch (err) {
      errors.push(err.message);
      return {
        ok: false,
        errors,
        parsed: null,
        baseURL: undefined,
        allowedHosts,
        allowedOrigins,
        deniedOrigins,
        allowMutation: envInput.TEST_ALLOW_MUTATION === '1' || envInput.TEST_ALLOW_MUTATION === 'true',
      };
    }

    const hostname = parsed.hostname.toLowerCase();
    const hostWithPort = parsed.host.toLowerCase();
    const origin = parsed.origin.toLowerCase();

    if (deniedOrigins.some((d) => origin === d || hostname === d || hostWithPort === d)) {
      errors.push(`Target URL "${baseUrl}" matches TEST_DENIED_ORIGINS.`);
    }

    if (/(^|\.)(prod|production)\./i.test(hostname) && !allowedOrigins.includes(origin)) {
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

  return {
    ok: errors.length === 0,
    errors,
    parsed,
    baseURL: parsed ? baseUrl : undefined,
    allowedHosts,
    allowedOrigins,
    deniedOrigins,
    allowMutation: envInput.TEST_ALLOW_MUTATION === '1' || envInput.TEST_ALLOW_MUTATION === 'true',
  };
}

/**
 * Throws a descriptive Error if target safety checks fail.
 */
export function assertTargetSafety(envInput = {}) {
  const result = evaluateTargetSafety(envInput);
  if (!result.ok) {
    throw new Error(`[AI Test Workbench Target Guard] ${result.errors.join(' | ')}`);
  }
  return result;
}

function globToRegExp(globPattern) {
  const escaped = globPattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

/**
 * Parses TEST_BLOCKED_ENDPOINTS rules such as:
 * "POST /api/pay*,POST /api/sms*,DELETE /api/users/*"
 */
export const DEFAULT_BLOCKED_ENDPOINTS =
  'POST /api/pay*,POST /api/payment*,POST /api/sms*,POST /api/notify/real*,DELETE /api/prod*';

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
 * Checks whether an outgoing HTTP request matches denied origins, blocked endpoint rules,
 * or strict read-only mode. Used by both browser `page.route` and wrapped `request` APIRequestContext.
 */
export function checkOutgoingRequestSafety(method, rawUrl, options = {}) {
  const upperMethod = (method || 'GET').toUpperCase();
  let parsed;
  try {
    parsed = new URL(rawUrl, options.baseURL || 'http://localhost');
  } catch {
    return { blocked: false, reason: null };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { blocked: false, reason: null };
  }

  const origin = parsed.origin.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const hostWithPort = parsed.host.toLowerCase();
  const pathname = parsed.pathname;

  const deniedOrigins = options.deniedOrigins || [];
  if (deniedOrigins.some((d) => origin === d || hostname === d || hostWithPort === d)) {
    return {
      blocked: true,
      reason: `Blocked request to denied origin "${parsed.origin}" (${upperMethod} ${pathname})`,
    };
  }

  const rules = options.blockedRules || [];
  for (const rule of rules) {
    const methodMatch = rule.method === '*' || rule.method === upperMethod;
    if (methodMatch && rule.pathRegex.test(pathname)) {
      return {
        blocked: true,
        reason: `Blocked dangerous endpoint matching rule "${rule.raw}": ${upperMethod} ${pathname}`,
      };
    }
  }

  if (options.strictReadonly) {
    const readMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
    if (!readMethods.has(upperMethod)) {
      const safeWritePaths = options.safeWritePaths || ['/api/login', '/api/auth/login', '/graphql'];
      const isSafeException = safeWritePaths.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
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
