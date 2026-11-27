// @ts-check
import path from 'node:path';
import { normalizeRoutePath } from './route-matcher.mjs';

/**
 * @typedef {{ packagePattern: string, prefixes: string[], sourceFile?: string, isRegex?: boolean }} SpringPrefixRule
 * @typedef {{ relFile: string, packageName: string, className: string, fqcn: string, imports: string[], rawConsts: Record<string, string> }} JavaConstDecl
 */

/** @param {string} s @param {number} start @returns {number} */
function scanJavaQuotedEnd(s, start) {
  const q = s[start];
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === '\\') { i += 2; continue; }
    if (s[i] === q) return i + 1;
    if (s[i] === '\n' || s[i] === '\r') return i;
    i += 1;
  }
  return i;
}

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
  for (let i = 0; i < len; ) {
    const ch = s[i];
    const next = i + 1 < len ? s[i + 1] : '';
    if (ch === '"' && next === '"' && s[i + 2] === '"') {
      const start = i;
      i += 3;
      while (i < len && !(s[i] === '"' && s[i + 1] === '"' && s[i + 2] === '"')) i += s[i] === '\\' ? 2 : 1;
      i = Math.min(len, i + 3);
      out.push(s.slice(start, i));
    } else if (ch === '"' || ch === "'") {
      const end = scanJavaQuotedEnd(s, i);
      out.push(s.slice(i, end));
      i = end;
    } else if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && s[i] !== '\n' && s[i] !== '\r') i += 1;
      out.push(' ');
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < len && !(s[i] === '*' && s[i + 1] === '/')) i += 1;
      i = Math.min(len, i + 2);
      out.push(' ');
    } else {
      out.push(ch);
      i += 1;
    }
  }
  return out.join('');
}

/**
 * Extracts balanced `(...)` argument text starting at `openParenIdx`.
 * @param {string} text
 * @param {number} openParenIdx
 * @returns {{ body: string, endIdx: number } | null}
 */
export function readBalancedParens(text, openParenIdx) {
  let depth = 0;
  for (let i = openParenIdx; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '"' || ch === "'") { i = scanJavaQuotedEnd(text, i) - 1; continue; }
    if (ch === '(') depth += 1;
    else if (ch === ')' && --depth === 0) return { body: text.slice(openParenIdx + 1, i), endIdx: i };
  }
  return null;
}

/** @param {string} raw @returns {string} */
export const unescapeJavaString = (raw) =>
  String(raw || '').replace(/\\(.)/g, (_m, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c === 'r' ? '\r' : c));

/**
 * Splits a top-level Java expression on a delimiter (`+` or `,`) outside quotes and parens.
 * @param {string} expr
 * @param {string} sep
 * @returns {string[]}
 */
export function splitJavaTopLevel(expr, sep) {
  /** @type {string[]} */
  const parts = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < expr.length; i += 1) {
    const ch = expr[i];
    if (ch === '"' || ch === "'") { i = scanJavaQuotedEnd(expr, i) - 1; continue; }
    if (ch === '(' || ch === '{' || ch === '[') depth += 1;
    else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    else if (depth === 0 && ch === sep) { parts.push(expr.slice(start, i).trim()); start = i + 1; }
  }
  parts.push(expr.slice(start).trim());
  return parts.filter(Boolean);
}

/**
 * Resolves a Java string expression (`"/admin-api"`, `ADMIN_API`, `RpcConstants.RPC_API_PREFIX + "/activity"`).
 * @param {string} expr
 * @param {Record<string, string>} [localConsts]
 * @param {Map<string, string>} [globalConsts]
 * @param {string[]} [imports]
 * @param {string} [packageName]
 * @returns {string | null}
 */
export function resolveJavaStringExpr(expr, localConsts = {}, globalConsts = new Map(), imports = [], packageName = '') {
  const parts = splitJavaTopLevel(String(expr || '').trim(), '+');
  if (parts.length === 0) return null;
  let out = '';
  for (const part of parts) {
    const strMatch = part.match(/^"((?:[^"\\]|\\.)*)"$/);
    if (strMatch) { out += unescapeJavaString(strMatch[1]); continue; }
    if (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(part)) {
      if (part in localConsts) { out += localConsts[part]; continue; }
      const impHit = imports.find((imp) => imp.endsWith(`.${part}`) && globalConsts.has(imp));
      const val = impHit ? globalConsts.get(impHit) : globalConsts.get(part);
      if (val === undefined) return null;
      out += val;
      continue;
    }
    const qm = part.match(/^([A-Za-z_$][A-Za-z0-9_$.]*)\.([A-Za-z_$][A-Za-z0-9_$]*)$/);
    if (!qm) return null;
    const [, owner, field] = qm;
    const impOwner = imports.find((imp) => (imp === owner || imp.endsWith(`.${owner}`)) && globalConsts.has(`${imp}.${field}`));
    const val =
      globalConsts.get(part) ??
      (impOwner ? globalConsts.get(`${impOwner}.${field}`) : undefined) ??
      (packageName ? globalConsts.get(`${packageName}.${owner}.${field}`) : undefined) ??
      globalConsts.get(`${owner}.${field}`);
    if (val === undefined) return null;
    out += val;
  }
  return out;
}

/**
 * Extracts Java string constant/field declarations from stripped Java/Kotlin source.
 * @param {string} relFile
 * @param {string} stripped
 * @returns {JavaConstDecl}
 */
export function extractJavaStringConstants(relFile, stripped) {
  const packageName = stripped.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m)?.[1] || '';
  const className = stripped.match(/\b(?:class|interface|record|enum)\s+([A-Za-z0-9_$]+)/)?.[1] || path.basename(relFile).replace(/\.(?:java|kt)$/i, '');
  const fqcn = packageName ? `${packageName}.${className}` : className;
  const imports = [...stripped.matchAll(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*$]+)\s*;/gm)].map((m) => m[1]);
  /** @type {Record<string, string>} */
  const rawConsts = {};
  for (const m of stripped.matchAll(/(?:^|[;{}\n])\s*(?:(?:public|private|protected|static|final)\s+)*String\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;{}\n]{1,240});/gm)) {
    if (!(m[1] in rawConsts)) rawConsts[m[1]] = m[2].trim();
  }
  return { relFile, packageName, className, fqcn, imports, rawConsts };
}

/**
 * Iteratively resolves cross-class Java `static final String` constants and `+` concatenations.
 * @param {JavaConstDecl[]} decls
 * @returns {Map<string, string>}
 */
export function buildJavaConstantTable(decls) {
  /** @type {Map<string, string>} */
  const globalConsts = new Map();
  /** @type {Map<string, number>} */
  const shortCounts = new Map();
  for (const d of decls || []) {
    for (const name of Object.keys(d.rawConsts || {})) shortCounts.set(`${d.className}.${name}`, (shortCounts.get(`${d.className}.${name}`) || 0) + 1);
  }
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false;
    for (const d of decls || []) {
      /** @type {Record<string, string>} */
      const local = {};
      for (const name of Object.keys(d.rawConsts || {})) {
        const v = globalConsts.get(`${d.fqcn}.${name}`);
        if (v !== undefined) local[name] = v;
      }
      for (const [name, rhs] of Object.entries(d.rawConsts || {})) {
        const fqKey = `${d.fqcn}.${name}`;
        if (globalConsts.has(fqKey)) continue;
        const val = resolveJavaStringExpr(rhs, local, globalConsts, d.imports, d.packageName);
        if (val !== null) {
          local[name] = val;
          globalConsts.set(fqKey, val);
          if ((shortCounts.get(`${d.className}.${name}`) || 0) === 1) globalConsts.set(`${d.className}.${name}`, val);
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return globalConsts;
}

/** @param {string} p @returns {boolean} */
const isRegexPackagePattern = (p) =>
  !p.includes('**') && (p.startsWith('^') || p.endsWith('$') || /\\\./.test(p) || /\.\*/.test(p) || /[|()]/.test(p));

/** @param {string} packageName @param {string} pattern @returns {boolean} */
export function matchAntPackagePattern(packageName, pattern) {
  if (!packageName || !pattern) return false;
  const escaped = pattern
    .replace(/\*\*/g, '\u0001').replace(/\*/g, '\u0002')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\.\u0001\\\./g, '(?:\\..+)?\\.').replace(/\u0001\\\./g, '(?:.+\\.)?')
    .replace(/\\\.\u0001/g, '(?:\\..*)?').replace(/\u0001/g, '.*').replace(/\u0002/g, '[^.]+');
  return new RegExp(`^${escaped}$`).test(packageName);
}

/** @param {string} packageName @param {string} pattern @returns {boolean} */
export function matchSpringPackagePattern(packageName, pattern) {
  if (!packageName || !pattern) return false;
  if (!isRegexPackagePattern(pattern)) return matchAntPackagePattern(packageName, pattern);
  try {
    const anchored = pattern.startsWith('^') || pattern.endsWith('$') ? pattern : `^${pattern}$`;
    if (new RegExp(anchored).test(packageName)) return true;
    const optionalTail = anchored.replace(/\\\.?\.\*\$$/, '(?:\\..*)?$');
    return optionalTail !== anchored && new RegExp(optionalTail).test(packageName);
  } catch {
    return false;
  }
}

/** @param {string} pattern @param {string} prefix @returns {number} */
export function scoreSpringPatternSpecificity(pattern, prefix) {
  const literal = String(pattern || '').replace(/\^\.\*|\\\./g, '.').replace(/[\^$*?+()[\]|\\]/g, '').replace(/\.+/g, '.').replace(/^\.|\.$/g, '');
  return literal.split('.').filter(Boolean).length * 40 + literal.length * 4 + String(prefix || '').length;
}

/**
 * Extracts Spring `WebProperties` / `WebAutoConfiguration` / `WebConfiguration` / `application*.yml`
 * package-to-prefix rules, resolving Java string constants and `+` concatenations.
 * @param {string} relFile @param {string} text @param {Map<string, string>} [globalConsts]
 * @returns {SpringPrefixRule[]}
 */
export function extractSpringPrefixRulesFromFile(relFile, text, globalConsts = new Map()) {
  /** @type {SpringPrefixRule[]} */
  const rules = [];
  const seen = new Set();
  const addRule = (/** @type {string} */ pkgPat, /** @type {string} */ pref) => {
    const cleanPref = normalizeRoutePath(pref);
    const cleanPat = String(pkgPat || '').trim();
    if (!cleanPat || !cleanPref || cleanPref === '/') return;
    const prefixes = cleanPat.includes('platform') && cleanPref === '/platform-api' ? ['/admin-api/platform-api', cleanPref] : [cleanPref];
    const key = `${cleanPat}=>${prefixes.join(',')}`;
    if (seen.has(key)) return;
    seen.add(key);
    rules.push({ packagePattern: cleanPat, prefixes, sourceFile: relFile, isRegex: isRegexPackagePattern(cleanPat) });
  };
  if (/\.(?:java|kt)$/i.test(relFile)) {
    const stripped = stripJavaComments(text);
    if (!/(?:WebConfiguration|WebAutoConfiguration|WebMvcConfig|WebProperties|configurePathMatch|PathMatchConfigurer|addPathPrefix|@ConfigurationProperties)/.test(stripped)) return rules;
    const decl = extractJavaStringConstants(relFile, stripped);
    /** @type {Record<string, string>} */
    const local = {};
    for (let pass = 0; pass < 3; pass += 1) {
      for (const [k, rhs] of Object.entries(decl.rawConsts)) {
        if (!(k in local)) {
          const val = resolveJavaStringExpr(rhs, local, globalConsts, decl.imports, decl.packageName);
          if (val !== null) local[k] = val;
        }
      }
    }
    const evalArg = (/** @type {string} */ expr) => resolveJavaStringExpr(expr, local, globalConsts, decl.imports, decl.packageName);
    for (const m of stripped.matchAll(/new\s+(?:[A-Za-z0-9_$]+\.)?Api\s*\(/g)) {
      const bal = readBalancedParens(stripped, (m.index || 0) + m[0].length - 1);
      const args = bal ? splitJavaTopLevel(bal.body, ',') : [];
      if (args.length < 2) continue;
      const prefVal = evalArg(args[0]);
      const patVal = evalArg(args[1]);
      if (prefVal?.startsWith('/') && patVal) addRule(patVal, prefVal);
    }
    for (const m of stripped.matchAll(/\baddPathPrefix\s*\(/g)) {
      const bal = readBalancedParens(stripped, (m.index || 0) + m[0].length - 1);
      const args = bal ? splitJavaTopLevel(bal.body, ',') : [];
      const prefVal = args.length >= 2 ? evalArg(args[0]) : null;
      const patLit = args.length >= 2 ? args[1].match(/"((?:[^"\\]|\\.)*controller(?:[^"\\]|\\.)*)"/) : null;
      if (prefVal?.startsWith('/') && patLit) addRule(unescapeJavaString(patLit[1]), prefVal);
    }
    if (rules.length === 0) {
      const prefField = local.prefix || local.apiPrefix || local.ADMIN_API || local.PLATFORM_API || '';
      const patField = local.controller || local.pkg || local.packagePattern || '';
      if (prefField.startsWith('/') && patField.includes('controller')) addRule(patField, prefField);
    }
  } else if (/(?:application|bootstrap)[^/]*\.(?:ya?ml|properties)$/i.test(relFile)) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const pm = lines[i].match(/^\s*prefix\s*[:=]\s*['"]?(\/[A-Za-z0-9_/-]+)['"]?/);
      if (!pm) continue;
      for (let j = Math.max(0, i - 3); j < Math.min(lines.length, i + 4); j += 1) {
        const cm = lines[j].match(/^\s*controller\s*[:=]\s*['"]?([^'"\s#]+)['"]?/);
        if (cm) addRule(cm[1], pm[1]);
      }
    }
    for (const m of text.matchAll(/^\s*([a-z0-9_.-]+)\.prefix\s*=\s*(\/[A-Za-z0-9_/-]+)/gm)) {
      const cm = text.match(new RegExp(`^\\s*${m[1].replace(/\./g, '\\.')}\\.controller\\s*=\\s*(\\S+)`, 'm'));
      if (cm) addRule(cm[1], m[2]);
    }
  }
  return rules;
}

/** @param {string} packageName @param {SpringPrefixRule[]} rules */
export function resolveSpringPackagePrefix(packageName, rules) {
  if (!packageName || !Array.isArray(rules) || rules.length === 0) return null;
  /** @type {Array<{ rule: SpringPrefixRule, primary: string, score: number }>} */
  const matches = [];
  for (const rule of rules) {
    if (!rule?.packagePattern || !rule.prefixes?.length || !matchSpringPackagePattern(packageName, rule.packagePattern)) continue;
    const primary = [...rule.prefixes].sort((a, b) => b.length - a.length)[0];
    matches.push({ rule, primary, score: scoreSpringPatternSpecificity(rule.packagePattern, primary) });
  }
  if (matches.length === 0) return null;
  matches.sort((a, b) => b.score - a.score || b.primary.length - a.primary.length);
  const best = matches[0];
  const prefixes = [...new Set(matches.filter((m) => m.score === best.score).flatMap((m) => m.rule.prefixes))].sort((a, b) => b.length - a.length);
  return { primaryPrefix: prefixes[0], prefixes, matchedPattern: best.rule.packagePattern };
}

/**
 * Attaches the most-specific discovered package prefix directly to Spring `backendEndpoints`.
 * @param {Array<{ method: string, path: string, rawPath?: string, file: string, framework: string, packageName?: string, packagePrefixes?: string[], aliasedPaths?: string[] }>} endpoints
 * @param {SpringPrefixRule[]} rules
 */
export function attachSpringPackagePrefixes(endpoints, rules) {
  if (!Array.isArray(endpoints) || !Array.isArray(rules) || rules.length === 0) return;
  for (const ep of endpoints) {
    if (ep.framework !== 'spring' || !ep.packageName) continue;
    const resolved = resolveSpringPackagePrefix(ep.packageName, rules);
    if (!resolved) continue;
    const rawPath = ep.rawPath || ep.path;
    ep.rawPath = rawPath;
    ep.packagePrefixes = resolved.prefixes;
    const joinPref = (/** @type {string} */ p) =>
      rawPath.startsWith(`${p}/`) || rawPath === p ? normalizeRoutePath(rawPath) : normalizeRoutePath(`${p}${rawPath === '/' ? '' : rawPath}`);
    ep.path = joinPref(resolved.primaryPrefix);
    const extras = resolved.prefixes.slice(1).map(joinPref).filter((p) => p !== ep.path);
    if (extras.length > 0) ep.aliasedPaths = [...new Set(extras)];
    else delete ep.aliasedPaths;
  }
}
