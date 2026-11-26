// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets, redactStructuredValue } from '../core/redact.mjs';
import {
  DEFAULT_BLOCKED_ENDPOINTS,
  compileBlockedEndpointRules,
  normalizeGuardPathname,
} from '../kernel/target-redirect.mjs';

const STRIP_REQ_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
  'cookie',
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'x-auth-token',
  'api-key',
  'set-cookie',
]);

const HIGH_RISK_PATH_RE = /\/(?:pay|payment|payments|billing|charge|refund|transfer|sms|delete|destroy|drop|purge|prod)\b/i;
const EMOJI_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;
const UNICODE_ESCAPE_RE = /\\u(?:[dD][89abAB][0-9a-fA-F]{2}|[0-9a-fA-F]{4})/;

/**
 * @typedef {{
 *   id: string;
 *   method: string;
 *   path: string;
 *   headers: Record<string, string>;
 *   body: unknown;
 *   expectedStatus: number | null;
 *   featureCohort: string[];
 *   sourceFormat: 'har' | 'jsonl' | 'otel';
 * }} SanitizedCorpusRecord
 */

/**
 * Auto-detects traffic corpus format (`har` | `jsonl` | `otel`).
 * @param {string} rawText
 * @param {string} [hint]
 * @returns {'har' | 'jsonl' | 'otel'}
 */
export function detectCorpusFormat(rawText, hint = 'auto') {
  const normHint = String(hint || 'auto').toLowerCase();
  if (normHint === 'har' || normHint === 'jsonl' || normHint === 'otel') return normHint;
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return 'jsonl';
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (parsed.log && Array.isArray(parsed.log.entries)) return 'har';
      if (Array.isArray(parsed.resourceSpans) || Array.isArray(parsed.spans)) return 'otel';
    }
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0] && (parsed[0].attributes || parsed[0].traceId)) {
      return 'otel';
    }
  } catch {
    // NDJSON / JSONL
  }
  return 'jsonl';
}

/**
 * Strips any external/production scheme+host into a pure relative `pathname + search` with redacted query params.
 * @param {string} rawUrl
 * @returns {{ relativePath: string, pathname: string, search: string }}
 */
export function stripExternalOriginToRelativePath(rawUrl) {
  const input = String(rawUrl || '/').trim() || '/';
  let pathname = '/';
  let search = '';
  try {
    const parsed = /^https?:\/\//i.test(input) ? new URL(input) : new URL(input, 'http://corpus.local');
    pathname = normalizeGuardPathname(parsed.pathname);
    search = parsed.search || '';
  } catch {
    const qIdx = input.indexOf('?');
    pathname = normalizeGuardPathname(qIdx >= 0 ? input.slice(0, qIdx) : input);
    search = qIdx >= 0 ? input.slice(qIdx) : '';
  }
  const safeSearch = search ? redactSecrets(search) : '';
  return { relativePath: `${pathname}${safeSearch}`, pathname, search: safeSearch };
}

/**
 * Extracts zero-plaintext feature cohort tags for stratified parity tracking.
 * @param {{ method: string, pathname: string, search: string, headers: Record<string, string>, hadAuthHeader: boolean, bodyRaw: string, bodyParsed: any, responseRaw: string }} meta
 * @returns {string[]}
 */
export function extractFeatureCohort(meta) {
  /** @type {Set<string>} */
  const tags = new Set();
  const accept = String(meta.headers['accept'] || '').toLowerCase();
  const contentType = String(meta.headers['content-type'] || '').toLowerCase();
  const combinedRaw = `${meta.bodyRaw || ''}\n${meta.responseRaw || ''}`;

  if (
    accept.includes('text/event-stream') ||
    /\/(?:stream|sse)\b/i.test(meta.pathname) ||
    meta.bodyParsed?.stream === true ||
    /text\/event-stream/i.test(meta.responseRaw || '')
  ) {
    tags.add('streaming');
  }
  if (
    Array.isArray(meta.bodyParsed?.tools) ||
    meta.bodyParsed?.tool_choice !== undefined ||
    /"(?:tools|tool_calls|tool_use|function_call)"/.test(combinedRaw)
  ) {
    tags.add('tools');
  }
  if (meta.bodyParsed?.thinking !== undefined || /"(?:thinking|thinking_delta|reasoning_content)"/.test(combinedRaw)) {
    tags.add('extended-thinking');
  }
  if (EMOJI_RE.test(combinedRaw) || UNICODE_ESCAPE_RE.test(combinedRaw) || /[^\x00-\x7F]/.test(combinedRaw)) {
    tags.add('unicode-emoji');
  }
  if (/[?&](?:page|limit|offset|cursor|per_page)=/i.test(meta.search)) {
    tags.add('pagination');
  }
  if (contentType.includes('application/json') || (meta.bodyParsed && typeof meta.bodyParsed === 'object')) {
    tags.add('json-payload');
  }
  if (meta.hadAuthHeader) {
    tags.add('auth-scoped');
  }
  if (['POST', 'PUT', 'PATCH'].includes(meta.method)) {
    tags.add('write-post');
  }
  return [...tags].sort();
}

/**
 * @param {Record<string, any>} rawHeaders
 */
function sanitizeHeaders(rawHeaders) {
  /** @type {Record<string, string>} */
  const clean = {};
  let hadAuthHeader = false;
  for (const [k, v] of Object.entries(rawHeaders || {})) {
    const lk = String(k).toLowerCase().trim();
    if (!lk || lk.startsWith(':')) continue;
    if (lk === 'authorization' || lk === 'cookie' || lk === 'x-api-key' || lk === 'x-auth-token') {
      hadAuthHeader = true;
    }
    if (STRIP_REQ_HEADERS.has(lk)) continue;
    clean[lk] = redactSecrets(String(v ?? ''));
  }
  return { headers: clean, hadAuthHeader };
}

/**
 * Parses raw entries from HAR 1.2, JSONL, or OTel HTTP Span JSON into uniform intermediate rows.
 * @param {string} rawText
 * @param {'har' | 'jsonl' | 'otel'} format
 */
function parseRawEntries(rawText, format) {
  /** @type {Array<{ method: string, url: string, headers: Record<string, string>, body: unknown, expectedStatus: number | null, responseBody: string }>} */
  const rows = [];

  if (format === 'har') {
    const doc = JSON.parse(rawText);
    for (const entry of doc?.log?.entries || []) {
      const req = entry?.request || {};
      const res = entry?.response || {};
      /** @type {Record<string, string>} */
      const hdrs = {};
      for (const h of req.headers || []) {
        if (h?.name) hdrs[String(h.name)] = String(h.value ?? '');
      }
      rows.push({
        method: String(req.method || 'GET').toUpperCase(),
        url: String(req.url || '/'),
        headers: hdrs,
        body: req.postData?.text ?? null,
        expectedStatus: typeof res.status === 'number' ? res.status : null,
        responseBody: String(res.content?.text || ''),
      });
    }
    return rows;
  }

  if (format === 'otel') {
    const doc = JSON.parse(rawText);
    /** @type {any[]} */
    const spans = [];
    if (Array.isArray(doc)) spans.push(...doc);
    else if (Array.isArray(doc?.spans)) spans.push(...doc.spans);
    else if (Array.isArray(doc?.resourceSpans)) {
      for (const rs of doc.resourceSpans) {
        for (const ss of rs?.scopeSpans || rs?.instrumentationLibrarySpans || []) {
          for (const sp of ss?.spans || []) spans.push(sp);
        }
      }
    }
    for (const sp of spans) {
      /** @type {Record<string, any>} */
      const attrs = {};
      if (Array.isArray(sp?.attributes)) {
        for (const a of sp.attributes) {
          if (!a?.key) continue;
          const v = a.value;
          attrs[a.key] = v?.stringValue ?? v?.intValue ?? v?.doubleValue ?? v?.boolValue ?? v;
        }
      } else if (sp?.attributes && typeof sp.attributes === 'object') {
        Object.assign(attrs, sp.attributes);
      }
      const method = String(attrs['http.request.method'] || attrs['http.method'] || 'GET').toUpperCase();
      const url = String(attrs['url.full'] || attrs['http.url'] || attrs['url.path'] || attrs['http.target'] || '');
      if (!url) continue;
      const st = attrs['http.response.status_code'] ?? attrs['http.status_code'];
      /** @type {Record<string, string>} */
      const hdrs = {};
      for (const [k, v] of Object.entries(attrs)) {
        if (k.startsWith('http.request.header.')) hdrs[k.slice('http.request.header.'.length)] = String(v ?? '');
      }
      rows.push({
        method,
        url,
        headers: hdrs,
        body: attrs['http.request.body'] ?? null,
        expectedStatus: st !== undefined && Number.isFinite(Number(st)) ? Number(st) : null,
        responseBody: String(attrs['http.response.body'] || ''),
      });
    }
    return rows;
  }

  // JSONL (or JSON array fallback)
  const trimmed = String(rawText || '').trim();
  if (!trimmed) return rows;
  if (trimmed.startsWith('[')) {
    const arr = JSON.parse(trimmed);
    for (const item of Array.isArray(arr) ? arr : []) {
      if (item && typeof item === 'object') {
        rows.push({
          method: String(item.method || 'GET').toUpperCase(),
          url: String(item.url || item.path || '/'),
          headers: item.headers && typeof item.headers === 'object' ? item.headers : {},
          body: item.body ?? null,
          expectedStatus: typeof item.expectedStatus === 'number' ? item.expectedStatus : typeof item.status === 'number' ? item.status : null,
          responseBody: typeof item.responseBody === 'string' ? item.responseBody : item.responseBody ? JSON.stringify(item.responseBody) : '',
        });
      }
    }
    return rows;
  }

  for (const line of trimmed.split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    const item = JSON.parse(s);
    if (!item || typeof item !== 'object') continue;
    rows.push({
      method: String(item.method || 'GET').toUpperCase(),
      url: String(item.url || item.path || '/'),
      headers: item.headers && typeof item.headers === 'object' ? item.headers : {},
      body: item.body ?? null,
      expectedStatus: typeof item.expectedStatus === 'number' ? item.expectedStatus : typeof item.status === 'number' ? item.status : null,
      responseBody: typeof item.responseBody === 'string' ? item.responseBody : item.responseBody ? JSON.stringify(item.responseBody) : '',
    });
  }
  return rows;
}

/**
 * Imports and sanitizes offline traffic corpus (`HAR 1.2`, `JSONL`, `OTel HTTP Span JSON`)
 * into `<qaDir>/corpus/sanitized-requests.jsonl`.
 * @param {{ qaDir: string, fromPath: string, format?: string, outputPath?: string, allowMutation?: boolean, dryRun?: boolean }} options
 */
export function importTrafficCorpus(options) {
  const rawText = fs.readFileSync(options.fromPath, 'utf8');
  const format = detectCorpusFormat(rawText, options.format);
  const rawEntries = parseRawEntries(rawText, format);
  const blockedRules = compileBlockedEndpointRules(DEFAULT_BLOCKED_ENDPOINTS);
  const allowMutation = Boolean(options.allowMutation);

  /** @type {SanitizedCorpusRecord[]} */
  const records = [];
  /** @type {Array<{ method: string, path: string, reason: string }>} */
  const filtered = [];
  /** @type {Record<string, number>} */
  const cohortCounts = {};

  for (const row of rawEntries) {
    const method = String(row.method || 'GET').toUpperCase();
    const { relativePath, pathname, search } = stripExternalOriginToRelativePath(row.url);

    if (!allowMutation) {
      const hitRule = blockedRules.find((r) => (r.method === '*' || r.method === method) && r.pathRegex.test(pathname));
      if (hitRule) {
        filtered.push({ method, path: pathname, reason: `blocked-endpoint:${hitRule.raw}` });
        continue;
      }
      if (method === 'DELETE' || HIGH_RISK_PATH_RE.test(pathname)) {
        filtered.push({ method, path: pathname, reason: 'high-risk-delete-or-payment-path' });
        continue;
      }
    }

    const { headers, hadAuthHeader } = sanitizeHeaders(row.headers);
    let bodyRaw = '';
    let bodyParsed = null;
    /** @type {unknown} */
    let sanitizedBody = null;
    if (row.body !== null && row.body !== undefined && row.body !== '') {
      if (typeof row.body === 'string') {
        bodyRaw = row.body;
        try {
          bodyParsed = JSON.parse(row.body);
          sanitizedBody = redactStructuredValue(bodyParsed);
        } catch {
          sanitizedBody = redactSecrets(row.body);
        }
      } else if (typeof row.body === 'object') {
        bodyParsed = row.body;
        bodyRaw = JSON.stringify(row.body);
        sanitizedBody = redactStructuredValue(row.body);
      } else {
        bodyRaw = String(row.body);
        sanitizedBody = redactSecrets(bodyRaw);
      }
    }

    const featureCohort = extractFeatureCohort({
      method,
      pathname,
      search,
      headers,
      hadAuthHeader,
      bodyRaw,
      bodyParsed,
      responseRaw: row.responseBody || '',
    });
    for (const tag of featureCohort) cohortCounts[tag] = (cohortCounts[tag] || 0) + 1;

    records.push({
      id: `req_${String(records.length + 1).padStart(4, '0')}`,
      method,
      path: relativePath,
      headers,
      body: sanitizedBody,
      expectedStatus: row.expectedStatus,
      featureCohort,
      sourceFormat: format,
    });
  }

  const outPath = options.outputPath
    ? path.resolve(options.qaDir, options.outputPath)
    : path.join(options.qaDir, 'corpus', 'sanitized-requests.jsonl');

  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    const content = records.map((r) => JSON.stringify(r)).join('\n') + (records.length > 0 ? '\n' : '');
    fs.writeFileSync(outPath, content, 'utf8');
  }

  return {
    format,
    totalRead: rawEntries.length,
    importedCount: records.length,
    filteredCount: filtered.length,
    filtered,
    cohortCounts,
    records,
    outputPath: options.dryRun ? null : outPath,
  };
}
