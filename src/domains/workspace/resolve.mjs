// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/**
 * Canonicalizes a filesystem path with symlink resolution when the path exists on disk.
 * @param {string} targetPath
 * @returns {string}
 */
export function canonicalizeWorkspacePath(targetPath) {
  const abs = path.resolve(targetPath);
  if (!fs.existsSync(abs)) return abs;
  try {
    return typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(abs) : fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

/**
 * Resolves the active isolated `<qaDir>` given a repository root or QA directory path.
 * @param {string} targetPath
 * @param {string} [explicitQaDir]
 * @returns {string | null}
 */
export function resolveQaDirectory(targetPath, explicitQaDir) {
  const abs = path.resolve(targetPath);
  if (explicitQaDir) {
    const explicitResolved = path.resolve(abs, explicitQaDir);
    if (
      fs.existsSync(path.join(explicitResolved, 'playwright.config.ts')) ||
      fs.existsSync(path.join(explicitResolved, 'playwright.config.js')) ||
      fs.existsSync(path.join(explicitResolved, 'package.json'))
    ) {
      return explicitResolved;
    }
  }
  if (fs.existsSync(path.join(abs, 'playwright.config.ts')) || fs.existsSync(path.join(abs, 'playwright.config.js'))) {
    return abs;
  }
  const sub = path.resolve(abs, explicitQaDir || 'qa');
  if (
    fs.existsSync(path.join(sub, 'playwright.config.ts')) ||
    fs.existsSync(path.join(sub, 'playwright.config.js')) ||
    fs.existsSync(path.join(sub, 'package.json'))
  ) {
    return sub;
  }
  return null;
}

/**
 * Resolves both `repoDir` and `qaDir` from a user-supplied CLI/MCP target.
 * @param {string} targetPath
 * @param {string} [explicitQaDir]
 * @returns {{ target: string, repoDir: string, qaDir: string | null }}
 */
export function resolveWorkspace(targetPath, explicitQaDir) {
  const target = path.resolve(targetPath);
  const qaDir = resolveQaDirectory(target, explicitQaDir);
  const repoDir = qaDir && target === qaDir ? path.dirname(qaDir) : target;
  return { target, repoDir, qaDir };
}
