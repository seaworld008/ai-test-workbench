// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Low-level non-ASCII-safe Git execution and realpath canonicalization primitives.
 * Shared leaf module for `git-utils.mjs` and `git-ignore.mjs` with zero circular imports.
 */

/**
 * Executes a `git` command with `-c core.quotePath=off` so non-ASCII paths are never octal-escaped.
 * @param {string} cwd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, maxBuffer?: number }} [options]
 */
export function execGitSync(cwd, args, options = {}) {
  return spawnSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: options.timeoutMs ?? 15_000,
    maxBuffer: options.maxBuffer ?? 32 * 1024 * 1024,
  });
}

/**
 * Canonicalizes a filesystem path via `fs.realpathSync.native` (resolving Windows 8.3 short paths
 * such as `RUNNER~1`, directory junctions, and macOS `/var` -> `/private/var` symlinks).
 * For not-yet-existing paths, walks up to the nearest existing ancestor and rejoins trailing segments.
 * @param {string} p
 * @returns {string}
 */
export function canonicalFsPath(p) {
  const resolved = path.resolve(p);
  const realpathNative =
    typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync;
  try {
    if (fs.existsSync(resolved)) return realpathNative(resolved);
    let cur = resolved;
    /** @type {string[]} */
    const tail = [];
    while (!fs.existsSync(cur)) {
      const parent = path.dirname(cur);
      if (parent === cur) break;
      tail.unshift(path.basename(cur));
      cur = parent;
    }
    const realAncestor = fs.existsSync(cur) ? realpathNative(cur) : cur;
    return tail.length > 0 ? path.join(realAncestor, ...tail) : realAncestor;
  } catch {
    return resolved;
  }
}
