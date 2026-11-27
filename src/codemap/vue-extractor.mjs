// @ts-check
import path from 'node:path';
import { normalizeRoutePath } from './route-matcher.mjs';

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete', 'yield', 'await', 'new', 'else', 'do',
]);
const REGEX_PRECEDING_PUNCT = new Set(['(', '[', '{', ',', ';', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);
const LAYOUT_COMPONENT_RE = /(?:^|\/)(?:layout|parentview|innerlink)(?:\/index)?(?:\.(?:vue|[jt]sx?))?$/i;
const ROUTER_FILE_RE = /(?:^|\/)(?:[a-z0-9_-]*-)?(?:router|routes)(?:\/|\.|-[a-z])/i;
const EXPLICIT_ROUTES_START_RE =
  /(?:export\s+default\s*|(?:\b(?:constantRoutes|asyncRoutes|dynamicRoutes|staticRoutes|publicRoutes|routes|[A-Za-z_$][A-Za-z0-9_$]*Routes)\s*(?::\s*[^=\n;{]+)?=\s*)|\broutes\s*:\s*)\[/g;
const ROUTER_ANY_ARRAY_START_RE = /(?:export\s+default\s*|(?:\b[A-Za-z_$][A-Za-z0-9_$]*\s*(?::\s*[^=\n;{]+)?=\s*)|\broutes\s*:\s*)\[/g;

/**
 * Linear O(N) JS/TS comment stripper preserving string, template, and regex literals.
 * @param {string} source
 * @returns {string}
 */
export function stripJsComments(source) {
  const s = String(source || '');
  const len = s.length;
  /** @type {string[]} */
  const out = [];
  let i = 0;
  let lastNonWs = '';
  let lastWord = '';

  const canStartRegex = () => !lastNonWs || REGEX_PRECEDING_PUNCT.has(lastNonWs) || REGEX_PRECEDING_KEYWORDS.has(lastWord);

  while (i < len) {
    const ch = s[i];
    const next = i + 1 < len ? s[i + 1] : '';
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      const q = ch;
      i += 1;
      while (i < len) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === q) { i += 1; break; }
        if (q !== '`' && (c === '\n' || c === '\r')) break;
        i += 1;
      }
      out.push(s.slice(start, i));
      lastNonWs = q;
      lastWord = '';
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && s[i] !== '\n' && s[i] !== '\r') i += 1;
      out.push(' ');
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len) {
        if (s[i] === '*' && i + 1 < len && s[i + 1] === '/') { i += 2; break; }
        i += 1;
      }
      out.push(' ');
      continue;
    }
    if (ch === '/' && canStartRegex()) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < len) {
        const c = s[j];
        if (c === '\n' || c === '\r') break;
        if (c === '\\') { j += 2; continue; }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) {
          j += 1;
          while (j < len && /[a-z]/i.test(s[j])) j += 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (closed) {
        out.push(s.slice(start, j));
        i = j;
        lastNonWs = '/';
        lastWord = '';
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      const start = i;
      i += 1;
      while (i < len && /[A-Za-z0-9_$]/.test(s[i])) i += 1;
      const word = s.slice(start, i);
      out.push(word);
      lastWord = word;
      lastNonWs = word[word.length - 1];
      continue;
    }
    out.push(ch);
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      lastNonWs = ch;
      lastWord = '';
    }
    i += 1;
  }
  return out.join('');
}

/**
 * Finds matching closing delimiter (`}` or `]` or `)`) in comment-stripped JS/TS code.
 * @param {string} text
 * @param {number} openIdx
 * @param {string} openCh
 * @param {string} closeCh
 * @returns {number}
 */
export function findBalancedClose(text, openIdx, openCh, closeCh) {
  let depth = 0;
  const len = text.length;
  for (let i = openIdx; i < len; i += 1) {
    const ch = text[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const q = ch;
      i += 1;
      while (i < len) {
        if (text[i] === '\\') { i += 1; }
        else if (text[i] === q) break;
        i += 1;
      }
      continue;
    }
    if (ch === openCh) depth += 1;
    else if (ch === closeCh) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Normalizes Vue Router regex params (`:dictId(\d+)` -> `:dictId`, `:path(.*)` -> `:path*`).
 * @param {string} rawPath
 * @returns {string}
 */
export function normalizeVueRouterPath(rawPath) {
  let s = String(rawPath || '').trim().split('?')[0].split('#')[0];
  s = s.replace(/:([A-Za-z0-9_]+)\(([^)]*)\)(\*?)/g, (_m, name, inner, star) =>
    star || inner.includes('.*') ? `:${name}*` : `:${name}`
  );
  if (s === '*' || s === '/*') return '/:rest*';
  if (s.endsWith('/(.*)') || s.endsWith('/*')) {
    s = s.replace(/\/(?:\(\.\*\)|\*)$/, '/:rest*');
  }
  return s;
}

/**
 * Joins parent route path and child route path cleanly.
 * @param {string} parentPath
 * @param {string} childPath
 * @returns {string}
 */
function joinRoutePath(parentPath, childPath) {
  const normChild = normalizeVueRouterPath(childPath);
  if (normChild.startsWith('/')) return normalizeRoutePath(normChild);
  const cleanParent = parentPath ? normalizeRoutePath(parentPath) : '';
  if (!normChild) return cleanParent || '/';
  return normalizeRoutePath(`${cleanParent === '/' ? '' : cleanParent}/${normChild}`);
}

/**
 * Extracts depth-1 property expressions from a `{ ... }` route object body.
 * @param {string} objBody
 * @returns {Record<string, string>}
 */
function extractTopLevelObjectProps(objBody) {
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
      if (objBody[i] === '(') {
        const closeParen = findBalancedClose(objBody, i, '(', ')');
        i = closeParen >= 0 ? closeParen + 1 : len;
        while (i < len && /\s/.test(objBody[i])) i += 1;
        if (objBody[i] === '{') {
          const closeBrace = findBalancedClose(objBody, i, '{', '}');
          i = closeBrace >= 0 ? closeBrace + 1 : len;
        }
      }
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
          if (objBody[i] === '\\') { i += 1; }
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

/** @param {string} expr @returns {string | null} */
function unwrapStringLiteral(expr) {
  const m = String(expr || '').trim().match(/^(['"`])([^'"`]*)\1$/);
  if (!m) return null;
  if (m[1] === '`' && m[2].includes('${')) return null;
  return m[2];
}

/**
 * Parses static import statements into module specifiers, local identifier -> spec map,
 * and per-spec exported symbol names (`namedImportsBySpec`).
 * @param {string} stripped
 */
export function parseStaticImports(stripped) {
  /** @type {string[]} */
  const specs = [];
  /** @type {Map<string, string>} */
  const identifierToSpec = new Map();
  /** @type {Record<string, string[]>} */
  const namedImportsBySpec = {};
  const addNamed = (/** @type {string} */ spec, /** @type {string} */ name) => {
    const arr = namedImportsBySpec[spec] || (namedImportsBySpec[spec] = []);
    if (!arr.includes(name)) arr.push(name);
  };
  const parseNamedClause = (/** @type {string} */ inner, /** @type {string} */ spec) => {
    for (const item of inner.split(',')) {
      const m = item.trim().match(/^([A-Za-z_$][A-Za-z0-9_$]*)(?:\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))?$/);
      if (!m) continue;
      identifierToSpec.set(m[2] || m[1], spec);
      addNamed(spec, m[1]);
    }
  };

  for (const m of stripped.matchAll(/\bimport\s+([\s\S]{1,400}?)\s+from\s*['"]([^'"]+)['"]/g)) {
    const clause = m[1].trim();
    const spec = m[2].trim();
    specs.push(spec);
    if (clause.startsWith('*')) {
      const ns = clause.match(/\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (ns) { identifierToSpec.set(ns[1], spec); addNamed(spec, '*'); }
    } else if (clause.startsWith('{')) {
      parseNamedClause(clause.slice(1, clause.lastIndexOf('}')), spec);
    } else {
      const commaIdx = clause.indexOf(',');
      const defName = (commaIdx >= 0 ? clause.slice(0, commaIdx) : clause).trim();
      if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(defName)) {
        identifierToSpec.set(defName, spec);
        addNamed(spec, 'default');
      }
      if (commaIdx >= 0) {
        const rest = clause.slice(commaIdx + 1).trim();
        if (rest.startsWith('{')) parseNamedClause(rest.slice(1, rest.lastIndexOf('}')), spec);
      }
    }
  }
  for (const m of stripped.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1].trim());
  for (const m of stripped.matchAll(/\bexport\s+(?:\*|\{[^}]{0,300}\})\s+from\s*['"]([^'"]+)['"]/g)) specs.push(m[1].trim());
  for (const m of stripped.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specs.push(m[1].trim());

  return { specs: [...new Set(specs)], identifierToSpec, namedImportsBySpec };
}

/**
 * Extracts nested and parameterized Vue Router / declarative JS/TS route arrays.
 * @param {{
 *   filePath: string,
 *   relFile: string,
 *   text: string,
 *   repoDir: string,
 *   fileIndex?: { relSet?: Set<string>, hasSrcDir?: boolean, truncated?: boolean },
 *   resolveImportCandidate: (baseFile: string, importSpec: string, repoDir: string, fileIndex?: any) => { resolvedRel: string | null, exists: boolean },
 * }} ctx
 */
export function extractVueRouterRoutes({ filePath, relFile, text, repoDir, fileIndex, resolveImportCandidate }) {
  /** @type {Array<{ route: string, file: string, kind: string }>} */
  const routes = [];
  /** @type {Array<{ route: string, routerFile: string, importSpec: string, expectedFile: string | null }>} */
  const brokenImports = [];
  if (!/\.(?:ts|tsx|js|jsx|mjs)$/.test(relFile)) return { routes, brokenImports };

  const isRouterFile = ROUTER_FILE_RE.test(relFile);
  const stripped = stripJsComments(text);
  const { identifierToSpec } = parseStaticImports(stripped);
  const startRe = isRouterFile ? ROUTER_ANY_ARRAY_START_RE : EXPLICIT_ROUTES_START_RE;
  startRe.lastIndex = 0;

  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Array<[number, number]>} */
  const scannedRanges = [];

  /**
   * @param {string} arrayText
   * @param {string} parentPath
   */
  const walkRouteArray = (arrayText, parentPath) => {
    let i = 1;
    const len = arrayText.length - 1;
    while (i < len) {
      while (i < len && arrayText[i] !== '{') {
        if (arrayText[i] === "'" || arrayText[i] === '"' || arrayText[i] === '`') {
          const q = arrayText[i];
          i += 1;
          while (i < len && arrayText[i] !== q) {
            if (arrayText[i] === '\\') i += 1;
            i += 1;
          }
        } else if (arrayText[i] === '[' || arrayText[i] === '(') {
          const close = findBalancedClose(arrayText, i, arrayText[i], arrayText[i] === '[' ? ']' : ')');
          if (close > i) { i = close + 1; continue; }
        }
        i += 1;
      }
      if (i >= len) break;
      const objEnd = findBalancedClose(arrayText, i, '{', '}');
      if (objEnd < 0) break;
      const props = extractTopLevelObjectProps(arrayText.slice(i + 1, objEnd));
      i = objEnd + 1;

      const rawPath = props.path !== undefined ? unwrapStringLiteral(props.path) : null;
      if (rawPath !== null && /^https?:\/\//i.test(rawPath)) continue;

      const hasChildren = typeof props.children === 'string' && props.children.startsWith('[');
      const currentPath = rawPath !== null ? joinRoutePath(parentPath, rawPath) : parentPath;

      let importSpec = null;
      let targetFile = relFile;
      let isLayout = false;
      if (props.component) {
        const lazyMatch =
          props.component.match(/\bimport\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/) ||
          props.component.match(/\brequire\s*\(\s*\[\s*['"`]([^'"`]+)['"`]/);
        if (lazyMatch) {
          importSpec = lazyMatch[1];
        } else if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(props.component)) {
          if (LAYOUT_COMPONENT_RE.test(props.component)) isLayout = true;
          importSpec = identifierToSpec.get(props.component) || null;
        }
        if (importSpec) {
          const chk = resolveImportCandidate(filePath, importSpec, repoDir, fileIndex);
          if (chk.resolvedRel) {
            targetFile = chk.resolvedRel;
            if (LAYOUT_COMPONENT_RE.test(chk.resolvedRel)) isLayout = true;
          }
          if (!chk.exists && rawPath !== null && !isLayout) {
            brokenImports.push({
              route: currentPath,
              routerFile: relFile,
              importSpec,
              expectedFile: chk.resolvedRel,
            });
          }
        }
      }

      const shouldEmitSelf = rawPath !== null && (!hasChildren || (!isLayout && (Boolean(importSpec) || Boolean(props.component))));
      if (shouldEmitSelf && (!hasChildren || !isLayout)) {
        const key = `${currentPath}::${targetFile}`;
        if (!seen.has(key)) {
          seen.add(key);
          routes.push({ route: currentPath, file: targetFile, kind: 'router-config' });
        }
      } else if (isLayout && hasChildren && rawPath !== null && currentPath !== '/' && targetFile !== relFile) {
        const key = `layout::${currentPath}::${targetFile}`;
        if (!seen.has(key)) {
          seen.add(key);
          routes.push({ route: currentPath, file: targetFile, kind: 'router-layout' });
        }
      }

      if (hasChildren) {
        walkRouteArray(props.children, rawPath !== null ? currentPath : parentPath);
      }
    }
  };

  for (const m of stripped.matchAll(startRe)) {
    const arrStart = (m.index || 0) + m[0].length - 1;
    if (scannedRanges.some(([s, e]) => arrStart >= s && arrStart <= e)) continue;
    const arrEnd = findBalancedClose(stripped, arrStart, '[', ']');
    if (arrEnd <= arrStart) continue;
    scannedRanges.push([arrStart, arrEnd]);
    walkRouteArray(stripped.slice(arrStart, arrEnd + 1), '');
  }

  return { routes, brokenImports };
}

