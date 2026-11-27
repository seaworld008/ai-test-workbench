// @ts-check
import { normalizeRoutePath } from './route-matcher.mjs';

/**
 * @typedef {{ method: string, path: string, file: string, framework: string }} PythonEndpoint
 * @typedef {{ table: string, file: string, source: string }} PythonDbEntity
 */

/**
 * Scans forward from `start` over a Python single/double/triple-quoted string literal.
 * @param {string} s
 * @param {number} start
 * @param {boolean} isTriple
 * @returns {number}
 */
function scanPythonStringEnd(s, start, isTriple) {
  const q = s[start];
  let i = start + (isTriple ? 3 : 1);
  while (i < s.length) {
    if (s[i] === '\\') {
      i += i + 1 < s.length && s[i + 1] === '\r' && s[i + 2] === '\n' ? 3 : 2;
      continue;
    }
    if (isTriple) {
      if (s[i] === q && s[i + 1] === q && s[i + 2] === q) return i + 3;
    } else {
      if (s[i] === q) return i + 1;
      if (s[i] === '\n' || s[i] === '\r') return i;
    }
    i += 1;
  }
  return s.length;
}

/**
 * Strips Python `#` end-of-line comments in O(N) outside string literals (`'...'`, `"..."`, `'''...'''`, `"""..."""`),
 * preserving all string literals (including multi-line SQL DDL strings) and newline structure.
 * @param {string} source
 * @returns {string}
 */
export function stripPythonComments(source) {
  const s = String(source || '');
  const len = s.length;
  /** @type {string[]} */
  const out = [];
  let chunkStart = 0;
  for (let i = 0; i < len; ) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const isTriple = s[i + 1] === ch && s[i + 2] === ch;
      i = scanPythonStringEnd(s, i, isTriple);
    } else if (ch === '#') {
      if (i > chunkStart) out.push(s.slice(chunkStart, i));
      i += 1;
      while (i < len && s[i] !== '\n' && s[i] !== '\r') i += 1;
      chunkStart = i;
    } else {
      i += 1;
    }
  }
  if (chunkStart < len) out.push(s.slice(chunkStart));
  return out.join('');
}

/**
 * Masks the interior of Python triple-quoted strings (`'''...'''` / `"""..."""`) with spaces while keeping newlines
 * and preserving single-line `'...'` / `"..."` literals, so docstrings cannot trigger route matches.
 * @param {string} source
 * @returns {string}
 */
export function maskPythonTripleQuotedStrings(source) {
  const s = String(source || '');
  const len = s.length;
  /** @type {string[]} */
  const out = [];
  let chunkStart = 0;
  for (let i = 0; i < len; ) {
    const ch = s[i];
    if (ch === '"' || ch === "'") {
      const isTriple = s[i + 1] === ch && s[i + 2] === ch;
      const end = scanPythonStringEnd(s, i, isTriple);
      if (isTriple) {
        if (i > chunkStart) out.push(s.slice(chunkStart, i));
        const quote3 = ch.repeat(3);
        const hasClose = end - i >= 6 && s.slice(end - 3, end) === quote3;
        const inner = s.slice(i + 3, hasClose ? end - 3 : end);
        out.push(quote3, inner.replace(/[^\r\n]/g, ' '), hasClose ? quote3 : '');
        chunkStart = end;
      }
      i = end;
    } else if (ch === '#') {
      while (i < len && s[i] !== '\n' && s[i] !== '\r') i += 1;
    } else {
      i += 1;
    }
  }
  if (chunkStart < len) out.push(s.slice(chunkStart));
  return out.join('');
}

/**
 * Reads a balanced `(...)` argument block starting at `openParenIdx`, skipping Python string literals.
 * @param {string} text
 * @param {number} openParenIdx
 * @returns {{ body: string, endIdx: number } | null}
 */
function readPythonBalancedParens(text, openParenIdx) {
  if (text[openParenIdx] !== '(') return null;
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const isTriple = text[i + 1] === ch && text[i + 2] === ch;
      i = scanPythonStringEnd(text, i, isTriple) - 1;
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return { body: text.slice(openParenIdx + 1, i), endIdx: i };
  }
  return null;
}

/**
 * Joins a router/mount prefix with a relative sub-route cleanly.
 * @param {string} prefix
 * @param {string} subPath
 * @returns {string}
 */
function joinRoutePaths(prefix, subPath) {
  if (!prefix) return subPath;
  const p = prefix.replace(/\/+$/, '');
  const s = subPath.replace(/^\/+/, '');
  return s ? `${p}/${s}` : p || '/';
}

/**
 * Strips URL `?query` and `#fragment` at top-level delimiter depth so `(?P<name>...)` and regex `{...}` stay intact.
 * @param {string} raw
 * @returns {string}
 */
function stripUrlQueryAndFragment(raw) {
  let parenDepth = 0;
  let braceDepth = 0;
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (ch === '(') parenDepth += 1;
    else if (ch === ')' && parenDepth > 0) parenDepth -= 1;
    else if (ch === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;
    else if (parenDepth === 0 && braceDepth === 0 && (ch === '?' || ch === '#')) {
      return raw.slice(0, i);
    }
  }
  return raw;
}

/**
 * Normalizes FastAPI `{param:int}`/`{param}`, Flask/Werkzeug `<int:id>`/`<id>`, and Django `(?P<id>...)` route params.
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizePythonRoutePath(rawPath) {
  let clean = stripUrlQueryAndFragment(String(rawPath || '').trim());
  clean = clean
    .replace(/\(\?P<([a-zA-Z_][a-zA-Z0-9_-]*)>(?:[^()]|\([^()]*\))*\)/g, ':$1')
    .replace(/<[^<>:]+:\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*>/g, ':$1')
    .replace(/<\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*>/g, ':$1')
    .replace(/\{\s*([a-zA-Z_][a-zA-Z0-9_-]*)\s*(?::(?:[^{}]|\{[^{}]*\})+)?\}/g, ':$1');
  return normalizeRoutePath(clean);
}

/**
 * Parses `methods=['GET', 'POST']` (or tuple/set) from a route/decorator argument body.
 * @param {string} argsBody
 * @param {string} [fallback]
 * @returns {string[]}
 */
function extractMethodsArg(argsBody, fallback = 'ANY') {
  const mm = argsBody.match(/\bmethods\s*=\s*(?:\[([^\]]*)\]|\(([^)]*)\)|\{([^}]*)\})/);
  if (!mm) return [fallback];
  const inner = mm[1] ?? mm[2] ?? mm[3] ?? '';
  /** @type {string[]} */
  const methods = [];
  for (const lit of inner.matchAll(/['"]([A-Za-z]+)['"]/g)) {
    const upper = lit[1].toUpperCase();
    if (!methods.includes(upper)) methods.push(upper);
  }
  return methods.length > 0 ? methods : [fallback];
}

/**
 * Recursively extracts Starlette `Mount('/prefix', routes=[...])`, `Route(...)`, and `WebSocketRoute(...)`.
 * @param {string} sliceText
 * @param {string} prefix
 * @param {(method: string, rawPath: string, framework: string) => void} addEndpoint
 */
function extractStarletteScope(sliceText, prefix, addEndpoint) {
  const re = /\b(Mount|Route|WebSocketRoute)\s*\(/g;
  let m;
  while ((m = re.exec(sliceText)) !== null) {
    const kind = m[1];
    const before = sliceText.slice(Math.max(0, m.index - 8), m.index);
    if (/\b(?:def|class)\s+$/.test(before)) continue;
    const openParenIdx = m.index + m[0].length - 1;
    const bal = readPythonBalancedParens(sliceText, openParenIdx);
    if (!bal) continue;
    const pathM = bal.body.match(/^\s*(?:path\s*=\s*)?r?(?:'([^']*)'|"([^"]*)")/);
    if (kind === 'Mount') {
      if (pathM) {
        const subPrefix = joinRoutePaths(prefix, pathM[1] ?? pathM[2] ?? '');
        extractStarletteScope(bal.body, subPrefix, addEndpoint);
      }
    } else if (pathM) {
      const fullRaw = joinRoutePaths(prefix, pathM[1] ?? pathM[2] ?? '');
      if (kind === 'WebSocketRoute') {
        addEndpoint('WS', fullRaw, 'python-starlette');
      } else {
        for (const method of extractMethodsArg(bal.body, 'ANY')) {
          addEndpoint(method, fullRaw, 'python-starlette');
        }
      }
    }
    re.lastIndex = bal.endIdx + 1;
  }
}

const SQL_CREATE_TABLE_RE =
  /\bCREATE\s+(?:(?:OR\s+REPLACE|GLOBAL|LOCAL|TEMP(?:ORARY)?|UNLOGGED)\s+)*TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:[`"'\[]?[A-Za-z_][A-Za-z0-9_]*[`"'\]]?\s*\.\s*)?[`"'\[]?([A-Za-z_][A-Za-z0-9_]{1,63})[`"'\]]?(?=\s*(?:\(|AS\b|LIKE\b|PARTITION\b|OF\b|USING\b|COMMENT\b|ENGINE\b))/gi;
const SQL_RESERVED_TABLE_NAMES = new Set([
  'if', 'not', 'exists', 'select', 'as', 'from', 'where', 'table', 'temp', 'temporary', 'index', 'view',
]);

/**
 * Extracts clean, schema-stripped SQL table names from strict `CREATE TABLE` DDL statements.
 * @param {string} text
 * @returns {string[]}
 */
export function extractSqlCreateTableNames(text) {
  /** @type {string[]} */
  const tables = [];
  for (const m of String(text || '').matchAll(SQL_CREATE_TABLE_RE)) {
    const table = m[1];
    if (!table || SQL_RESERVED_TABLE_NAMES.has(table.toLowerCase())) continue;
    tables.push(table);
  }
  return tables;
}

/**
 * Extracts Python HTTP/WebSocket endpoints (FastAPI, Flask, aiohttp, Starlette, Django)
 * and DB entities (SQLAlchemy, Django ORM, inline SQL DDL) from a `.py` file.
 * @param {{ relFile: string, text: string }} params
 * @returns {{ endpoints: PythonEndpoint[], entities: PythonDbEntity[] }}
 */
export function extractPythonEndpointsAndEntities({ relFile, text }) {
  /** @type {PythonEndpoint[]} */
  const endpoints = [];
  /** @type {PythonDbEntity[]} */
  const entities = [];
  if (!text) return { endpoints, entities };

  const stripped = stripPythonComments(text);
  const codeText = maskPythonTripleQuotedStrings(stripped);
  /** @type {Set<string>} */
  const seenEndpoints = new Set();
  /** @type {Set<string>} */
  const seenEntities = new Set();

  /** @param {string} method @param {string} rawPath @param {string} framework */
  const addEndpoint = (method, rawPath, framework) => {
    const normPath = normalizePythonRoutePath(rawPath);
    const normMethod = String(method || 'ANY').toUpperCase();
    const key = `${normMethod}\0${normPath}\0${relFile}`;
    if (seenEndpoints.has(key)) return;
    seenEndpoints.add(key);
    endpoints.push({ method: normMethod, path: normPath, file: relFile, framework });
  };

  /** @param {string} table @param {string} source */
  const addEntity = (table, source) => {
    if (!table) return;
    const key = `${table}\0${relFile}\0${source}`;
    if (seenEntities.has(key)) return;
    seenEntities.add(key);
    entities.push({ table, file: relFile, source });
  };

  /** @type {Map<string, string>} */
  const routerPrefixes = new Map();
  /** @type {Map<string, 'python-fastapi' | 'python-flask' | 'python-aiohttp'>} */
  const routerFrameworks = new Map();
  /** @type {Set<string>} */
  const knownRouterVars = new Set(['app', 'router', 'bp', 'api', 'routes']);

  const routerDeclRe =
    /(?:^|[\n;])[ \t]*([A-Za-z_][A-Za-z0-9_]*)(?:\s*:[^=\n]+)?\s*=\s*(?:[\w.]*\.)?(APIRouter|Blueprint|RouteTableDef|FastAPI|Flask)\s*\(/g;
  for (const m of codeText.matchAll(routerDeclRe)) {
    const varName = m[1];
    const ctor = m[2];
    knownRouterVars.add(varName);
    const openParenIdx = (m.index ?? 0) + m[0].length - 1;
    const bal = readPythonBalancedParens(codeText, openParenIdx);
    const body = bal ? bal.body : '';
    if (ctor === 'APIRouter') {
      routerFrameworks.set(varName, 'python-fastapi');
      const prefM = body.match(/\bprefix\s*=\s*r?(?:'([^']*)'|"([^"]*)")/);
      if (prefM) routerPrefixes.set(varName, prefM[1] ?? prefM[2] ?? '');
    } else if (ctor === 'FastAPI') {
      routerFrameworks.set(varName, 'python-fastapi');
    } else if (ctor === 'Blueprint') {
      routerFrameworks.set(varName, 'python-flask');
      const prefM = body.match(/\burl_prefix\s*=\s*r?(?:'([^']*)'|"([^"]*)")/);
      if (prefM) routerPrefixes.set(varName, prefM[1] ?? prefM[2] ?? '');
    } else if (ctor === 'Flask') {
      routerFrameworks.set(varName, 'python-flask');
    } else if (ctor === 'RouteTableDef') {
      routerFrameworks.set(varName, 'python-aiohttp');
    }
  }

  let hasAiohttpImperative = false;
  for (const m of codeText.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_.]*\.router\.add_(get|post|put|delete|patch|head|options)\s*\(\s*(?:path\s*=\s*)?r?(?:'([^']*)'|"([^"]*)")/g
  )) {
    hasAiohttpImperative = true;
    addEndpoint(m[1].toUpperCase(), m[2] ?? m[3] ?? '', 'python-aiohttp');
  }
  for (const m of codeText.matchAll(
    /\b[A-Za-z_][A-Za-z0-9_.]*\.router\.add_route\s*\(\s*['"]([A-Za-z*]+)['"]\s*,\s*r?(?:'([^']*)'|"([^"]*)")/g
  )) {
    hasAiohttpImperative = true;
    addEndpoint(m[1] === '*' ? 'ANY' : m[1].toUpperCase(), m[2] ?? m[3] ?? '', 'python-aiohttp');
  }
  const hasAiohttpSignal = /\b(?:RouteTableDef|aiohttp|add_routes)\b/.test(codeText) || hasAiohttpImperative;
  for (const m of codeText.matchAll(
    /\bweb\.(get|post|put|delete|patch|head|options|view)\s*\(\s*(?:path\s*=\s*)?r?(?:'([^']*)'|"([^"]*)")/g
  )) {
    const raw = m[2] ?? m[3] ?? '';
    if (m[1] === 'get' && !hasAiohttpSignal && !raw.startsWith('/')) continue;
    hasAiohttpImperative = true;
    addEndpoint(m[1] === 'view' ? 'ANY' : m[1].toUpperCase(), raw, 'python-aiohttp');
  }

  const fileDecoratorFramework = /\b(?:APIRouter|FastAPI|fastapi)\b/.test(codeText)
    ? 'python-fastapi'
    : /\b(?:Blueprint|Flask|flask)\b/.test(codeText)
      ? 'python-flask'
      : /\b(?:RouteTableDef|aiohttp)\b/.test(codeText) || hasAiohttpImperative
        ? 'python-aiohttp'
        : 'python';

  const decRe =
    /(?:^|\n)[ \t]*@([A-Za-z_][A-Za-z0-9_]*)\.(get|post|put|delete|patch|head|options|route|api_route|websocket)\s*\(/g;
  for (const m of codeText.matchAll(decRe)) {
    const varName = m[1];
    if (!knownRouterVars.has(varName) && !/^[A-Za-z0-9_]+_(?:router|bp|api|routes)$/.test(varName)) continue;
    const openParenIdx = (m.index ?? 0) + m[0].length - 1;
    const bal = readPythonBalancedParens(codeText, openParenIdx);
    if (!bal) continue;
    const pathM = bal.body.match(/^\s*(?:(?:path|rule)\s*=\s*)?r?(?:'([^']*)'|"([^"]*)")/);
    if (!pathM) continue;
    const fullRaw = joinRoutePaths(routerPrefixes.get(varName) || '', pathM[1] ?? pathM[2] ?? '');
    const decMethod = m[2].toLowerCase();
    /** @type {string[]} */
    let methods;
    if (decMethod === 'websocket') methods = ['WS'];
    else if (decMethod === 'route' || decMethod === 'api_route') methods = extractMethodsArg(bal.body, 'ANY');
    else methods = [decMethod.toUpperCase()];

    const fw =
      routerFrameworks.get(varName) ||
      (varName === 'routes' && hasAiohttpImperative ? 'python-aiohttp' : fileDecoratorFramework);
    for (const method of methods) addEndpoint(method, fullRaw, fw);
  }

  if (
    /(?:from\s+starlette\b|import\s+starlette\b|\bWebSocketRoute\b|\bMount\s*\(\s*r?['"]\/|\bRoute\s*\(\s*r?['"]\/)/.test(
      codeText
    )
  ) {
    extractStarletteScope(codeText, '', addEndpoint);
  }

  if (/(?:^|\/)urls\.py$/i.test(relFile) || /\b(?:from|import)\s+django\.urls\b/.test(codeText)) {
    const djangoRe = /\b(path|re_path)\s*\(/g;
    let m;
    while ((m = djangoRe.exec(codeText)) !== null) {
      const prefixCtx = codeText.slice(Math.max(0, m.index - 4), m.index);
      if (/\b(?:os|sys)\.$/.test(prefixCtx)) continue;
      const openParenIdx = m.index + m[0].length - 1;
      const bal = readPythonBalancedParens(codeText, openParenIdx);
      if (!bal) continue;
      const strM = bal.body.match(/^\s*(?:route\s*=\s*)?r?(?:'([^']*)'|"([^"]*)")/);
      if (!strM) continue;
      let raw = strM[1] ?? strM[2] ?? '';
      if (m[1] === 're_path') {
        raw = raw.replace(/^\^/, '').replace(/(?:\/\?)?\$$/, '');
      }
      if (/^\/?admin(?:\/|$)/i.test(raw) && !/^\/?api\//i.test(raw)) continue;
      if (!raw.trim() && /\binclude\s*\(/.test(bal.body)) continue;
      addEndpoint('ANY', raw, 'python-django');
    }
  }

  for (const m of codeText.matchAll(/\b__tablename__\s*=\s*r?['"]([a-zA-Z0-9_.]+)['"]/g)) {
    addEntity(m[1], 'sqlalchemy');
  }
  for (const m of codeText.matchAll(/\bdb_table\s*=\s*r?['"]([a-zA-Z0-9_.]+)['"]/g)) {
    addEntity(m[1], 'django-orm');
  }
  for (const table of extractSqlCreateTableNames(stripped)) {
    addEntity(table, 'python-sql');
  }

  return { endpoints, entities };
}
