// @ts-check
import { normalizeRoutePath } from './route-matcher.mjs';
import { findBalancedClose, parseStaticImports, stripJsComments } from './vue-extractor.mjs';

const API_WRAPPER_FILE_RE = /(?:^|\/)(?:utils|config|api|request|http)\/.*\.(?:js|ts|mjs)$/i;

/**
 * Extracts depth-1 property expressions from a `{ ... }` object literal.
 * @param {string} objBody
 * @returns {Record<string, string>}
 */
function extractSimpleObjectProps(objBody) {
  /** @type {Record<string, string>} */
  const props = {};
  let i = 0;
  const len = objBody.length;
  while (i < len) {
    while (i < len && /[\s,]/.test(objBody[i])) i += 1;
    if (i >= len) break;
    if (objBody[i] === '.' && objBody.slice(i, i + 3) === '...') {
      while (i < len && objBody[i] !== ',') i += 1;
      continue;
    }
    let key = '';
    if (objBody[i] === "'" || objBody[i] === '"') {
      const q = objBody[i];
      i += 1;
      const start = i;
      while (i < len && objBody[i] !== q) {
        if (objBody[i] === '\\') i += 1;
        i += 1;
      }
      key = objBody.slice(start, i);
      i += 1;
    } else if (/[A-Za-z_$]/.test(objBody[i])) {
      const start = i;
      while (i < len && /[A-Za-z0-9_$]/.test(objBody[i])) i += 1;
      key = objBody.slice(start, i);
    } else {
      i += 1;
      continue;
    }
    while (i < len && /\s/.test(objBody[i])) i += 1;
    if (objBody[i] !== ':') {
      i += 1;
      continue;
    }
    i += 1;
    while (i < len && /\s/.test(objBody[i])) i += 1;
    const valStart = i;
    while (i < len) {
      const ch = objBody[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        i += 1;
        while (i < len) {
          if (objBody[i] === '\\') i += 1;
          else if (objBody[i] === q) break;
          i += 1;
        }
        i += 1;
        continue;
      }
      if (ch === '{' || ch === '[' || ch === '(') {
        const close = findBalancedClose(objBody, i, ch, ch === '{' ? '}' : ch === '[' ? ']' : ')');
        i = close >= 0 ? close + 1 : len;
        continue;
      }
      if (ch === ',') break;
      i += 1;
    }
    props[key] = objBody.slice(valStart, i).trim();
  }
  return props;
}

/**
 * Normalizes template-literal or relative API URLs (`/infra/job/get?id=${id}` -> `/infra/job/get`, `/items/${id}` -> `/items/:param`).
 * @param {string} rawUrl
 * @returns {string | null}
 */
export function normalizeTemplateApiPath(rawUrl) {
  let clean = String(rawUrl || '').trim().split('?')[0].split('#')[0].trim();
  if (!clean || /\s/.test(clean)) return null;
  if (/^https?:\/\//i.test(clean)) {
    try {
      clean = new URL(clean).pathname;
    } catch {
      return null;
    }
  }
  clean = clean.replace(/^\$\{[^}]+\}(?=\/)/, '');
  if (clean.startsWith('${')) return null;
  clean = clean.replace(/\$\{[^}]+\}/g, ':param');
  clean = clean.replace(/\/+/g, '/');
  if (!clean || clean === '/') return null;
  return normalizeRoutePath(clean);
}

/**
 * Extracts enclosing exported function ranges in JS/TS source for API call attribution.
 * @param {string} stripped
 * @returns {Array<{ name: string, start: number, end: number }>}
 */
function findExportedFunctionRanges(stripped) {
  /** @type {Array<{ name: string, start: number, end: number }>} */
  const ranges = [];
  const fnRe = /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of stripped.matchAll(fnRe)) {
    const start = m.index || 0;
    const parenIdx = stripped.indexOf('(', start + m[0].length - 1);
    const closeParen = parenIdx >= 0 ? findBalancedClose(stripped, parenIdx, '(', ')') : -1;
    const braceIdx = closeParen >= 0 ? stripped.indexOf('{', closeParen) : -1;
    const closeBrace = braceIdx >= 0 ? findBalancedClose(stripped, braceIdx, '{', '}') : -1;
    if (closeBrace > start) ranges.push({ name: m[1], start, end: closeBrace });
  }
  const arrowRe = /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g;
  for (const m of stripped.matchAll(arrowRe)) {
    const start = m.index || 0;
    let cursor = start + m[0].length;
    while (cursor < stripped.length && /\s/.test(stripped[cursor])) cursor += 1;
    let end = -1;
    if (stripped[cursor] === '{') {
      end = findBalancedClose(stripped, cursor, '{', '}');
    } else {
      let i = cursor;
      while (i < stripped.length && stripped[i] !== ';' && stripped[i] !== '\n') {
        if (stripped[i] === '(' || stripped[i] === '{' || stripped[i] === '[') {
          const close = findBalancedClose(stripped, i, stripped[i], stripped[i] === '(' ? ')' : stripped[i] === '{' ? '}' : ']');
          if (close > i) { i = close + 1; continue; }
        }
        i += 1;
      }
      end = i;
    }
    if (end > start) ranges.push({ name: m[1], start, end });
  }
  return ranges;
}

/**
 * Extracts axios wrapper prefixes (`baseURL` / prefix concatenation) from request/config files.
 * @param {string} relFile
 * @param {string} text
 * @returns {string[]}
 */
export function extractAxiosPrefixes(relFile, text) {
  if (!API_WRAPPER_FILE_RE.test(relFile)) return [];
  const stripped = stripJsComments(text);
  /** @type {Set<string>} */
  const prefixes = new Set();
  for (const m of stripped.matchAll(/\bbaseURL\s*:\s*([^\n,;}{]{1,200})/g)) {
    for (const sm of m[1].matchAll(/['"`](\/[A-Za-z0-9_/-]+)['"`]/g)) {
      prefixes.add(normalizeRoutePath(sm[1]));
    }
  }
  for (const m of stripped.matchAll(/\burl\s*:\s*['"`](\/(?:admin-api|platform-api|app-api|api)[A-Za-z0-9_/-]*)['"`]\s*\+/g)) {
    prefixes.add(normalizeRoutePath(m[1]));
  }
  for (const m of stripped.matchAll(/\bconst\s+[A-Z0-9_]*(?:API_PREFIX|BASE_API|PREFIX)[A-Z0-9_]*\s*=\s*['"`](\/[A-Za-z0-9_/-]+)['"`]/g)) {
    prefixes.add(normalizeRoutePath(m[1]));
  }
  return [...prefixes];
}

/**
 * Extracts frontend static imports, API calls (including template literals, relative URLs, and exported fn names), and axios prefixes.
 * @param {{
 *   filePath: string,
 *   relFile: string,
 *   ext: string,
 *   text: string,
 *   repoDir: string,
 *   fileIndex?: { relSet?: Set<string>, hasSrcDir?: boolean, truncated?: boolean },
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 * }} ctx
 */
export function extractFrontendImportsAndApis({ filePath, relFile, ext, text, repoDir, fileIndex, resolveImportCandidate }) {
  /** @type {Array<{ method: string, path: string, file: string, fnName?: string }>} */
  const apiCalls = [];
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro'].includes(ext)) {
    return { apiCalls, imports: /** @type {string[]} */ ([]), axiosPrefixes: /** @type {string[]} */ ([]) };
  }

  let scriptText = text;
  if (ext === '.vue') {
    const blocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    scriptText = blocks.length > 0 ? blocks.join('\n') : text;
  }

  const stripped = stripJsComments(scriptText);
  const { specs } = parseStaticImports(stripped);
  /** @type {string[]} */
  const imports = [];
  for (const spec of specs) {
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/')) {
      const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
      if (chk.exists && chk.resolvedRel && !imports.includes(chk.resolvedRel)) {
        imports.push(chk.resolvedRel);
      }
    }
  }

  const fnRanges = findExportedFunctionRanges(stripped);
  const findFn = (/** @type {number} */ pos) => {
    for (const r of fnRanges) {
      if (pos >= r.start && pos <= r.end) return r.name;
    }
    return undefined;
  };
  const pushCall = (/** @type {string} */ method, /** @type {string | null} */ apiPath, /** @type {number} */ pos) => {
    if (!apiPath) return;
    const fnName = findFn(pos);
    apiCalls.push({ method, path: apiPath, file: relFile, ...(fnName ? { fnName } : {}) });
  };

  for (const m of stripped.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    if (m[2].startsWith('/') || /^https?:\/\//i.test(m[2])) {
      pushCall('FETCH', normalizeTemplateApiPath(m[2]), m.index || 0);
    }
  }
  for (const m of stripped.matchAll(/\b(?:axios|defHttp|http|service)\.(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\2/gi)) {
    if (m[3].startsWith('/') || /(?:^|\/)api\//.test(relFile)) {
      pushCall(m[1].toUpperCase(), normalizeTemplateApiPath(m[3]), m.index || 0);
    }
  }

  for (const m of stripped.matchAll(/\b(?:request|service|http)\s*\(\s*\{/g)) {
    const braceStart = (m.index || 0) + m[0].length - 1;
    const braceEnd = findBalancedClose(stripped, braceStart, '{', '}');
    if (braceEnd <= braceStart) continue;
    const objProps = extractSimpleObjectProps(stripped.slice(braceStart + 1, braceEnd));
    if (!objProps.url) continue;
    const urlMatch = objProps.url.match(/^(['"`])([^'"`]+)\1/);
    if (!urlMatch) continue;
    const rawUrl = urlMatch[2];
    if (!rawUrl.startsWith('/') && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_${}.:-]+)+/.test(rawUrl)) continue;
    const methodMatch = objProps.method ? objProps.method.match(/^(['"`])([A-Za-z]+)\1$/) : null;
    const method = methodMatch ? methodMatch[2].toUpperCase() : 'REQUEST';
    pushCall(method, normalizeTemplateApiPath(rawUrl), m.index || 0);
  }

  return { apiCalls, imports, axiosPrefixes: extractAxiosPrefixes(relFile, text) };
}
