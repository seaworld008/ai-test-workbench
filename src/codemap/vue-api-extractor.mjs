// @ts-check
import fs from 'node:fs';
import { normalizeRoutePath } from './route-matcher.mjs';
import { extractTopLevelObjectProps, findBalancedClose, parseStaticImports, stripJsComments } from './vue-extractor.mjs';
import { extractLocalJsStringConsts, extractUrlPrefixHelpers } from './vue-template-factory.mjs';

const API_WRAPPER_FILE_RE = /(?:^|\/)(?:utils|config|api|request|http)\/.*\.(?:js|ts|mjs|cjs)$/i;
const DEFAULT_HTTP_CALLEE_RE =
  /^(?:request|service|http|\$http|axios|\$axios|defHttp|apiClient|requestClient|httpClient|fetchClient|platformRequest|platfromRequest|requestSchool)$/i;
const REQUEST_TARGET_FILE_RE = /(?:request|http|axios|service|client|fetch)/i;
const FRONTEND_API_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro']);
const HTTP_METHOD_LITERAL_RE = /^(['"`])\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s*\1$/i;

/**
 * Skips balanced TypeScript generic type arguments `<Result<Foo[]>>` starting at `idx` when followed by `\s*(`.
 * @param {string} text @param {number} idx @returns {number}
 */
export function skipBalancedAngleBrackets(text, idx) {
  let i = idx;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  if (i >= text.length || text[i] !== '<') return -1;
  for (let a = 0, p = 0, b = 0, k = 0, limit = Math.min(text.length, i + 800); i < limit; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') { i += 1; while (i < limit && text[i] !== ch) { if (text[i] === '\\') i += 1; i += 1; } continue; }
    if (ch === '=' && text[i + 1] === '>') { i += 1; continue; }
    if (ch === '(') p += 1;
    else if (ch === ')') { if (--p < 0) return -1; }
    else if (ch === '{') b += 1;
    else if (ch === '}') { if (--b < 0) return -1; }
    else if (ch === '[') k += 1;
    else if (ch === ']') { if (--k < 0) return -1; }
    else if (ch === '<') a += 1;
    else if (ch === '>') {
      if (--a === 0) {
        if (p || b || k) return -1;
        let j = i + 1;
        while (j < text.length && /\s/.test(text[j])) j += 1;
        return text[j] === '(' ? j : -1;
      }
    } else if (!p && !b && !k && (ch === ';' || ch === '=' || (ch === '&' && text[i + 1] === '&') || (ch === '|' && text[i + 1] === '|') || (ch === '!' && text[i + 1] === '='))) return -1;
  }
  return -1;
}

/** @param {string} text @param {string} sep @returns {string[]} */
function splitTopLevelByChar(text, sep) {
  /** @type {string[]} */
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i += 1;
      while (i < text.length && text[i] !== ch) { if (text[i] === '\\') i += 1; i += 1; }
    } else if (ch === '(' || ch === '[' || ch === '{') {
      const cl = findBalancedClose(text, i, ch, ch === '(' ? ')' : ch === '[' ? ']' : '}');
      i = cl >= 0 ? cl : text.length;
    } else if (ch === sep) {
      out.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) out.push(tail);
  return out;
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
    try { clean = new URL(clean.replace(/\$\{[^}]+\}/g, ':param')).pathname; } catch { return null; }
  }
  clean = clean.replace(/^\$\{[^}]+\}(?=\/)/, '');
  if (clean.startsWith('${')) return null;
  clean = clean.replace(/\$\{[^}]+\}/g, ':param').replace(/\/+/g, '/');
  return !clean || clean === '/' ? null : normalizeRoutePath(clean);
}

/**
 * Resolves a JS/TS `url` expression (`'/a/b/' + id`, `` `/a/${id}` ``, `PREFIX + '/list'`, `baseUrlApi('nodes')`).
 * @param {string} urlExpr
 * @param {Record<string, string>} localConsts
 * @param {Record<string, string>} [urlPrefixHelpers]
 * @param {Record<string, Record<string, string>>} [namespacePrefixHelpers]
 * @param {number} [depth]
 * @returns {string | null}
 */
function parseUrlExpression(urlExpr, localConsts, urlPrefixHelpers = {}, namespacePrefixHelpers = {}, depth = 0) {
  if (depth > 4) return null;
  const expr = String(urlExpr || '').trim().replace(/\s+as\s+[A-Za-z_$][A-Za-z0-9_$.<>[\]]*$/, '').trim();
  if (!expr) return null;
  const directLit = expr.match(/^(['"])([^'"\n]*)\1$/);
  if (directLit) return directLit[2];
  if (expr.startsWith('`') && expr.endsWith('`')) {
    const tpl = expr.slice(1, -1);
    let out = '';
    for (let pos = 0; pos < tpl.length; ) {
      const open = tpl.indexOf('${', pos);
      if (open < 0) return `${out}${tpl.slice(pos)}`;
      out += tpl.slice(pos, open);
      const close = findBalancedClose(tpl, open + 1, '{', '}');
      if (close < 0) return null;
      const inner = tpl.slice(open + 2, close).trim();
      const sub = parseUrlExpression(inner, localConsts, urlPrefixHelpers, namespacePrefixHelpers, depth + 1);
      out += sub !== null ? sub : `\${${inner}}`;
      pos = close + 1;
    }
    return out;
  }
  if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(expr) && Object.hasOwn(localConsts, expr)) return localConsts[expr];
  const callM = expr.match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\.([A-Za-z_$][A-Za-z0-9_$]*))?\s*\(/);
  if (callM && findBalancedClose(expr, callM[0].length - 1, '(', ')') === expr.length - 1) {
    const prefix = callM[2] ? namespacePrefixHelpers[callM[1]]?.[callM[2]] : urlPrefixHelpers[callM[1]];
    if (prefix) {
      const args = splitTopLevelByChar(expr.slice(callM[0].length, -1), ',');
      if (args.length === 0) return prefix;
      const innerVal = parseUrlExpression(args[0], localConsts, urlPrefixHelpers, namespacePrefixHelpers, depth + 1);
      return innerVal !== null ? `${prefix}${innerVal}` : null;
    }
  }
  const parts = splitTopLevelByChar(expr, '+');
  if (parts.length > 1) {
    let assembled = '';
    for (const p of parts) {
      const sub = parseUrlExpression(p, localConsts, urlPrefixHelpers, namespacePrefixHelpers, depth + 1);
      if (sub !== null) assembled += sub;
      else if (assembled.includes('?')) break;
      else if (assembled.endsWith('/')) assembled += ':param';
    }
    return assembled || null;
  }
  const headLit = expr.match(/^(['"`])([^'"`]+)\1/);
  return headLit ? headLit[2] : null;
}

/** @param {string} text @param {number} idx @returns {number} */
function skipDeclTypeArgs(text, idx) {
  if (text[idx] !== '<') return idx;
  for (let i = idx, d = 0, limit = Math.min(text.length, idx + 400); i < limit; i += 1) {
    if (text[i] === '=' && text[i + 1] === '>') i += 1;
    else if (text[i] === '<') d += 1;
    else if (text[i] === '>' && --d === 0) return i + 1;
  }
  return -1;
}

/** @param {string} s @param {number} pos @returns {number} */
function skipConciseArrowEnd(s, pos) {
  let i = pos;
  while (i < s.length && s[i] !== ';') {
    const ch = s[i];
    if (ch === "'" || ch === '"' || ch === '`') { i += 1; while (i < s.length && s[i] !== ch) { if (s[i] === '\\') i += 1; i += 1; } }
    else if (ch === '(' || ch === '{' || ch === '[') { const cl = findBalancedClose(s, i, ch, ch === '(' ? ')' : ch === '{' ? '}' : ']'); if (cl > i) { i = cl + 1; continue; } }
    else if (ch === '\n' && !/\+\s*$/.test(s.slice(pos, i)) && !/^\s*\+/.test(s.slice(i + 1))) break;
    i += 1;
  }
  return i;
}

/**
 * Extracts enclosing exported function ranges in JS/TS source for API call attribution.
 * @param {string} stripped
 * @returns {Array<{ name: string, start: number, end: number }>}
 */
function findExportedFunctionRanges(stripped) {
  /** @type {Array<{ name: string, start: number, end: number }>} */
  const ranges = [];
  const fnRe = /\b(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?=[<(])/g;
  for (const m of stripped.matchAll(fnRe)) {
    const start = m.index || 0;
    let c = skipDeclTypeArgs(stripped, start + m[0].length);
    while (c >= 0 && c < stripped.length && /\s/.test(stripped[c])) c += 1;
    const closeParen = c >= 0 && stripped[c] === '(' ? findBalancedClose(stripped, c, '(', ')') : -1;
    for (let b = closeParen + 1; closeParen > 0 && b > 0 && b < stripped.length; ) {
      const ch = stripped[b];
      if (ch === '<') b = skipDeclTypeArgs(stripped, b);
      else if (ch === '(' || ch === '[') b = findBalancedClose(stripped, b, ch, ch === '(' ? ')' : ']') + 1;
      else if (ch === '{') {
        const cl = findBalancedClose(stripped, b, '{', '}');
        let after = cl > b ? cl + 1 : -1;
        while (after > 0 && after < stripped.length && /\s/.test(stripped[after])) after += 1;
        const closeBrace = findBalancedClose(stripped, after > 0 && stripped[after] === '{' ? after : b, '{', '}');
        if (closeBrace > start) ranges.push({ name: m[1], start, end: closeBrace });
        break;
      } else b += 1;
    }
  }
  for (const m of stripped.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*[^=;\n{]+)?\s*=\s*(?:async\s+)?(?=[<(A-Za-z_$])/g)) {
    const start = m.index || 0;
    let c = skipDeclTypeArgs(stripped, start + m[0].length);
    while (c >= 0 && c < stripped.length && /\s/.test(stripped[c])) c += 1;
    if (c < 0) continue;
    if (stripped[c] === '(') c = findBalancedClose(stripped, c, '(', ')') + 1;
    else if (/[A-Za-z_$]/.test(stripped[c])) while (c < stripped.length && /[A-Za-z0-9_$]/.test(stripped[c])) c += 1;
    else continue;
    while (c > 0 && c < stripped.length && !(stripped[c] === '=' && stripped[c + 1] === '>')) {
      if (stripped[c] === ';') { c = -1; break; }
      if (stripped[c] === '<') c = skipDeclTypeArgs(stripped, c);
      else if (stripped[c] === '(' || stripped[c] === '{' || stripped[c] === '[') c = findBalancedClose(stripped, c, stripped[c], stripped[c] === '(' ? ')' : stripped[c] === '{' ? '}' : ']') + 1;
      else c += 1;
    }
    if (c <= 0 || c + 2 >= stripped.length) continue;
    c += 2;
    while (c < stripped.length && /\s/.test(stripped[c])) c += 1;
    const end = stripped[c] === '{' ? findBalancedClose(stripped, c, '{', '}') : skipConciseArrowEnd(stripped, c);
    if (end > start) ranges.push({ name: m[1], start, end });
  }
  return ranges;
}

/**
 * Extracts axios wrapper prefixes (`baseURL` incl. local consts / prefix concatenation) from request/config files.
 * @param {string} relFile @param {string} text @returns {string[]}
 */
export function extractAxiosPrefixes(relFile, text) {
  if (!API_WRAPPER_FILE_RE.test(relFile)) return [];
  const stripped = stripJsComments(text), localConsts = extractLocalJsStringConsts(stripped);
  /** @type {Set<string>} */
  const prefixes = new Set();
  for (const m of stripped.matchAll(/\bbaseURL\s*:\s*([^\n,;}{]{1,200})/g)) {
    for (const sm of m[1].matchAll(/['"`](\/[A-Za-z0-9_/-]+)['"`]/g)) prefixes.add(normalizeRoutePath(sm[1]));
    for (const part of m[1].split('+').map((p) => p.trim())) {
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part) && Object.hasOwn(localConsts, part) && localConsts[part].startsWith('/')) prefixes.add(normalizeRoutePath(localConsts[part]));
    }
  }
  for (const m of stripped.matchAll(/\burl\s*:\s*['"`](\/(?:admin-api|platform-api|app-api|api)[A-Za-z0-9_/-]*)['"`]\s*\+/g)) prefixes.add(normalizeRoutePath(m[1]));
  for (const m of stripped.matchAll(/\bconst\s+[A-Z0-9_]*(?:API_PREFIX|BASE_API|PREFIX)[A-Z0-9_]*\s*=\s*['"`](\/[A-Za-z0-9_/-]+)['"`]/g)) prefixes.add(normalizeRoutePath(m[1]));
  return [...prefixes];
}

/**
 * Filters `extractUrlPrefixHelpers` down to exported ESM/CommonJS bindings (`default` included).
 * @param {string} stripped
 * @param {Record<string, string>} [localConsts]
 * @returns {Record<string, string>}
 */
export function extractExportedUrlPrefixHelpers(stripped, localConsts) {
  const all = extractUrlPrefixHelpers(stripped, localConsts);
  /** @type {Record<string, string>} */
  const out = all.default ? { default: all.default } : {};
  for (const m of stripped.matchAll(/\bexport\s+(?:(?:const|let|var|function)\s+([A-Za-z_$][A-Za-z0-9_$]*)|default\s+([A-Za-z_$][A-Za-z0-9_$]*)\b)|(?:^|[^\w$.])(?:module\.)?exports\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=/g)) {
    const name = m[1] || m[2] || m[3];
    if (name && all[name]) out[m[2] ? 'default' : name] = all[name];
  }
  for (const m of stripped.matchAll(/(?:\bexport\s*\{([^}]+)\}(?!\s*from\b)|\bmodule\.exports\s*=\s*\{([^}]+)\})/g)) {
    const isCjs = Boolean(m[2]);
    for (const item of (m[1] || m[2]).split(',')) {
      const kv = item.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*(?:as|:)\s*([A-Za-z_$][A-Za-z0-9_$]*))?$/);
      const src = kv ? (isCjs ? kv[2] || kv[1] : kv[1]) : '';
      if (kv && all[src]) out[isCjs ? kv[1] : kv[2] || kv[1]] = all[src];
    }
  }
  return out;
}

/**
 * Resolves cross-file URL prefix helpers and re-extracts API calls for files importing them (walk-order independent).
 * @param {{
 *   frontendApiCalls: Array<{ method: string, path: string, rawPath?: string, file: string, fnName?: string, clientFile?: string }>,
 *   feImportCandidates: Array<{ filePath: string, bareRel: string, relFile: string, ext: string, imports: string[] }>,
 *   urlPrefixHelpersByFile: Record<string, Record<string, string>>,
 *   exportedConstsByFile: Record<string, Record<string, string>>,
 *   repoDir: string,
 *   fileIndex?: { relSet?: Set<string>, hasSrcDir?: boolean, truncated?: boolean },
 *   repoPrefix: string,
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 * }} params
 */
export function resolveCrossFilePrefixHelperCalls({
  frontendApiCalls, feImportCandidates, urlPrefixHelpersByFile, exportedConstsByFile, repoDir, fileIndex, repoPrefix, resolveImportCandidate,
}) {
  if (Object.keys(exportedConstsByFile).length > 0) {
    for (const cand of feImportCandidates) {
      if (cand.ext === '.vue' || cand.ext === '.svelte' || cand.ext === '.astro') continue;
      /** @type {Record<string, string>} */
      const importedConsts = {};
      for (const imp of cand.imports) if (exportedConstsByFile[imp]) Object.assign(importedConsts, exportedConstsByFile[imp]);
      if (Object.keys(importedConsts).length === 0) continue;
      const strippedH = stripJsComments(fs.readFileSync(cand.filePath, 'utf8'));
      const expHelpers = extractExportedUrlPrefixHelpers(strippedH, extractLocalJsStringConsts(strippedH, importedConsts));
      if (Object.keys(expHelpers).length > 0) urlPrefixHelpersByFile[cand.bareRel] = { ...(urlPrefixHelpersByFile[cand.bareRel] || {}), ...expHelpers };
    }
  }
  if (Object.keys(urlPrefixHelpersByFile).length === 0) return;
  const existingKeys = new Set(frontendApiCalls.map((c) => `${c.file}|${c.method}|${c.path}|${c.fnName || ''}|${c.clientFile || ''}`));
  for (const cand of feImportCandidates) {
    if (cand.ext !== '.cjs' && !cand.imports.some((imp) => imp in urlPrefixHelpersByFile)) continue;
    const resolvedFe = extractFrontendImportsAndApis({
      filePath: cand.filePath, relFile: cand.bareRel, ext: cand.ext, text: fs.readFileSync(cand.filePath, 'utf8'),
      repoDir, fileIndex, resolveImportCandidate, externalPrefixHelpers: urlPrefixHelpersByFile,
    });
    for (const c of resolvedFe.apiCalls) {
      const mappedClient = c.clientFile ? (repoPrefix ? `${repoPrefix}/${c.clientFile}` : c.clientFile) : undefined;
      const key = `${cand.relFile}|${c.method}|${c.path}|${c.fnName || ''}|${mappedClient || ''}`;
      if (!existingKeys.has(key)) { existingKeys.add(key); frontendApiCalls.push({ ...c, file: cand.relFile, ...(mappedClient ? { clientFile: mappedClient } : {}) }); }
    }
  }
}

/** @param {string | null} rawUrl @param {string} relFile @returns {boolean} */
function isAcceptableApiPath(rawUrl, relFile) {
  if (!rawUrl) return false;
  if (rawUrl.startsWith('/') || /^https?:\/\//i.test(rawUrl)) return true;
  if (/(?:^|\/)api\//i.test(relFile)) return !/\s/.test(rawUrl) && !rawUrl.startsWith('.');
  return /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_${}.:-]+)+$/.test(rawUrl);
}

/** @param {string} stripped @param {string[]} specs @param {Map<string, string>} identifierToSpec @param {Map<string, { spec: string, importedName: string }>} importBindings @param {Record<string, string[]>} namedImportsBySpec */
function parseCommonJsRequires(stripped, specs, identifierToSpec, importBindings, namedImportsBySpec) {
  for (const m of stripped.matchAll(/\b(?:const|let|var)\s+(?:\{([^}]+)\}|([A-Za-z_$][A-Za-z0-9_$]*))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) {
    const spec = m[3].trim();
    if (!specs.includes(spec)) specs.push(spec);
    if (m[2]) { identifierToSpec.set(m[2], spec); importBindings.set(m[2], { spec, importedName: 'default' }); continue; }
    for (const item of (m[1] || '').split(',')) {
      const kv = item.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*([A-Za-z_$][A-Za-z0-9_$]*))?$/);
      if (!kv) continue;
      identifierToSpec.set(kv[2] || kv[1], spec);
      importBindings.set(kv[2] || kv[1], { spec, importedName: kv[1] });
      const arr = namedImportsBySpec[spec] || (namedImportsBySpec[spec] = []);
      if (!arr.includes(kv[1])) arr.push(kv[1]);
    }
  }
}

/**
 * Extracts frontend static imports, named symbol imports, API calls (supporting TypeScript generics,
 * 2-arg `(method, url)` wrappers, local/imported URL prefix helpers, aliased clients, and exported fn names),
 * and axios prefixes.
 * @param {{
 *   filePath: string, relFile: string, ext: string, text: string, repoDir: string,
 *   fileIndex?: { relSet?: Set<string>, hasSrcDir?: boolean, truncated?: boolean },
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 *   externalPrefixHelpers?: Record<string, Record<string, string>>,
 * }} ctx
 */
export function extractFrontendImportsAndApis({ filePath, relFile, ext, text, repoDir, fileIndex, resolveImportCandidate, externalPrefixHelpers }) {
  /** @type {Array<{ method: string, path: string, rawPath?: string, file: string, fnName?: string, clientFile?: string }>} */
  const apiCalls = [];
  /** @type {Record<string, string[]>} */
  const namedImports = {};
  if (!FRONTEND_API_EXTS.has(ext)) return { apiCalls, imports: /** @type {string[]} */ ([]), axiosPrefixes: /** @type {string[]} */ ([]), namedImports };
  const scriptText = ext === '.vue' ? ([...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n') || text) : text;
  const stripped = stripJsComments(scriptText), localConsts = extractLocalJsStringConsts(stripped);
  const { specs, identifierToSpec, namedImportsBySpec, importBindings } = parseStaticImports(stripped);
  if (/\brequire\s*\(/.test(stripped)) parseCommonJsRequires(stripped, specs, identifierToSpec, importBindings, namedImportsBySpec);

  /** @type {string[]} */
  const imports = [];
  /** @type {Map<string, string>} */
  const specToResolved = new Map();
  for (const spec of specs) {
    if (!spec.startsWith('./') && !spec.startsWith('../') && !spec.startsWith('@/')) continue;
    const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
    if (!chk.exists || !chk.resolvedRel) continue;
    specToResolved.set(spec, chk.resolvedRel);
    if (!imports.includes(chk.resolvedRel)) imports.push(chk.resolvedRel);
    const syms = namedImportsBySpec[spec];
    if (syms?.length) namedImports[chk.resolvedRel] = [...new Set([...(namedImports[chk.resolvedRel] || []), ...syms])];
  }
  /** @type {Map<string, string>} */
  const identifierToFile = new Map();
  for (const [ident, spec] of identifierToSpec.entries()) { const resolved = specToResolved.get(spec); if (resolved) identifierToFile.set(ident, resolved); }

  /** @type {Record<string, string>} */
  const urlPrefixHelpers = { ...extractUrlPrefixHelpers(stripped, localConsts) };
  /** @type {Record<string, Record<string, string>>} */
  const namespacePrefixHelpers = {};
  if (externalPrefixHelpers) {
    for (const [localIdent, binding] of importBindings.entries()) {
      const resolvedFile = specToResolved.get(binding.spec), extMap = resolvedFile ? externalPrefixHelpers[resolvedFile] : null;
      if (!extMap) continue;
      if (binding.importedName === '*') namespacePrefixHelpers[localIdent] = extMap;
      else if (Object.hasOwn(extMap, binding.importedName)) urlPrefixHelpers[localIdent] = extMap[binding.importedName];
      else if (binding.importedName === 'default' && Object.keys(extMap).length === 1) urlPrefixHelpers[localIdent] = Object.values(extMap)[0];
    }
  }

  const fnRanges = findExportedFunctionRanges(stripped), seenOffsets = new Set();
  const pushCall = (/** @type {string} */ method, /** @type {string | null} */ apiPath, /** @type {number} */ pos, /** @type {string | undefined} */ clientFile) => {
    if (!apiPath || seenOffsets.has(pos)) return;
    seenOffsets.add(pos);
    const fnName = fnRanges.find((r) => pos >= r.start && pos <= r.end)?.name;
    apiCalls.push({ method, path: apiPath, rawPath: apiPath, file: relFile, ...(fnName ? { fnName } : {}), ...(clientFile ? { clientFile } : {}) });
  };
  for (const m of stripped.matchAll(/\bfetch\s*\(/g)) {
    const pos = m.index || 0, openIdx = pos + m[0].length - 1, closeIdx = findBalancedClose(stripped, openIdx, '(', ')');
    if (closeIdx <= openIdx) continue;
    const args = splitTopLevelByChar(stripped.slice(openIdx + 1, closeIdx), ',');
    const rawUrl = args.length > 0 ? parseUrlExpression(args[0], localConsts, urlPrefixHelpers, namespacePrefixHelpers) : null;
    if (rawUrl && (rawUrl.startsWith('/') || /^https?:\/\//i.test(rawUrl))) pushCall('FETCH', normalizeTemplateApiPath(rawUrl), pos, undefined);
  }
  const callRe = /(?<![A-Za-z0-9_$])([A-Za-z_$][A-Za-z0-9_$]*)(?:\.(get|post|put|delete|patch|head|options|request))?(?=\s*[<(])/gi;
  for (const m of stripped.matchAll(callRe)) {
    const startIdx = m.index || 0;
    if (seenOffsets.has(startIdx) || /\b(?:function|class|interface|type)\s+$/.test(stripped.slice(Math.max(0, startIdx - 24), startIdx))) continue;
    const callee = m[1], member = m[2] ? m[2].toLowerCase() : '', clientFile = identifierToFile.get(callee);
    if (!member && (Object.hasOwn(urlPrefixHelpers, callee) || Object.hasOwn(namespacePrefixHelpers, callee))) continue;
    if (!DEFAULT_HTTP_CALLEE_RE.test(callee) && !(clientFile && REQUEST_TARGET_FILE_RE.test(clientFile))) continue;
    let cursor = startIdx + m[0].length;
    while (cursor < stripped.length && /\s/.test(stripped[cursor])) cursor += 1;
    if (stripped[cursor] === '<') cursor = skipBalancedAngleBrackets(stripped, cursor);
    if (cursor < 0 || stripped[cursor] !== '(') continue;
    const closeParen = findBalancedClose(stripped, cursor, '(', ')');
    const args = closeParen > cursor ? splitTopLevelByChar(stripped.slice(cursor + 1, closeParen), ',') : [];
    if (args.length === 0) continue;
    const arg0 = args[0];
    if (arg0.startsWith('{')) {
      const braceEnd = findBalancedClose(arg0, 0, '{', '}');
      if (braceEnd <= 0) continue;
      const objProps = extractTopLevelObjectProps(arg0.slice(1, braceEnd));
      const rawUrl = objProps.url ? parseUrlExpression(objProps.url, localConsts, urlPrefixHelpers, namespacePrefixHelpers) : null;
      if (!isAcceptableApiPath(rawUrl, relFile)) continue;
      let method = member && member !== 'request' ? member.toUpperCase() : 'REQUEST';
      if (!member || member === 'request') {
        const ml = objProps.method?.match(HTTP_METHOD_LITERAL_RE);
        const cm = !ml && objProps.method && Object.hasOwn(localConsts, objProps.method) ? localConsts[objProps.method].match(/^(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)$/i) : null;
        method = ml ? ml[2].toUpperCase() : cm ? cm[1].toUpperCase() : 'REQUEST';
      }
      pushCall(method, normalizeTemplateApiPath(/** @type {string} */ (rawUrl)), startIdx, clientFile);
    } else if (member && member !== 'request') {
      const rawUrl = parseUrlExpression(arg0, localConsts, urlPrefixHelpers, namespacePrefixHelpers);
      if (isAcceptableApiPath(rawUrl, relFile)) pushCall(member.toUpperCase(), normalizeTemplateApiPath(/** @type {string} */ (rawUrl)), startIdx, clientFile);
    } else if (args.length >= 2) {
      const methodLit = arg0.match(HTTP_METHOD_LITERAL_RE);
      const rawUrl = methodLit ? parseUrlExpression(args[1], localConsts, urlPrefixHelpers, namespacePrefixHelpers) : null;
      if (methodLit && isAcceptableApiPath(rawUrl, relFile)) pushCall(methodLit[2].toUpperCase(), normalizeTemplateApiPath(/** @type {string} */ (rawUrl)), startIdx, clientFile);
    }
  }
  return { apiCalls, imports, axiosPrefixes: extractAxiosPrefixes(relFile, text), namedImports };
}
