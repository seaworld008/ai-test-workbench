#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeSuiteCore, runCli } from '../src/app/index.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_MODULES = path.join(ROOT, 'templates', 'playwright-qa', 'node_modules');

/**
 * Isolated fail-closed offline smoke verification (`npm run smoke`).
 *
 * Scaffolds a fresh temp QA workspace via `init` (which seals a valid T1-signed `.aitest/governance.lock`),
 * symlinks template `node_modules`, runs the offline `smoke` suite with `--audit` enabled (enforcing all
 * 4 fail-closed gate layers: Layer 0 governance lock, Layer 1 tsc/eslint, Layer 2 Run Ledger, Layer 3 AST checks),
 * and cleans up the temp workspace without polluting `templates/playwright-qa/`.
 */
async function main() {
  if (!fs.existsSync(path.join(TEMPLATE_MODULES, '@playwright', 'test', 'cli.js'))) {
    console.error('[Smoke BLOCKED] templates/playwright-qa/node_modules is not installed. Run `cd templates/playwright-qa && npm ci`.');
    process.exit(2);
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-smoke-'));
  try {
    const initCode = await runCli([
      'init',
      '--name',
      'workbench-smoke',
      '--target',
      tmpDir,
      '--skip-install',
      '--loop',
      'none',
      '--lang',
      'en',
    ]);
    if (initCode !== 0) {
      throw new Error(`aitest init failed with exit code ${initCode}`);
    }

    const qaDir = path.join(tmpDir, 'qa');
    fs.symlinkSync(TEMPLATE_MODULES, path.join(qaDir, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');

    const res = await executeSuiteCore({
      target: tmpDir,
      suite: 'smoke',
      audit: true,
    });

    if (!res.ok) {
      console.error(`[Smoke FAILED] exitCode=${res.exitCode}`);
      if (res.audit?.errors?.length) {
        for (const e of res.audit.errors) console.error(`  - ${e}`);
      }
      process.exit(res.exitCode || 1);
    }

    console.log(
      `[Smoke OK] Isolated initialized workspace passed offline smoke + 4-layer fail-closed audit (runId=${res.runId}, trustTier=${res.audit?.trustTier || 'T0'}).`
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

await main();
