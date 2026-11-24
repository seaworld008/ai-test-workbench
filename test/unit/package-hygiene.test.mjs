import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { resolveNpmCliPath } from '../../src/core/proc.mjs';
import { REPO_ROOT } from '../../src/core/version.mjs';

test('npm package hygiene: zero runtime dependencies and tarball excludes internal reviews, history, and dev scripts', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  const runtimeDeps = Object.keys(pkg.dependencies || {});
  assert.deepEqual(runtimeDeps, [], `Root package.json must have ZERO runtime dependencies, found: ${runtimeDeps.join(', ')}`);

  const npmCli = resolveNpmCliPath();
  assert.ok(npmCli, 'npm-cli.js must be resolvable');
  const res = spawnSync(process.execPath, [npmCli, 'pack', '--dry-run', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    shell: false,
    windowsHide: true,
  });
  assert.equal(res.status, 0, `npm pack --dry-run --json failed: ${res.stderr}`);

  const parsed = JSON.parse(res.stdout);
  const packInfo = Array.isArray(parsed) ? parsed[0] : parsed;
  const files = (packInfo.files || []).map((f) => String(f.path || '').replace(/\\/g, '/'));
  assert.ok(files.length > 20, 'Expected packed files list');

  const forbidden = files.filter(
    (p) =>
      p.startsWith('docs/review/') ||
      p.startsWith('docs/history/') ||
      p.startsWith('scripts/') ||
      p.startsWith('.sandbox/') ||
      p.startsWith('bench/real-world/') ||
      p.startsWith('conformance/')
  );
  assert.deepEqual(forbidden, [], `Forbidden internal files leaked into npm tarball:\n${forbidden.join('\n')}`);

  // Verify essential runtime & template files ARE present
  assert.ok(files.includes('tools/aitest.mjs'));
  assert.ok(files.includes('src/kernel/index.mjs'));
  assert.ok(files.includes('templates/playwright-qa/support/gate-kernel.mjs'));
  assert.ok(files.includes('templates/playwright-qa/scripts/audit-results.mjs'));
  assert.ok(files.includes('docs/upgrade.md'));
  assert.ok(files.includes('docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md'));
});
