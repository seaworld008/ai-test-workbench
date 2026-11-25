// @ts-check
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {
  bootstrapWorkspaceCore,
  computeImpact,
  runAuditForQaDir,
  runMapCommand,
} from '../../src/app/index.mjs';

/**
 * Runs a lightweight zero-to-one Autonomous Loop Benchmark (`WU-06`):
 * Measures autonomous completion rate, wall-clock duration, and false-green escape rate (FGER = 0)
 * across bootstrap, codebase map -> auto impact linking, and branch-new spec draft iteration.
 *
 * @returns {Promise<{
 *   benchmarkName: string,
 *   autonomousCompletionRate: number,
 *   completedScenarios: number,
 *   totalScenarios: number,
 *   elapsedMs: number,
 *   fger: number,
 *   scenarios: Array<{ id: string, passed: boolean, durationMs: number, detail: string }>,
 * }>}
 */
export async function runAutonomousSuiteBenchmark() {
  const suiteStart = Date.now();
  /** @type {Array<{ id: string, passed: boolean, durationMs: number, detail: string }>} */
  const scenarios = [];
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-autonomous-bench-'));
  const keyFile = path.join(tmpDir, '.t1-key.hex');
  fs.writeFileSync(keyFile, 'f'.repeat(64), 'utf8');
  const prevKey = process.env.AITEST_HMAC_KEY_FILE;
  process.env.AITEST_HMAC_KEY_FILE = keyFile;

  const git = (/** @type {string} */ cwd, /** @type {string[]} */ args) =>
    execFileSync('git', ['-c', 'core.quotePath=off', ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();

  let server = null;
  try {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 3000;
    const baseUrl = `http://127.0.0.1:${port}`;

    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'package.json'), JSON.stringify({ name: 'auto-bench', scripts: { dev: 'node server.js' } }), 'utf8');
    fs.writeFileSync(path.join(repoDir, 'src', 'pages', 'orders.tsx'), 'export function OrdersPage() { return "orders"; }\n', 'utf8');
    git(repoDir, ['init', '-b', 'main']);
    git(repoDir, ['config', 'user.email', 'bench@example.com']);
    git(repoDir, ['config', 'user.name', 'Bench User']);
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'chore: base']);

    // Scenario 1: Zero-to-one loopback bootstrap
    const s1Start = Date.now();
    const bootRes = await bootstrapWorkspaceCore({
      target: repoDir,
      baseUrl,
      port,
      skipInstall: true,
      skipBrowser: true,
      json: true,
    });
    const qaDir = path.join(repoDir, 'qa');
    scenarios.push({
      id: 'AUTO-01-bootstrap',
      passed: Boolean(bootRes.ok && bootRes.data?.serverReachable && fs.existsSync(path.join(qaDir, 'aitest.runtime.json'))),
      durationMs: Date.now() - s1Start,
      detail: `ok=${bootRes.ok}, reachable=${bootRes.data?.serverReachable}`,
    });

    // Scenario 2: Map sync -> auto-generated impact map resolves changed page -> spec
    const s2Start = Date.now();
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'orders.spec.ts'),
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-ORD] orders @e2e', async ({ page }) => { await page.goto('/orders'); await expect(page).toHaveURL(/orders/); });\n`,
      'utf8'
    );
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'chore: add qa baseline']);
    const baseSha = git(repoDir, ['rev-parse', 'HEAD']);
    const mapExit = await runMapCommand({ target: repoDir, json: true });
    const impRes = await computeImpact(qaDir, { files: ['src/pages/orders.tsx'] });
    scenarios.push({
      id: 'AUTO-02-map-impact',
      passed: mapExit === 0 && impRes.specs.some((s) => s.endsWith('orders.spec.ts')),
      durationMs: Date.now() - s2Start,
      detail: `mapExit=${mapExit}, matchedSpecs=${impRes.specs.length}`,
    });

    // Scenario 3: Branch-new spec draft refactor passes while S0 cheat is still blocked (FGER = 0)
    const s3Start = Date.now();
    git(repoDir, ['checkout', '-b', 'feat/draft']);
    const draftPath = path.join(qaDir, 'tests', 'e2e', 'draft.spec.ts');
    fs.writeFileSync(
      draftPath,
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-DFT] draft @critical', async ({ page }) => { await expect(page.getByRole('heading')).toHaveText('OK'); await expect(page).toHaveURL(/draft/); });\n`,
      'utf8'
    );
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'wip: draft 1']);
    fs.writeFileSync(
      draftPath,
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-DFT] draft', async ({ page }) => { await expect(page.getByRole('heading')).toContainText('OK'); });\n`,
      'utf8'
    );
    git(repoDir, ['add', '-A']);
    git(repoDir, ['commit', '-m', 'refactor: draft 2']);
    const benignAudit = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: false, diffBase: 'HEAD~1', baselineRef: baseSha, requireDiff: true });

    fs.writeFileSync(
      draftPath,
      `import { test, expect } from '../fixtures/base';\ntest('[REQ-DFT] draft', async () => { expect(true).toBe(true); });\n`,
      'utf8'
    );
    const cheatAudit = runAuditForQaDir(qaDir, { staticOnly: true, checkSpecs: false, diffBase: 'HEAD~1', baselineRef: baseSha, requireDiff: true });
    const fgerCount = cheatAudit.ok ? 1 : 0;
    scenarios.push({
      id: 'AUTO-03-draft-and-fger0',
      passed: benignAudit.ok && !cheatAudit.ok,
      durationMs: Date.now() - s3Start,
      detail: `benignOk=${benignAudit.ok}, cheatOk=${cheatAudit.ok}`,
    });

    const completedScenarios = scenarios.filter((s) => s.passed).length;
    return {
      benchmarkName: 'autonomous-suite',
      autonomousCompletionRate: scenarios.length > 0 ? completedScenarios / scenarios.length : 0,
      completedScenarios,
      totalScenarios: scenarios.length,
      elapsedMs: Date.now() - suiteStart,
      fger: fgerCount,
      scenarios,
    };
  } finally {
    if (server) server.close();
    if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
