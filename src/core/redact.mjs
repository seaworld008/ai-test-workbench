// @ts-check

export const SECRET_KEY_RE =
  /(?:password|passwd|pwd|secret|token|cookie|authorization|auth|credential|api[_-]?key|private[_-]?key|session[_-]?id|bearer|jwt|otp|pin|hmac[_-]?key)/i;

const COOKIE_OR_STORAGE_SENSITIVE_NAME_RE =
  /(?:password|passwd|pwd|secret|token|cookie|authorization|auth|credential|api[_-]?key|private[_-]?key|session|sess|sid|jwt|csrf|xsrf|otp|pin|bearer|hmac)/i;

const JSON_SECRET_KEY_PATTERN =
  '[A-Za-z0-9_.-]*?(?:password|passwd|pwd|secret|client_secret|clientSecret|token|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|auth_token|authToken|api_key|apiKey|private_key|privateKey|session_id|sessionId|cookie|authorization|credential|bearer|jwt|otp|pin|secretKey|secret_key|hmac_key|hmacKey)[A-Za-z0-9_.-]*';

/**
 * Internal AI Test Workbench correlation/session IDs that are NEVER credentials.
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
 * Redacts credentials, JSON secret fields, JWTs, API tokens (v3 prefixes), private keys,
 * Slack webhooks, Azure storage keys, cookies, query-string tokens, and Basic auth URLs.
 * Preserves internal workbench `heal_*` / `job_*` / ULID identifiers.
 * @param {string} input
 * @returns {string}
 */
export function redactSecrets(input) {
  if (!input || typeof input !== 'string') return '';
  // Strip VT ANSI / OSC escape sequences cleanly before credential scrubbing (`WU-06`)
  let out = input
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

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

  // 3. Redact JSON string/primitive key-value pairs (supporting infix secret keys while preserving workbench IDs)
  const jsonDoubleRe = new RegExp(
    `("(${JSON_SECRET_KEY_PATTERN})"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|\\d[\\d.]*)`,
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
    `('(${JSON_SECRET_KEY_PATTERN})'\\s*:\\s*)('(?:\\\\.|[^'\\\\])*'|"[^"]*"|\\d[\\d.]*)`,
    'gi'
  );
  out = out.replace(jsonSingleRe, (full, prefix, keyName, rawVal) => {
    const bareVal = String(rawVal || '').replace(/^["']|["']$/g, '');
    if (WORKBENCH_INTERNAL_ID_KEYS.has(keyName) && WORKBENCH_SAFE_ID_VALUE_RE.test(bareVal)) {
      return full;
    }
    return `${prefix}'[REDACTED]'`;
  });

  // 4. Redact standalone JWT tokens
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED_JWT]');

  // 5. Redact standalone Bearer / Basic tokens
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
  out = out.replace(/(\bBasic\s+)[A-Za-z0-9+/]{8,}=*/gi, '$1[REDACTED]');

  // 6. Redact well-known cloud / SaaS secret token prefixes & Slack webhooks (`WU-03` Redaction v3)
  out = out.replace(
    /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+/g,
    '[REDACTED_SLACK_WEBHOOK]'
  );
  out = out.replace(
    /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{16,}|glsa_[A-Za-z0-9_]{16,}|sntrys_[A-Za-z0-9_]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|sk-svcacct-[A-Za-z0-9_-]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk_test_[A-Za-z0-9]{16,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{30,45}|npm_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED_TOKEN]'
  );

  // 7. Redact credentials in URLs & Azure Storage AccountKey connection strings
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]*:)([^@\s/'"]+)(@)/g, '$1[REDACTED]$3');
  out = out.replace(/(\bAccountKey\s*=\s*)([^;\s"'\r\n]+)/gi, '$1[REDACTED]');

  // 8. Redact sensitive URL query string parameters
  out = out.replace(
    /([?&](?:token|access_token|refresh_token|id_token|auth_token|api_key|apikey|password|passwd|pwd|secret|client_secret|session_id|sessionid|sig|signature|ticket|otp)=)([^&#\s"']+)/gi,
    '$1[REDACTED]'
  );

  // 9. Redact inline cookie fragments
  out = out.replace(
    /(\b(?:connect\.sid|jsessionid|phpsessid|session_id|sessionid|auth_token|remember_token)\s*=\s*)([^;\s"'\r\n]+)/gi,
    '$1[REDACTED]'
  );

  // 10. Redact KEY=VALUE or KEY: VALUE assignments including infix keys (e.g., AWS_SECRET_ACCESS_KEY=...)
  out = out.replace(
    /(\b(?:[A-Za-z0-9_.-]*?(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|COOKIE|CREDENTIAL|API[_-]?KEY|PRIVATE[_-]?KEY|SESSION[_-]?ID|AUTH[_-]?TOKEN|X[-_]API[-_]KEY)[A-Za-z0-9_.-]*)\s*[:=]\s*)(?!\[REDACTED)([^\s\r\n"',;}]+|"[^"]*"|'[^']*')/gi,
    '$1[REDACTED]'
  );

  return out;
}

/**
 * Recursively redacts secrets inside parsed JSON objects/arrays (`cookies[]`, `localStorage[]`, etc.).
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
    const inCookieArray = /^cookies$/i.test(parentKey);
    const inStorageArray = /^(?:localStorage|sessionStorage)$/i.test(parentKey);
    return /** @type {T} */ (
      /** @type {unknown} */ (
        value.map((item) => {
          if ((inCookieArray || inStorageArray) && item && typeof item === 'object' && !Array.isArray(item)) {
            const scrubbed = /** @type {Record<string, unknown>} */ (redactStructuredValue(item, ''));
            const entryName = String(/** @type {any} */ (item).name || /** @type {any} */ (item).key || '');
            if (inCookieArray || COOKIE_OR_STORAGE_SENSITIVE_NAME_RE.test(entryName)) {
              if ('value' in scrubbed) scrubbed.value = '[REDACTED]';
            }
            return scrubbed;
          }
          return redactStructuredValue(item, '');
        })
      )
    );
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
