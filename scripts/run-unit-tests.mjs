import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const testDir = path.resolve(__dirname, '..', 'test');
const testFiles = fs
  .readdirSync(testDir)
  .filter((name) => name.endsWith('.test.mjs'))
  .sort()
  .map((name) => path.join(testDir, name));

const res = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  shell: false,
  windowsHide: true,
});

process.exit(typeof res.status === 'number' ? res.status : 1);
