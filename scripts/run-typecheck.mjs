#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

if (!fs.existsSync(tscBin)) {
  console.error(
    '[TypeCheck BLOCKED] typescript compiler not found in root node_modules/ (fail-closed). Run "npm ci" at repository root.'
  );
  process.exit(2);
}

const configPath = path.join(ROOT, 'tsconfig.check.json');
const res = spawnSync(process.execPath, [tscBin, '-p', configPath], {
  cwd: ROOT,
  shell: false,
  encoding: 'utf8',
  windowsHide: true,
});

if (res.status !== 0) {
  console.error('[TypeCheck FAILED] (tsconfig.check.json — strict: true, noImplicitAny: true)');
  if (res.stdout) console.error(res.stdout);
  if (res.stderr) console.error(res.stderr);
  process.exit(res.status || 1);
}

console.log('[TypeCheck OK] Verified tsconfig.check.json (strict: true, noImplicitAny: true) via tsc --checkJs --noEmit.');
