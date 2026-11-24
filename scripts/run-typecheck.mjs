#!/usr/bin/env node
// @ts-check
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const tscCandidates = [
  path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
  path.join(ROOT, 'templates', 'playwright-qa', 'node_modules', 'typescript', 'bin', 'tsc'),
];

const tscBin = tscCandidates.find((p) => fs.existsSync(p));
if (!tscBin) {
  const isCi = process.env.CI === 'true' || process.env.CI === '1' || process.argv.includes('--strict');
  if (isCi) {
    console.error(
      '[TypeCheck BLOCKED] typescript compiler not installed (fail-closed in CI/--strict mode).'
    );
    process.exit(2);
  }
  console.warn('[TypeCheck SKIP] typescript compiler not installed locally yet (run npm ci in templates/playwright-qa).');
  process.exit(0);
}

const configs = [
  { label: 'tsconfig.check.json', file: path.join(ROOT, 'tsconfig.check.json') },
  { label: 'tsconfig.strict.json', file: path.join(ROOT, 'tsconfig.strict.json') },
].filter((cfg) => fs.existsSync(cfg.file));

for (const cfg of configs) {
  const res = spawnSync(process.execPath, [tscBin, '-p', cfg.file], {
    cwd: ROOT,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });

  if (res.status !== 0) {
    console.error(`[TypeCheck FAILED] (${cfg.label})`);
    if (res.stdout) console.error(res.stdout);
    if (res.stderr) console.error(res.stderr);
    process.exit(res.status || 1);
  }
}

console.log(
  `[TypeCheck OK] Verified ${configs.map((c) => c.label).join(' + ')} via tsc --checkJs --noEmit.`
);
