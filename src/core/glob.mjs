// @ts-check

/**
 * Normalizes a filesystem path to forward-slash POSIX form without a leading `./`.
 * @param {string} value
 * @returns {string}
 */
export function normalizePosixPath(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
}

const MAX_GLOB_CACHE = 512;
/** @type {Map<string, RegExp>} */
const globRegexCache = new Map();

/**
 * Compiles a simple glob pattern (`**`, `*`) into a case-insensitive anchored RegExp
 * matching POSIX-style relative paths. Bounded memoization avoids recompiling policy globs.
 * @param {string} glob
 * @returns {RegExp}
 */
export function compileGlob(glob) {
  const norm = normalizePosixPath(glob);
  const cached = globRegexCache.get(norm);
  if (cached) return cached;

  let out = '';
  for (let i = 0; i < norm.length; i += 1) {
    const ch = norm[i];
    if (ch === '*' && norm[i + 1] === '*') {
      out += '.*';
      i += 1;
      if (norm[i + 1] === '/') i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  const re = new RegExp(`^${out}$`, 'i');
  if (globRegexCache.size >= MAX_GLOB_CACHE) {
    const oldestKey = globRegexCache.keys().next().value;
    if (oldestKey !== undefined) globRegexCache.delete(oldestKey);
  }
  globRegexCache.set(norm, re);
  return re;
}

/**
 * Checks whether a relative path matches any glob pattern in the list.
 * @param {string} filePath
 * @param {readonly string[]} globs
 * @returns {boolean}
 */
export function matchesAnyGlob(filePath, globs) {
  const norm = normalizePosixPath(filePath);
  if (!norm || !Array.isArray(globs) || globs.length === 0) return false;
  return globs.some((pattern) => compileGlob(pattern).test(norm));
}
