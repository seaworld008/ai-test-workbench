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

/**
 * Compiles a simple glob pattern (`**`, `*`) into a case-insensitive anchored RegExp
 * matching POSIX-style relative paths.
 * @param {string} glob
 * @returns {RegExp}
 */
export function compileGlob(glob) {
  const norm = normalizePosixPath(glob);
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
  return new RegExp(`^${out}$`, 'i');
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
