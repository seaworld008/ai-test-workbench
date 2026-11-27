// @ts-check
import { normalizeRoutePath } from './route-matcher.mjs';
import { findBalancedClose, parseStaticImports, stripJsComments } from './vue-extractor.mjs';
import { extractLocalJsStringConsts } from './vue-template-factory.mjs';

const API_WRAPPER_FILE_RE = /(?:^|\/)(?:utils|config|api|request|http)\/.*\.(?:js|ts|mjs)$/i;
const DEFAULT_HTTP_CALLEE_RE = /^(?:request|service|http|axios|defHttp|platformRequest|platfromRequest|requestSchool)$/i;
const REQUEST_TARGET_FILE_RE = /(?:request|http|axios|service|client|fetch)/i;

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
 * Normalizes template-literal, concatenated, or relative API URLs
 * (`/infra/job/get?id=${id}` -> `/infra/job/get`, `/items/${id}` -> `/items/:param`).
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
 * Resolves a JS `url` expression (`'/a/b/' + id`, `"/a/b?id=" + id`, `` `/a/${id}` ``, `PREFIX + '/list'`).
 * @param {string} urlExpr
 * @param {Record<string, string>} localConsts
 * @returns {string | null}
 */
function parseUrlExpression(urlExpr, localConsts) {
  const expr = String(urlExpr || '').trim();
  if (!expr) return null;
  const directLit = expr.match(/^(['"`])([^'"`]+)\1$/);
  if (directLit) return directLit[2];

  if (expr.includes('+')) {
    const parts = expr.split('+').map((p) => p.trim()).filter(Boolean);
    let assembled = '';
    for (let i = 0; i < parts.length; i += 1) {
      const p = parts[i];
      const lit = p.match(/^(['"`])([^'"`]+)\1$/);
      if (lit) {
        assembled += lit[2];
        continue;
      }
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(p) && p in localConsts) {
        assembled += localConsts[p];
        continue;
      }
      if (assembled.includes('?')) break;
      if (assembled.endsWith('/')) assembled += ':param';
    }
    return assembled || null;
  }

  const headLit = expr.match(/^(['"`])([^'"`]+)\1/);
  return headLit ? headLit[2] : null;
}

/**
 * Extracts enclosing exported function ranges in JS/TS source for API call attribution.
 * @param {string} stripped
 * @returns {Array<{ name: string, start: number, end: number }>}
 */
function findExportedFunctionRanges(stripped) {
  /** @type {Array<{ name: string, start: number, end: number }>} */
  const ranges = [];
  const fnRe = /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;
  for (const m of stripped.matchAll(fnRe)) {
    const start = m.index || 0;
    const parenIdx = stripped.indexOf('(', start + m[0].length - 1);
    const closeParen = parenIdx >= 0 ? findBalancedClose(stripped, parenIdx, '(', ')') : -1;
    const braceIdx = closeParen >= 0 ? stripped.indexOf('{', closeParen) : -1;
    const closeBrace = braceIdx >= 0 ? findBalancedClose(stripped, braceIdx, '{', '}') : -1;
    if (closeBrace > start) ranges.push({ name: m[1], start, end: closeBrace });
  }
  const arrowRe =
    /\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>/g;
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
 * Extracts axios wrapper prefixes (`baseURL` incl. local consts / prefix concatenation) from request/config files.
 * @param {string} relFile
 * @param {string} text
 * @returns {string[]}
 */
export function extractAxiosPrefixes(relFile, text) {
  if (!API_WRAPPER_FILE_RE.test(relFile)) return [];
  const stripped = stripJsComments(text);
  const localConsts = extractLocalJsStringConsts(stripped);
  /** @type {Set<string>} */
  const prefixes = new Set();
  for (const m of stripped.matchAll(/\bbaseURL\s*:\s*([^\n,;}{]{1,200})/g)) {
    const expr = m[1];
    for (const sm of expr.matchAll(/['"`](\/[A-Za-z0-9_/-]+)['"`]/g)) {
      prefixes.add(normalizeRoutePath(sm[1]));
    }
    for (const part of expr.split('+').map((p) => p.trim())) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) && part in localConsts && localConsts[part].startsWith('/')) {
        prefixes.add(normalizeRoutePath(localConsts[part]));
      }
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
 * Extracts frontend static imports, named symbol imports, API calls (supporting aliased wrappers,
 * template/concat URLs, exported fn names, and per-call client attribution), and axios prefixes.
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
  /** @type {Array<{ method: string, path: string, rawPath?: string, file: string, fnName?: string, clientFile?: string }>} */
  const apiCalls = [];
  /** @type {Record<string, string[]>} */
  const namedImports = {};
  if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro'].includes(ext)) {
    return { apiCalls, imports: /** @type {string[]} */ ([]), axiosPrefixes: /** @type {string[]} */ ([]), namedImports };
  }

  let scriptText = text;
  if (ext === '.vue') {
    const blocks = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
    scriptText = blocks.length > 0 ? blocks.join('\n') : text;
  }

  const stripped = stripJsComments(scriptText);
  const localConsts = extractLocalJsStringConsts(stripped);
  const { specs, identifierToSpec, namedImportsBySpec } = parseStaticImports(stripped);
  /** @type {string[]} */
  const imports = [];
  /** @type {Map<string, string>} */
  const specToResolved = new Map();
  for (const spec of specs) {
    if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/')) {
      const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
      if (chk.exists && chk.resolvedRel) {
        specToResolved.set(spec, chk.resolvedRel);
        if (!imports.includes(chk.resolvedRel)) imports.push(chk.resolvedRel);
        const syms = namedImportsBySpec[spec];
        if (syms && syms.length > 0) {
          const prev = namedImports[chk.resolvedRel] || [];
          namedImports[chk.resolvedRel] = [...new Set([...prev, ...syms])];
        }
      }
    }
  }

  /** @type {Map<string, string>} */
  const identifierToFile = new Map();
  for (const [ident, spec] of identifierToSpec.entries()) {
    const resolved = specToResolved.get(spec);
    if (resolved) identifierToFile.set(ident, resolved);
  }

  const fnRanges = findExportedFunctionRanges(stripped);
  const findFn = (/** @type {number} */ pos) => {
    for (const r of fnRanges) {
      if (pos >= r.start && pos <= r.end) return r.name;
    }
    return undefined;
  };
  const pushCall = (
    /** @type {string} */ method,
    /** @type {string | null} */ apiPath,
    /** @type {number} */ pos,
    /** @type {string | undefined} */ clientFile
  ) => {
    if (!apiPath) return;
    const fnName = findFn(pos);
    apiCalls.push({
      method,
      path: apiPath,
      rawPath: apiPath,
      file: relFile,
      ...(fnName ? { fnName } : {}),
      ...(clientFile ? { clientFile } : {}),
    });
  };

  for (const m of stripped.matchAll(/\bfetch\s*\(\s*(['"`])([^'"`]+)\1/g)) {
    if (m[2].startsWith('/') || /^https?:\/\//i.test(m[2])) {
      pushCall('FETCH', normalizeTemplateApiPath(m[2]), m.index || 0, undefined);
    }
  }

  for (const m of stripped.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\.(get|post|put|delete|patch)\s*\(\s*(['"`])([^'"`]+)\3/gi)) {
    const callee = m[1];
    const clientFile = identifierToFile.get(callee);
    const isHttpClient = DEFAULT_HTTP_CALLEE_RE.test(callee) || Boolean(clientFile && REQUEST_TARGET_FILE_RE.test(clientFile));
    if (!isHttpClient) continue;
    if (m[4].startsWith('/') || /(?:^|\/)api\//.test(relFile)) {
      pushCall(m[2].toUpperCase(), normalizeTemplateApiPath(m[4]), m.index || 0, clientFile);
    }
  }

  for (const m of stripped.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(\s*\{/g)) {
    const callee = m[1];
    const clientFile = identifierToFile.get(callee);
    const isHttpClient = DEFAULT_HTTP_CALLEE_RE.test(callee) || Boolean(clientFile && REQUEST_TARGET_FILE_RE.test(clientFile));
    if (!isHttpClient) continue;
    const braceStart = (m.index || 0) + m[0].length - 1;
    const braceEnd = findBalancedClose(stripped, braceStart, '{', '}');
    if (braceEnd <= braceStart) continue;
    const objProps = extractSimpleObjectProps(stripped.slice(braceStart + 1, braceEnd));
    if (!objProps.url) continue;
    const rawUrl = parseUrlExpression(objProps.url, localConsts);
    if (!rawUrl) continue;
    if (!rawUrl.startsWith('/') && !/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_${}.:-]+)+/.test(rawUrl)) continue;
    const methodMatch = objProps.method ? objProps.method.match(/^(['"`])([A-Za-z]+)\1$/) : null;
    const method = methodMatch ? methodMatch[2].toUpperCase() : 'REQUEST';
    pushCall(method, normalizeTemplateApiPath(rawUrl), m.index || 0, clientFile);
  }

  return { apiCalls, imports, axiosPrefixes: extractAxiosPrefixes(relFile, text), namedImports };
}
