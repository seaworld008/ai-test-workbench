// @ts-check

export const SECRET_KEY_RE =
  /(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|cookie|authorization|api[_-]?key|private[_-]?key|session[_-]?id|bearer|jwt|otp|pin|hmac[_-]?key)/i;

const JSON_SECRET_KEY_PATTERN =
  'password|passwd|pwd|secret|client_secret|clientSecret|token|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|auth_token|authToken|api_key|apiKey|private_key|privateKey|session_id|sessionId|cookie|authorization|bearer|jwt|otp|pin|secretKey|secret_key|hmac_key|hmacKey';

/**
 * Internal AI Test Workbench correlation/session IDs that are NEVER credentials.
 * Preserving these avoids breaking MCP heal/job/ledger workflows while still redacting
 * external application session cookies/tokens such as `{"sessionId":"sid_cookie_val_888"}`.
 */
const WORKBENCH_INTERNAL_ID_KEYS = new Set([
  'sessionId',
  'jobId',
  'runId',
  'traceId',
  'spanId',
  'testId',
  'snapshotId',
  'requestId',
  'correlationId',
]);

const WORKBENCH_SAFE_ID_VALUE_RE =
  /^(?:heal_[0-9a-f]{8,32}|job_[0-9a-f]{8,32}|exp_[0-9a-f]{8,32}|snap_[0-9a-f]{8,32}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Redacts credentials, JSON secret fields, JWTs, API tokens, private keys, cookies,
 * query-string tokens, and Basic auth URLs from arbitrary text output.
 * Preserves internal workbench `heal_*` / `job_*` / ULID identifiers.
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (!input || typeof input !== 'string') return '';
  let out = input;

  // 1. Redact PEM private keys completely
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'
  );

  // 2. Redact HTTP header lines (Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-Api-Key, X-Auth-Token)
  out = out.replace(
    /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)\s*:\s*)(?!\s*["'])(?![[{])([^\r\n]+)/gi,
    '$1[REDACTED]'
  );

  // 3. Redact JSON string/primitive key-value pairs while keeping JSON valid AND preserving internal workbench IDs
  const jsonDoubleRe = new RegExp(
    `("([A-Za-z0-9_.-]*?(?:${JSON_SECRET_KEY_PATTERN}))"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|\\d[\\d.]*)`,
    'gi'
  );
  out = out.replace(jsonDoubleRe, (full, prefix, keyName, rawVal) => {
    const bareVal = String(rawVal || '').replace(/^["']|["']$/g, '');
    if (WORKBENCH_INTERNAL_ID_KEYS.has(keyName) && WORKBENCH_SAFE_ID_VALUE_RE.test(bareVal)) {
      return full;
    }
    return `${prefix}"[REDACTED]"`;
  });

  const jsonSingleRe = new RegExp(
    `('([A-Za-z0-9_.-]*?(?:${JSON_SECRET_KEY_PATTERN}))'\\s*:\\s*)('(?:\\\\.|[^'\\\\])*'|"[^"]*"|\\d[\\d.]*)`,
    'gi'
  );
  out = out.replace(jsonSingleRe, (full, prefix, keyName, rawVal) => {
    const bareVal = String(rawVal || '').replace(/^["']|["']$/g, '');
    if (WORKBENCH_INTERNAL_ID_KEYS.has(keyName) && WORKBENCH_SAFE_ID_VALUE_RE.test(bareVal)) {
      return full;
    }
    return `${prefix}'[REDACTED]'`;
  });

  // 4. Redact standalone JWT tokens (eyJ...header.eyJ...payload.signature) anywhere in text/JSON/URLs
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED_JWT]');

  // 5. Redact standalone Bearer / Basic tokens
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
  out = out.replace(/(\bBasic\s+)[A-Za-z0-9+/]{8,}=*/gi, '$1[REDACTED]');

  // 6. Redact well-known cloud / SaaS secret token prefixes
  out = out.replace(
    /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{16,}|glsa_[A-Za-z0-9_]{16,}|sntrys_[A-Za-z0-9_]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED_TOKEN]'
  );

  // 7. Redact credentials in URLs (http/https/postgres/mysql/redis/mongodb/amqp)
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]*:)([^@\s/'"]+)(@)/g, '$1[REDACTED]$3');

  // 8. Redact sensitive URL query string parameters (?token=zzz&api_key=xxx)
  out = out.replace(
    /([?&](?:token|access_token|refresh_token|id_token|auth_token|api_key|apikey|password|passwd|pwd|secret|client_secret|session_id|sessionid|sig|signature|ticket|otp)=)([^&#\s"']+)/gi,
    '$1[REDACTED]'
  );

  // 9. Redact inline cookie fragments (`connect.sid=...`, `JSESSIONID=...`, `PHPSESSID=...`, `session_id=...`)
  out = out.replace(
    /(\b(?:connect\.sid|jsessionid|phpsessid|session_id|sessionid|auth_token|remember_token)\s*=\s*)([^;\s"'\r\n]+)/gi,
    '$1[REDACTED]'
  );

  // 10. Redact KEY=VALUE or KEY: VALUE secret assignments
  out = out.replace(
    /(\b(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|COOKIE|API_KEY|PRIVATE_KEY|SESSION_ID)|password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api_key|private_key|session_id)\b\s*[:=]\s*)(?!\[REDACTED)([^\s\r\n"',;}]+|"[^"]*"|'[^']*')/gi,
    '$1[REDACTED]'
  );

  return out;
}

/**
 * Recursively redacts secrets inside a parsed JSON object/array AFTER parsing,
 * preserving allowlisted workbench correlation IDs (`sessionId`, `jobId`, `runId`, `traceId`, `testId`)
 * while strictly redacting credentials, tokens, passwords, and embedded secrets inside strings.
 * @template T
 * @param {T} value
 * @param {string} [parentKey]
 * @returns {T}
 */
export function redactStructuredValue(value, parentKey = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (WORKBENCH_INTERNAL_ID_KEYS.has(parentKey)) {
      if (WORKBENCH_SAFE_ID_VALUE_RE.test(value) || parentKey === 'testId') {
        return /** @type {T} */ (/** @type {unknown} */ (value));
      }
      if (/^sessionId$/i.test(parentKey) && !WORKBENCH_SAFE_ID_VALUE_RE.test(value)) {
        return /** @type {T} */ (/** @type {unknown} */ ('[REDACTED]'));
      }
      return /** @type {T} */ (/** @type {unknown} */ (redactSecrets(value)));
    }
    if (parentKey && SECRET_KEY_RE.test(parentKey)) {
      return /** @type {T} */ (/** @type {unknown} */ ('[REDACTED]'));
    }
    return /** @type {T} */ (/** @type {unknown} */ (redactSecrets(value)));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (parentKey && !WORKBENCH_INTERNAL_ID_KEYS.has(parentKey) && SECRET_KEY_RE.test(parentKey)) {
      return /** @type {T} */ (/** @type {unknown} */ ('[REDACTED]'));
    }
    return value;
  }
  if (Array.isArray(value)) {
    return /** @type {T} */ (/** @type {unknown} */ (value.map((item) => redactStructuredValue(item, ''))));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactStructuredValue(v, k);
    }
    return /** @type {T} */ (/** @type {unknown} */ (out));
  }
  return value;
}

/**
 * Redacts sensitive environment variable dictionaries before printing or saving diagnostics.
 * @param {Record<string, unknown> | null | undefined} envObj
 * @returns {Record<string, unknown>}
 */
export function redactEnvEntries(envObj) {
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [k, v] of Object.entries(envObj || {})) {
    result[k] = SECRET_KEY_RE.test(k) ? '[REDACTED]' : typeof v === 'string' ? redactSecrets(v) : v;
  }
  return result;
}
