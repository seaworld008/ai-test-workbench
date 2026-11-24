import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, '..', 'test');

/**
 * Recursively discovers all `*.test.mjs` files under `test/`.
 * @param {string} dir
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function collectTestFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTestFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.test.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

const testFiles = collectTestFiles(testDir).sort();

const res = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});

process.exit(typeof res.status === 'number' ? res.status : 1);
