// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/**
 * Resolves the local Playwright CLI script inside a QA project directory.
 * @param {string} qaDir
 * @returns {string | null}
 */
export function resolvePlaywrightCli(qaDir) {
  const candidates = [
    path.join(qaDir, 'node_modules', '@playwright', 'test', 'cli.js'),
    path.join(qaDir, 'node_modules', 'playwright', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolves the local Playwright ESM package entrypoint inside a QA project directory.
 * Used by explore, perf, and auth-login without spawning shell commands.
 * @param {string} qaDir
 * @returns {string | null}
 */
export function resolvePlaywrightPackage(qaDir) {
  const candidates = [
    path.join(qaDir, 'node_modules', 'playwright', 'index.mjs'),
    path.join(qaDir, 'node_modules', '@playwright', 'test', 'index.mjs'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}
