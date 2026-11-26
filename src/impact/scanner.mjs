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
  '/index.ts',
  '/index.tsx',
  '/index.js',
  '/index.vue',
];
export const GRAPH_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  'reports',
  'playwright-report',
  'test-results',
  '.aitest',
]);
export const MAX_GRAPH_FILES = 10000;
const SOURCE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i;
const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'yield',
  'await',
  'new',
  'else',
  'do',
]);
const REGEX_PRECEDING_PUNCT = new Set(['(', '[', '{', ',', ';', '=', ':', '!', '&', '|', '?', '+', '-', '*', '%', '^', '~', '<', '>']);

/**
 * Strips single-line `//` and block `/* ... *\/` comments in a single linear O(N) pass
 * while preserving string literals (`'...'`, `"..."`, `` `...` ``) and regex literals (`/a\/b/`)
 * so URLs (`http://...`) stay intact and commented-out imports never produce false edges.
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

  const canStartRegex = () => {
    if (!lastNonWsChar) return true;
    if (REGEX_PRECEDING_PUNCT.has(lastNonWsChar)) return true;
    return REGEX_PRECEDING_KEYWORDS.has(lastWord);
  };

  while (i < len) {
    const ch = s[i];
    const next = i + 1 < len ? s[i + 1] : '';

    // Single-quoted, double-quoted, or template string literal
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < len) {
        const c = s[i];
        if (c === '\\') {
          i += 2;
          continue;
        }
        if (c === quote) {
          i += 1;
          break;
        }
        if (quote !== '`' && (c === '\n' || c === '\r')) {
          break;
        }
        i += 1;
      }
      out.push(s.slice(start, i));
      lastNonWsChar = quote;
      lastWord = '';
      continue;
    }

    // Line comment `// ...`
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < len && s[i] !== '\n' && s[i] !== '\r') i += 1;
      out.push(' ');
      continue;
    }

    // Block comment `/* ... */`
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < len) {
        if (s[i] === '*' && i + 1 < len && s[i + 1] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      out.push(' ');
      continue;
    }

    // Regex literal `/pattern/flags` (avoids mistaking `/[/*]/` for a comment)
    if (ch === '/' && canStartRegex()) {
      const start = i;
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < len) {
        const c = s[j];
        if (c === '\n' || c === '\r') break;
        if (c === '\\') {
          j += 2;
          continue;
        }
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

    // Track identifier words for regex-vs-division disambiguation
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
 * Single-pass directory walk collecting candidate source files and an O(1) lookup index
 * to eliminate per-import synchronous `fs.existsSync` / `fs.statSync` syscall storms.
 * @param {string} repoDir
 * @param {{ includeQa?: boolean, maxFiles?: number }} [options]
 * @returns {RepoSourceIndex}
 */
export function buildRepoSourceIndex(repoDir, options = {}) {
  const maxFiles = options.maxFiles ?? MAX_GRAPH_FILES;
  /** @type {Array<{ full: string, rel: string }>} */
  const files = [];
  /** @type {Set<string>} */
  const relSet = new Set();
  /** @type {Map<string, string>} */
  const lowerToRel = new Map();
  let truncated = false;
  const hasSrcDir = fs.existsSync(path.join(repoDir, 'src'));

  const walk = (/** @type {string} */ dir) => {
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
      if (!options.includeQa && entry.name === 'qa') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && SOURCE_FILE_RE.test(entry.name)) {
        const rel = path.relative(repoDir, full).replace(/\\/g, '/');
        relSet.add(rel);
        lowerToRel.set(rel.toLowerCase(), rel);
        files.push({ full, rel });
      }
    }
  };

  walk(repoDir);
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

  // Handle TypeScript ESM `.js` import specifiers pointing to `.ts` / `.tsx` sources
  if (baseRel.endsWith('.js')) {
    const stem = baseRel.slice(0, -3);
    const tsHit = checkCandidate(`${stem}.ts`) || checkCandidate(`${stem}.tsx`);
    if (tsHit) return tsHit;
  }

  return null;
}
