import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, '..', 'test');

/**
 * Recursively discovers all `*.test.mjs` files under `test/` (unit/, integration/, adversarial/).
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
const skipCoverage = process.argv.includes('--no-coverage');
const minLines = Number(process.env.AITEST_MIN_LINE_COVERAGE || 80);

const nodeArgs = ['--test'];
if (!skipCoverage) {
  nodeArgs.push(
    '--experimental-test-coverage',
    '--test-coverage-include=src/**/*.mjs',
    `--test-coverage-lines=${minLines}`
  );
}
nodeArgs.push(...testFiles);

const res = spawnSync(process.execPath, nodeArgs, {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});

process.exit(typeof res.status === 'number' ? res.status : 1);
