// @ts-check
import fs from 'node:fs';
import path from 'node:path';

export const GRAPH_EXTS = [
  '',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.vue',
  '.py',
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.vue',
  '/__init__.py',
];
export const GRAPH_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  'vendor',
  'reports',
  'knowledge',
  'playwright-report',
  'test-results',
  '.aitest',
  '.sandbox',
  '__pycache__',
  'venv',
  'site-packages',
  'pytest_cache',
  'mypy_cache',
]);
const ROOT_ONLY_OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'target']);
const IGNORED_VENDOR_DIR_SUFFIXES = ['public/libs', 'public/static', 'static/libs'];
export const MAX_GRAPH_FILES = 10000;
export const DEFAULT_PER_REPO_GRAPH_FILES = 16000;
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|py|java|xml)$/i;
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return', 'case', 'throw', 'in', 'of', 'typeof', 'void', 'delete', 'yield', 'await', 'new', 'else', 'do',
]);
const REGEX_PRECEDING_PUNCT = new Set(['(', '[', '{', ',', ';', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);

/**
 * Strips single-line `//` and block `/* ... *\/` comments in a single linear O(N) pass
 * while preserving string literals (`'...'`, `"..."`, `` `...` ``) and regex literals (`/a\/b/`).
 * @param {string} source
 * @returns {string}
 */
export function stripJsCommentsPreserveStrings(source) {
  const s = String(source || '');
  const len = s.length;
  /** @type {string[]} */
  const out = [];
  let i = 0;
  let lastNonWsChar = '';
  let lastWord = '';

  const canStartRegex = () => !lastNonWsChar || REGEX_PRECEDING_PUNCT.has(lastNonWsChar) || REGEX_PRECEDING_KEYWORDS.has(lastWord);

  while (i < len) {
    const ch = s[i];
    const next = i + 1 < len ? s[i + 1] : '';

    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { i += 1; break; }
        if (quote !== '`' && (c === '\n' || c === '\r')) break;
        i += 1;
      }
      out.push(s.slice(start, i));
      lastNonWsChar = quote;
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
        lastNonWsChar = '/';
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
      lastNonWsChar = word[word.length - 1];
      continue;
    }
    out.push(ch);
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
      lastNonWsChar = ch;
      lastWord = '';
    }
    i += 1;
  }
  return out.join('');
}

/**
 * @typedef {{
 *   files: Array<{ full: string, rel: string }>,
 *   relSet: Set<string>,
 *   lowerToRel: Map<string, string>,
 *   hasSrcDir: boolean,
 *   truncated: boolean,
 * }} RepoSourceIndex
 */

/**
 * Single-pass directory walk collecting candidate source files (TS/JS/Vue/Java/XML) and an O(1) lookup index.
 * Preserves `build`/`dist`/`out`/`target` under `src/` (e.g. `src/views/infra/build/index.vue`).
 * @param {string} repoDir
 * @param {{ includeQa?: boolean, maxFiles?: number }} [options]
 * @returns {RepoSourceIndex}
 */
export function buildRepoSourceIndex(repoDir, options = {}) {
  const maxFiles = options.maxFiles ?? DEFAULT_PER_REPO_GRAPH_FILES;
  /** @type {Array<{ full: string, rel: string }>} */
  const files = [];
  /** @type {Set<string>} */
  const relSet = new Set();
  /** @type {Map<string, string>} */
  const lowerToRel = new Map();
  let truncated = false;
  const hasSrcDir = fs.existsSync(path.join(repoDir, 'src'));
  const rootStartsInSrc = path.basename(path.resolve(repoDir)) === 'src';

  const walk = (/** @type {string} */ dir, /** @type {string} */ relDir, /** @type {boolean} */ hasSrcAncestor) => {
    if (files.length >= maxFiles) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        truncated = true;
        break;
      }
      if (GRAPH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (!options.includeQa) {
        if (entry.name === 'qa') continue;
        if ((entry.name === 'tests' || entry.name === 'test' || entry.name === '__tests__') && !hasSrcAncestor) continue;
      }
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (!options.includeQa && (rel === 'src/test' || rel.endsWith('/src/test'))) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (ROOT_ONLY_OUTPUT_DIRS.has(entry.name) && !hasSrcAncestor) continue;
        if (IGNORED_VENDOR_DIR_SUFFIXES.some((sfx) => rel === sfx || rel.endsWith(`/${sfx}`))) continue;
        walk(full, rel, hasSrcAncestor || entry.name === 'src');
      } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name) && !/\.min\.[mc]?js$/i.test(entry.name)) {
        relSet.add(rel);
        lowerToRel.set(rel.toLowerCase(), rel);
        files.push({ full, rel });
      }
    }
  };

  walk(repoDir, '', rootStartsInSrc);
  return { files, relSet, lowerToRel, hasSrcDir, truncated };
}

/**
 * Resolves a static import specifier in O(1) using an in-memory `RepoSourceIndex`.
 * @param {string} fromRel
 * @param {string} specifier
 * @param {Array<{ prefix: string, targetRelPrefix: string }>} pathAliases
 * @param {RepoSourceIndex} index
 * @returns {string | null}
 */
export function resolveRepoImportFromIndex(fromRel, specifier, pathAliases, index) {
  let baseRel = null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    const dir = path.posix.dirname(fromRel);
    const joined = dir === '.' ? specifier : `${dir}/${specifier}`;
    baseRel = path.posix.normalize(joined);
  } else if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const sub = specifier.slice(2);
    baseRel = path.posix.normalize(index.hasSrcDir ? `src/${sub}` : sub);
  } else {
    for (const al of pathAliases) {
      if (al.prefix && specifier.startsWith(al.prefix)) {
        const tail = specifier.slice(al.prefix.length);
        baseRel = path.posix.normalize(al.targetRelPrefix ? `${al.targetRelPrefix}/${tail}` : tail);
        break;
      }
    }
  }
  if (!baseRel || baseRel.startsWith('..')) return null;
  if (baseRel.startsWith('./')) baseRel = baseRel.slice(2);

  const checkCandidate = (/** @type {string} */ cand) => {
    if (index.relSet.has(cand)) return cand;
    if (process.platform === 'win32' || process.platform === 'darwin') {
      const ci = index.lowerToRel.get(cand.toLowerCase());
      if (ci) return ci;
    }
    return null;
  };

  for (const ext of GRAPH_EXTS) {
    const hit = checkCandidate(`${baseRel}${ext}`);
    if (hit) return hit;
  }

  if (baseRel.endsWith('.js')) {
    const stem = baseRel.slice(0, -3);
    const tsHit = checkCandidate(`${stem}.ts`) || checkCandidate(`${stem}.tsx`);
    if (tsHit) return tsHit;
  }
  return null;
}

/**
 * Strips `# ...` comments and triple-quoted docstrings/multiline strings from Python source
 * while preserving single-line strings and line boundaries.
 * @param {string} source
 * @returns {string}
 */
export function stripPythonComments(source) {
  const s = String(source || '');
  const len = s.length;
  /** @type {string[]} */
  const out = [];
  let i = 0;

  while (i < len) {
    const ch = s[i];
    if (ch === '#') {
      i += 1;
      while (i < len && s[i] !== '\n' && s[i] !== '\r') i += 1;
      out.push(' ');
      continue;
    }
    if (ch === '"' || ch === "'") {
      if (s[i + 1] === ch && s[i + 2] === ch) {
        const delim = ch + ch + ch;
        i += 3;
        out.push('""');
        while (i < len) {
          if (s[i] === '\\') { if (s[i + 1] === '\n') out.push('\n'); i += 2; continue; }
          if (s.startsWith(delim, i)) { i += 3; break; }
          if (s[i] === '\n') out.push('\n');
          i += 1;
        }
        continue;
      }
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const c = s[i];
        if (c === '\\') { i += 2; continue; }
        if (c === quote) { i += 1; break; }
        if (c === '\n' || c === '\r') break;
        i += 1;
      }
      out.push(s.slice(start, i));
      continue;
    }
    out.push(ch);
    i += 1;
  }
  return out.join('');
}

/** @param {string} cand @param {RepoSourceIndex} index @returns {string | null} */
function checkPythonCandidate(cand, index) {
  if (index.relSet.has(cand)) return cand;
  if (process.platform === 'win32' || process.platform === 'darwin') {
    return index.lowerToRel.get(cand.toLowerCase()) || null;
  }
  return null;
}

/**
 * Resolves a dotted/slashed Python module path against `index` (including `mod.py`,
 * `mod/__init__.py`, `src/...`, and subpath package roots such as `libs/<pkg>/mod.py`).
 * @param {string} modPath
 * @param {RepoSourceIndex} index
 * @param {string[]} pyRelFiles
 * @returns {string[]}
 */
function resolvePythonModuleCandidates(modPath, index, pyRelFiles) {
  const clean = modPath.replace(/^\/+|\/+$/g, '');
  if (!clean) return [];
  for (const base of index.hasSrcDir ? [clean, `src/${clean}`] : [clean]) {
    const fileHit = checkPythonCandidate(`${base}.py`, index);
    if (fileHit) return [fileHit];
    const initHit = checkPythonCandidate(`${base}/__init__.py`, index);
    if (initHit) return [initHit];
  }
  const ci = process.platform === 'win32' || process.platform === 'darwin';
  const cleanNorm = ci ? clean.toLowerCase() : clean;
  const sfxFile = `/${cleanNorm}.py`;
  const sfxInit = `/${cleanNorm}/__init__.py`;
  /** @type {string[]} */
  const suffixHits = [];
  for (const rel of pyRelFiles) {
    const cmpRel = ci ? rel.toLowerCase() : rel;
    if (cmpRel === `${cleanNorm}.py` || cmpRel === `${cleanNorm}/__init__.py` || cmpRel.endsWith(sfxFile) || cmpRel.endsWith(sfxInit)) {
      suffixHits.push(rel);
    }
  }
  if (suffixHits.length === 1 || (suffixHits.length > 1 && clean.includes('/'))) return suffixHits;
  return [];
}

/**
 * Extracts static Python `from ... import ...` and `import ...` target file paths.
 * @param {string} fromRel
 * @param {string} rawText
 * @param {RepoSourceIndex} index
 * @param {string[]} pyRelFiles
 * @returns {string[]}
 */
export function extractPythonImportTargets(fromRel, rawText, index, pyRelFiles) {
  const stripped = stripPythonComments(rawText).replace(/\\\r?\n/g, ' ');
  /** @type {Set<string>} */
  const targets = new Set();
  const fromDir = path.posix.dirname(fromRel);
  const fromDirParts = fromDir === '.' ? [] : fromDir.split('/').filter(Boolean);

  for (const m of stripped.matchAll(/^\s*from\s+(\.+[A-Za-z0-9_.]*|[A-Za-z0-9_.]+)\s+import\s+(\([^)]*\)|[^\n;]+)/gm)) {
    const modSpec = m[1].trim();
    const itemNames = m[2]
      .replace(/^\(|\)$/g, '')
      .split(',')
      .map((part) => part.trim().replace(/\s+as\s+[A-Za-z0-9_]+$/i, '').trim())
      .filter((name) => /^[A-Za-z0-9_]+$/.test(name));

    if (modSpec.startsWith('.')) {
      const dotMatch = modSpec.match(/^(\.+)(.*)$/);
      const pops = (dotMatch ? dotMatch[1].length : 1) - 1;
      if (pops > fromDirParts.length) continue;
      const baseParts = fromDirParts.slice(0, fromDirParts.length - pops);
      const tailParts = dotMatch?.[2] ? dotMatch[2].split('.').filter(Boolean) : [];
      const relBase = [...baseParts, ...tailParts].join('/');
      let resolvedSubmodule = false;
      for (const itemName of itemNames) {
        const subCand = relBase ? `${relBase}/${itemName}` : itemName;
        const subHit = checkPythonCandidate(`${subCand}.py`, index) || checkPythonCandidate(`${subCand}/__init__.py`, index);
        if (subHit && subHit !== fromRel) { targets.add(subHit); resolvedSubmodule = true; }
      }
      if (relBase) {
        const modHit = checkPythonCandidate(`${relBase}.py`, index) || checkPythonCandidate(`${relBase}/__init__.py`, index);
        if (modHit && modHit !== fromRel) targets.add(modHit);
      } else if (!resolvedSubmodule && baseParts.length > 0) {
        const initHit = checkPythonCandidate(`${baseParts.join('/')}/__init__.py`, index);
        if (initHit && initHit !== fromRel) targets.add(initHit);
      }
      continue;
    }

    const modPath = modSpec.replace(/\./g, '/');
    for (const hit of resolvePythonModuleCandidates(modPath, index, pyRelFiles)) {
      if (hit !== fromRel) targets.add(hit);
    }
    for (const itemName of itemNames) {
      for (const hit of resolvePythonModuleCandidates(`${modPath}/${itemName}`, index, pyRelFiles)) {
        if (hit !== fromRel) targets.add(hit);
      }
    }
  }

  for (const m of stripped.matchAll(/^\s*import\s+((?:[A-Za-z0-9_.]+(?:\s+as\s+[A-Za-z0-9_]+)?)(?:\s*,\s*[A-Za-z0-9_.]+(?:\s+as\s+[A-Za-z0-9_]+)?)*)/gm)) {
    for (const part of m[1].split(',')) {
      const modName = part.trim().replace(/\s+as\s+[A-Za-z0-9_]+$/i, '').trim();
      if (!/^[A-Za-z0-9_.]+$/.test(modName)) continue;
      for (const hit of resolvePythonModuleCandidates(modName.replace(/\./g, '/'), index, pyRelFiles)) {
        if (hit !== fromRel) targets.add(hit);
      }
    }
  }
  return [...targets];
}
