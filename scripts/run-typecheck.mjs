#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const tscCandidates = [
  path.join(ROOT, 'templates', 'playwright-qa', 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
];

const tscBin = tscCandidates.find((p) => fs.existsSync(p));
if (!tscBin) {
  const isCi = process.env.CI === 'true' || process.env.CI === '1' || process.argv.includes('--strict');
  if (isCi) {
    console.error(
      '[TypeCheck BLOCKED] typescript compiler not installed in templates/playwright-qa/node_modules (fail-closed in CI/--strict mode).'
    );
    process.exit(2);
  }
  console.warn('[TypeCheck SKIP] typescript compiler not installed locally yet (run npm ci in templates/playwright-qa).');
  process.exit(0);
}

const res = spawnSync(process.execPath, [tscBin, '-p', path.join(ROOT, 'tsconfig.check.json')], {
  cwd: ROOT,
  shell: false,
  encoding: 'utf8',
  windowsHide: true,
});

if (res.status !== 0) {
  console.error('[TypeCheck FAILED]');
  if (res.stdout) console.error(res.stdout);
  if (res.stderr) console.error(res.stderr);
  process.exit(res.status || 1);
}

console.log('[TypeCheck OK] Verified src/**/*.mjs & template support/gate-kernel.mjs via tsc --checkJs --noEmit.');
