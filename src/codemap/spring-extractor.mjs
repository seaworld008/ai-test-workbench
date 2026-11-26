// @ts-check
import path from 'node:path';
import { normalizeRoutePath } from './route-matcher.mjs';

const HTTP_METHOD_RE = /\bRequestMethod\.(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\b/i;

/**
 * Strips Java/Kotlin `//` and `/* *\/` comments linearly while preserving string & text-block literals.
 * @param {string} source
 * @returns {string}
 */
export function stripJavaComments(source) {
  const s = String(source || '');
  const len = s.length;
  /** @type {string[]} */
  const out = [];
  let i = 0;
  while (i < len) {
    const ch = s[i];
    const next = i + 1 < len ? s[i + 1] : '';
    if (ch === '"' && next === '"' && s[i + 2] === '"') {
      const start = i;
      i += 3;
      while (i < len) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === '"' && s[i + 1] === '"' && s[i + 2] === '"') { i += 3; break; }
        i += 1;
      }
      out.push(s.slice(start, i));
      continue;
    }
    if (ch === '"' || ch === "'") {
      const start = i;
      const q = ch;
      i += 1;
      while (i < len) {
        if (s[i] === '\\') { i += 2; continue; }
        if (s[i] === q) { i += 1; break; }
        if (s[i] === '\n' || s[i] === '\r') break;
        i += 1;
      }
      out.push(s.slice(start, i));
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
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/**
 * Extracts balanced `(...)` argument text starting at `openParenIdx`.
 * @param {string} text
 * @param {number} openParenIdx
 * @returns {{ body: string, endIdx: number } | null}
 */
function readBalancedParens(text, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      const q = ch;
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 1; }
        else if (text[i] === q) break;
        i += 1;
      }
      continue;
    }
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) return { body: text.slice(openParenIdx + 1, i), endIdx: i };
    }
  }
  return null;
}

/**
 * Parses mapping paths from Spring `@*Mapping(...)` argument body.
 * Supports `"/a"`, `value = "/a"`, `path = {"/a", "/b"}`, and multiline values.
 * @param {string} argsBody
 * @returns {string[]}
 */
function parseSpringMappingPaths(argsBody) {
  const clean = String(argsBody || '').trim();
  if (!clean) return [''];

  const named = clean.match(/\b(?:value|path)\s*=\s*(\{[\s\S]*?\}|["'][^"']*["'])/);
  if (named) {
    const items = [...named[1].matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
    return items.length > 0 ? items : [''];
  }
  if (/^\s*["']/.test(clean) || /^\s*\{/.test(clean)) {
    const head = clean.startsWith('{') ? clean.slice(0, clean.indexOf('}') + 1) : clean.split(',')[0];
    const items = [...head.matchAll(/["']([^"']*)["']/g)].map((m) => m[1]);
    if (items.length > 0) return items;
  }
  return [''];
}

/**
 * Scans `@(Get|Post|Put|Delete|Patch|Request)Mapping` annotations inside a Java/Kotlin snippet.
 * @param {string} snippet
 * @returns {Array<{ kind: string, method: string, paths: string[] }>}
 */
function scanMappingAnnotations(snippet) {
  /** @type {Array<{ kind: string, method: string, paths: string[] }>} */
  const out = [];
  const annRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\b/g;
  for (const m of snippet.matchAll(annRe)) {
    const kind = m[1];
    let idx = (m.index || 0) + m[0].length;
    while (idx < snippet.length && /\s/.test(snippet[idx])) idx += 1;
    let body = '';
    if (snippet[idx] === '(') {
      const balanced = readBalancedParens(snippet, idx);
      if (balanced) body = balanced.body;
    }
    let method = kind === 'Request' ? 'ANY' : kind.toUpperCase();
    if (kind === 'Request') {
      const rm = body.match(HTTP_METHOD_RE);
      if (rm) method = rm[1].toUpperCase();
    }
    out.push({ kind, method, paths: parseSpringMappingPaths(body) });
  }
  return out;
}

/**
 * Extracts Java package, class name, imports, super-types, and injected field types for 4-tier DB correlation.
 * @param {string} relFile
 * @param {string} stripped
 */
export function extractJavaMetadata(relFile, stripped) {
  const pkgMatch = stripped.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m);
  const packageName = pkgMatch ? pkgMatch[1] : '';
  const typeDecl = stripped.match(
    /(?:^|\s)(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|sealed\s+|static\s+|data\s+|open\s+)*\b(?:class|interface|record)\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?([^;{]*)\{/
  );
  const className = typeDecl ? typeDecl[1] : path.basename(relFile).replace(/\.(java|kt)$/i, '');
  const fqcn = packageName ? `${packageName}.${className}` : className;

  /** @type {string[]} */
  const imports = [];
  for (const m of stripped.matchAll(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*$]+)\s*;/gm)) {
    imports.push(m[1]);
  }

  /** @type {string[]} */
  const superTypes = [];
  if (typeDecl && typeDecl[2]) {
    for (const m of typeDecl[2].matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) {
      if (!['Object', 'Serializable'].includes(m[1])) superTypes.push(m[1]);
    }
  }

  /** @type {string[]} */
  const fieldTypes = [];
  for (const m of stripped.matchAll(/(?:@(?:Resource|Autowired|Inject)\s+(?:private|protected|public)?\s*(?:final\s+)?|private\s+final\s+)([A-Z][A-Za-z0-9_$]*)(?:<[^>]*>)?\s+[a-zA-Z_$][A-Za-z0-9_$]*\s*[;=]/g)) {
    fieldTypes.push(m[1]);
  }

  return {
    relFile,
    packageName,
    className,
    fqcn,
    imports,
    superTypes: [...new Set(superTypes)],
    fieldTypes: [...new Set(fieldTypes)],
    isController: /@(?:Rest)?Controller\b/.test(stripped),
    isService: /@Service\b/.test(stripped) || /Service(?:Impl)?$/.test(className),
    isMapper: /@Mapper\b/.test(stripped) || /Mapper$/.test(className),
    isEntity: /@(?:TableName|Table|Entity)\b/.test(stripped) || /(?:DO|Entity|PO)$/.test(className),
  };
}

/**
 * Extracts Spring MVC endpoints (header/body boundary, zero `/x/x` duplication, skips `@FeignClient`)
 * and `@TableName`/`@Table` DB entities from Java/Kotlin sources.
 * @param {string} relFile
 * @param {string} ext
 * @param {string} text
 */
export function extractSpringEndpointsAndEntities(relFile, ext, text) {
  if (ext !== '.java' && ext !== '.kt') return null;
  const stripped = stripJavaComments(text);
  /** @type {import('./backend-adapters.mjs').BackendEndpoint[]} */
  const endpoints = [];
  /** @type {import('./backend-adapters.mjs').DbEntity[]} */
  const entities = [];
  const javaMeta = extractJavaMetadata(relFile, stripped);

  for (const m of stripped.matchAll(/@(?:TableName|Table)\s*\(([^)]*)\)/g)) {
    const args = m[1];
    const tblMatch =
      args.match(/\b(?:value|name)\s*=\s*["']([a-zA-Z0-9_.]+)["']/) ||
      args.match(/^\s*["']([a-zA-Z0-9_.]+)["']/);
    if (tblMatch) {
      entities.push({ table: tblMatch[1], file: relFile, source: 'jpa/mybatis' });
    }
  }

  if (/@FeignClient\b/.test(stripped)) {
    return { endpoints, entities, javaMeta };
  }

  const classMatch = stripped.match(
    /(?:^|\s)(?:public\s+|protected\s+|private\s+|abstract\s+|final\s+|sealed\s+|static\s+|data\s+|open\s+)*\b(?:class|interface|record)\s+[A-Za-z0-9_$]+[^{;]*\{/
  );
  const splitIdx = classMatch && classMatch.index !== undefined ? classMatch.index + classMatch[0].length : 0;
  const headerText = splitIdx > 0 ? stripped.slice(0, splitIdx) : '';
  const bodyText = splitIdx > 0 ? stripped.slice(splitIdx) : stripped;

  const classMappings = scanMappingAnnotations(headerText).filter((a) => a.kind === 'Request');
  const classPrefixes = classMappings.length > 0 ? classMappings.flatMap((c) => c.paths) : [''];

  for (const methodAnn of scanMappingAnnotations(bodyText)) {
    for (const cPref of classPrefixes) {
      for (const mPath of methodAnn.paths) {
        const cleanPref = cPref.replace(/\/+$/, '');
        const cleanMethod = mPath.replace(/^\/+/, '');
        const combined = cleanMethod ? `${cleanPref}/${cleanMethod}` : cleanPref || '/';
        if (!combined || (combined === '/' && !cPref && !mPath)) continue;
        const normalized = normalizeRoutePath(combined).replace(/\{([^}:]+)(?::[^}]*)?\}/g, ':$1');
        endpoints.push({
          method: methodAnn.method,
          path: normalized,
          file: relFile,
          framework: 'spring',
          ...(javaMeta.packageName ? { packageName: javaMeta.packageName } : {}),
        });
      }
    }
  }

  return { endpoints, entities, javaMeta };
}

const SQL_KEYWORDS = new Set([
  'select', 'set', 'where', 'values', 'dual', 'lateral', 'unnest', 'json_table', 'information_schema',
  'as', 'on', 'and', 'or', 'null', 'true', 'false', 'case', 'when', 'then', 'else', 'end', 'if', 'in',
  'is', 'not', 'like', 'exists', 'between', 'distinct', 'all', 'any', 'some', 'union', 'order', 'group',
  'having', 'limit', 'offset', 'inner', 'left', 'right', 'outer', 'full', 'cross', 'using', 'by', 'asc',
  'desc', 'into', 'table', 'index', 'view', 'cursor', 'fetch', 'first', 'next', 'only', 'row', 'rows',
  'with', 'recursive', 'temp', 'temporary', 'each', 'new', 'old', 'result', 'count', 'sum', 'avg', 'min',
  'max', 'from', 'join', 'update', 'delete', 'insert', 'replace', 'truncate', 'alter', 'create', 'drop',
]);

/**
 * Extracts `<mapper namespace="...">` and SQL table references from MyBatis `*Mapper.xml` files.
 * @param {string} relFile
 * @param {string} ext
 * @param {string} text
 */
export function extractMybatisXmlEntities(relFile, ext, text) {
  if (ext !== '.xml' || !/<mapper\b/i.test(text)) return null;
  const nsMatch = text.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/i);
  const namespace = nsMatch ? nsMatch[1].trim() : '';
  const noComments = text.replace(/<!--[\s\S]*?-->/g, ' ');
  const sqlOnly = noComments
    .replace(/#\{[^}]*\}|\$\{[^}]*\}/g, ' ')
    .replace(/<[^>]+>/g, ' ');

  /** @type {Set<string>} */
  const tables = new Set();
  for (const m of sqlOnly.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+[`"']?([A-Za-z_][A-Za-z0-9_.]{1,63})[`"']?/gi)) {
    const raw = m[1].includes('.') ? m[1].split('.').pop() || m[1] : m[1];
    if (raw.length < 2 || SQL_KEYWORDS.has(raw.toLowerCase())) continue;
    tables.add(raw);
  }

  return {
    entities: [...tables].map((table) => ({ table, file: relFile, source: 'mybatis-xml', ...(namespace ? { namespace } : {}) })),
    mapper: namespace ? { file: relFile, namespace, tables: [...tables] } : null,
  };
}

/**
 * Extracts Spring `WebConfiguration` / `WebProperties` / `application*.yml` package-to-prefix rules.
 * @param {string} relFile
 * @param {string} text
 * @returns {Array<{ packagePattern: string, prefixes: string[] }>}
 */
export function extractSpringPrefixRulesFromFile(relFile, text) {
  /** @type {Array<{ packagePattern: string, prefixes: string[] }>} */
  const rules = [];
  const addRule = (/** @type {string} */ pkgPat, /** @type {string} */ pref) => {
    const cleanPref = normalizeRoutePath(pref);
    if (!pkgPat || !cleanPref || cleanPref === '/') return;
    const prefixes = [cleanPref];
    if (pkgPat.includes('.platform.') && cleanPref === '/platform-api') {
      prefixes.push('/admin-api/platform-api');
    }
    rules.push({ packagePattern: pkgPat.trim(), prefixes: [...new Set(prefixes)] });
  };

  if (/\.(java|kt)$/i.test(relFile)) {
    const stripped = stripJavaComments(text);
    if (/(?:WebConfiguration|WebMvcConfig|WebProperties|configurePathMatch|PathMatchConfigurer|addPathPrefix)/.test(stripped)) {
      for (const m of stripped.matchAll(/new\s+Api\s*\(\s*["'](\/[^"']+)["']\s*,\s*["']([^"']+)["']\s*\)/g)) {
        addRule(m[2], m[1]);
      }
      for (const m of stripped.matchAll(/addPathPrefix\s*\(\s*["'](\/[^"']+)["'][\s\S]{0,200}?["']([a-zA-Z0-9_.*]+controller[a-zA-Z0-9_.*]*)["']/g)) {
        addRule(m[2], m[1]);
      }
    }
  } else if (/(?:application|bootstrap)[^/]*\.(?:ya?ml|properties)$/i.test(relFile)) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const pm = lines[i].match(/^\s*prefix\s*[:=]\s*['"]?(\/[A-Za-z0-9_/-]+)['"]?/);
      if (!pm) continue;
      for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 4); j += 1) {
        const cm = lines[j].match(/^\s*controller\s*[:=]\s*['"]?([*A-Za-z0-9_.]+)['"]?/);
        if (cm) addRule(cm[1], pm[1]);
      }
    }
    for (const m of text.matchAll(/^\s*([a-z0-9_.-]+)\.prefix\s*=\s*(\/[A-Za-z0-9_/-]+)/gm)) {
      const ctrlMatch = text.match(new RegExp(`^\\s*${m[1].replace(/\./g, '\\.')}\\.controller\\s*=\\s*(\\S+)`, 'm'));
      if (ctrlMatch) addRule(ctrlMatch[1], m[2]);
    }
  }
  return rules;
}

/**
 * Matches a Java package name against an Ant-style package pattern (`**.controller.platform.**`).
 * @param {string} packageName
 * @param {string} pattern
 * @returns {boolean}
 */
export function matchAntPackagePattern(packageName, pattern) {
  if (!packageName || !pattern) return false;
  const escaped = pattern
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '\u0002')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\.\u0001\\\./g, '(?:\\..+)?\\.')
    .replace(/\u0001\\\./g, '(?:.+\\.)?')
    .replace(/\\\.\u0001/g, '(?:\\..*)?')
    .replace(/\u0001/g, '.*')
    .replace(/\u0002/g, '[^.]+');
  return new RegExp(`^${escaped}$`).test(packageName);
}

/**
 * Attaches discovered package-prefix aliases to Spring `backendEndpoints` after full repo indexing.
 * @param {Array<{ method: string, path: string, file: string, framework: string, packageName?: string, packagePrefixes?: string[], aliasedPaths?: string[] }>} endpoints
 * @param {Array<{ packagePattern: string, prefixes: string[] }>} rules
 */
export function attachSpringPackagePrefixes(endpoints, rules) {
  if (!Array.isArray(endpoints) || !Array.isArray(rules) || rules.length === 0) return;
  for (const ep of endpoints) {
    if (ep.framework !== 'spring' || !ep.packageName) continue;
    /** @type {Set<string>} */
    const prefixes = new Set(ep.packagePrefixes || []);
    for (const r of rules) {
      if (matchAntPackagePattern(ep.packageName, r.packagePattern)) {
        for (const p of r.prefixes) prefixes.add(p);
      }
    }
    if (prefixes.size === 0) continue;
    ep.packagePrefixes = [...prefixes];
    ep.aliasedPaths = [...prefixes]
      .filter((p) => !ep.path.startsWith(`${p}/`) && ep.path !== p)
      .map((p) => normalizeRoutePath(`${p}${ep.path}`));
  }
}
