import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT, WORKBENCH_VERSION } from '../../src/core/version.mjs';
import { detectHostGateKernelVersion } from '../../src/doctor.mjs';
import { runInit } from '../../src/init.mjs';
import { GATE_KERNEL_VERSION } from '../../src/kernel/index.mjs';
import { readTemplateManifest, runUpgradeCommand, upgradeQaWorkspace } from '../../src/upgrade.mjs';

test('package.json exports map to authoritative src/kernel modules and vendored support runs standalone', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.exports['.'], './src/kernel/index.mjs');
  assert.equal(pkg.exports['./kernel'], './src/kernel/index.mjs');
  assert.equal(pkg.exports['./target-guard'], './src/kernel/target-guard.mjs');
  assert.equal(pkg.exports['./schema-validator'], './src/kernel/schema-validator.mjs');

  for (const targetRel of Object.values(pkg.exports)) {
    assert.ok(fs.existsSync(path.join(REPO_ROOT, String(targetRel))), `Missing export target: ${targetRel}`);
  }

  // Verify vendored template support/gate-kernel.mjs loads standalone and matches WORKBENCH_VERSION
  const vendoredKernelUrl = pathToFileURL(
    path.join(REPO_ROOT, 'templates', 'playwright-qa', 'support', 'gate-kernel.mjs')
  ).href;
  const vendored = await import(vendoredKernelUrl);
  assert.equal(vendored.GATE_KERNEL_VERSION, WORKBENCH_VERSION);
  assert.equal(GATE_KERNEL_VERSION, WORKBENCH_VERSION);
  assert.equal(typeof vendored.runAuditForQaDir, 'function');

  // Verify template package.json version stays synced (fixes v5.0.0 drift)
  const tplPkg = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'templates', 'playwright-qa', 'package.json'), 'utf8')
  );
  assert.equal(tplPkg.version, WORKBENCH_VERSION);
});

test('doctor detectHostGateKernelVersion accurately reads manifest, vendored engine, and legacy kernel', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-doctor-kernel-'));
  try {
    // Missing kernel
    assert.deepEqual(detectHostGateKernelVersion(tmp), { present: false, version: 'missing', source: 'none' });

    // Legacy single-file support/gate-kernel.mjs
    fs.mkdirSync(path.join(tmp, 'support', 'gate'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'support', 'gate-kernel.mjs'),
      "export const GATE_KERNEL_VERSION = '4.9.0';\n",
      'utf8'
    );
    assert.equal(detectHostGateKernelVersion(tmp).version, '4.9.0');

    // v5.1 modular support/gate/engine.mjs (where old doctor.mjs returned 'unknown')
    fs.writeFileSync(
      path.join(tmp, 'support', 'gate-kernel.mjs'),
      "export { GATE_KERNEL_VERSION } from './gate/engine.mjs';\n",
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmp, 'support', 'gate', 'engine.mjs'),
      "export const GATE_KERNEL_VERSION = '5.1.1';\n",
      'utf8'
    );
    assert.equal(detectHostGateKernelVersion(tmp).version, '5.1.1');

    // v6 manifest takes precedence
    fs.mkdirSync(path.join(tmp, '.aitest'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, '.aitest', 'template-manifest.json'),
      JSON.stringify({ schemaVersion: 1, workbenchVersion: '6.0.0', gateKernelVersion: '6.0.0', files: {} }),
      'utf8'
    );
    assert.equal(detectHostGateKernelVersion(tmp).version, '6.0.0');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('init writes .aitest/template-manifest.json and upgrade performs safe 3-way merge without touching governance.lock', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-upgrade-e2e-'));
  try {
    const initCode = await runInit({
      target: repoDir,
      skipInstall: true,
      skipBrowser: true,
      loop: 'none',
      lang: 'en',
    });
    assert.equal(initCode, 0);

    const qaDir = path.join(repoDir, 'qa');
    const manifest = readTemplateManifest(qaDir);
    assert.ok(manifest, 'init must create .aitest/template-manifest.json');
    assert.equal(manifest.workbenchVersion, WORKBENCH_VERSION);
    assert.ok(manifest.files?.['support/gate-kernel.mjs']?.startsWith('sha256:'));
    assert.equal(detectHostGateKernelVersion(qaDir).version, WORKBENCH_VERSION);

    const lockBefore = fs.readFileSync(path.join(qaDir, '.aitest', 'governance.lock'), 'utf8');

    // 1. Already up to date -> 0 changes, 0 conflicts
    const noopRes = upgradeQaWorkspace(qaDir);
    assert.equal(noopRes.ok, true);
    assert.equal(noopRes.changedCount, 0);
    assert.equal(noopRes.conflictCount, 0);
    assert.equal(noopRes.requiresGovernanceApprove, false);

    // 2. Simulate an older unmodified vendored file (matching recorded manifest hash) -> clean UPDATE
    const kernelFile = path.join(qaDir, 'support', 'gate-kernel.mjs');
    const oldKernelContent = '// old vendored kernel\n';
    fs.writeFileSync(kernelFile, oldKernelContent, 'utf8');
    // Update manifest to reflect the "previously installed" hash
    const crypto = await import('node:crypto');
    const oldHash = `sha256:${crypto.createHash('sha256').update(oldKernelContent).digest('hex')}`;
    const updatedManifest = { ...manifest, gateKernelVersion: '5.0.0', files: { ...manifest.files, 'support/gate-kernel.mjs': oldHash } };
    fs.writeFileSync(path.join(qaDir, '.aitest', 'template-manifest.json'), JSON.stringify(updatedManifest, null, 2));

    // Dry-run must NOT modify disk
    const dryRes = upgradeQaWorkspace(qaDir, { dryRun: true });
    assert.equal(dryRes.changedCount, 1);
    assert.equal(dryRes.requiresGovernanceApprove, true);
    assert.equal(fs.readFileSync(kernelFile, 'utf8'), oldKernelContent);

    // Real upgrade updates unmodified file cleanly and does NOT auto-approve governance.lock
    const upRes = upgradeQaWorkspace(qaDir);
    assert.equal(upRes.ok, true);
    assert.equal(upRes.changedCount, 1);
    assert.equal(upRes.requiresGovernanceApprove, true);
    assert.notEqual(fs.readFileSync(kernelFile, 'utf8'), oldKernelContent);
    assert.equal(fs.readFileSync(path.join(qaDir, '.aitest', 'governance.lock'), 'utf8'), lockBefore);

    // 3. Simulate human customization of support/target-guard.mjs -> CONFLICT + sidecar .aitest-new (preserves custom edit)
    const tgPath = path.join(qaDir, 'support', 'target-guard.mjs');
    const customContent = '// human-customized target guard\nexport const CUSTOM = true;\n';
    fs.writeFileSync(tgPath, customContent, 'utf8');

    const conflictRes = upgradeQaWorkspace(qaDir);
    assert.equal(conflictRes.ok, false);
    assert.equal(conflictRes.conflictCount, 1);
    assert.equal(fs.readFileSync(tgPath, 'utf8'), customContent, 'User customization must be preserved');
    assert.ok(fs.existsSync(`${tgPath}.aitest-new`), 'Incoming upgrade copy must be written to .aitest-new');

    // 4. --force via CLI overwrites cleanly
    const cliCode = await runUpgradeCommand({ target: repoDir, force: true, json: true, lang: 'en' });
    assert.equal(cliCode, 0);
    assert.notEqual(fs.readFileSync(tgPath, 'utf8'), customContent);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
