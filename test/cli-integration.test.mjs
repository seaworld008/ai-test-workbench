import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sanitizeStagedContent } from '../src/agents.mjs';
import { runCli } from '../src/cli.mjs';
import { detectProjectStack, inspectHostIsolation } from '../src/init.mjs';

test('sanitizeStagedContent replaces forward, backslash, and JSON-escaped temp paths and prevents leaks', () => {
  const tempDir = path.join(os.tmpdir(), 'aitest-agents-codex-12345');
  const qaDir = path.resolve('E:\\repo with spaces\\项目\\qa');

  const raw = JSON.stringify({
    fwd: tempDir.replace(/\\/g, '/') + '/playwright.config.ts',
    back: tempDir.replace(/\//g, '\\') + '\\playwright.config.ts',
  });

  const clean = sanitizeStagedContent(raw, tempDir, qaDir);
  assert.equal(clean.includes('aitest-agents-'), false);
  assert.equal(clean.includes('repo with spaces'), true);
});

test('detectProjectStack and inspectHostIsolation detect Next.js, Vitest, and root config overlap', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-hostcheck-'));
  try {
    fs.writeFileSync(
      path.join(tmpDir, 'package.json'),
      JSON.stringify({ dependencies: { next: '16.2.6' }, devDependencies: { vitest: '^4.1.7' } }),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'tsconfig.json'),
      JSON.stringify({ include: ['**/*.ts', '**/*.tsx'], exclude: ['node_modules'] }),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpDir, 'eslint.config.mjs'), 'export default [];', 'utf8');

    const stacks = detectProjectStack(tmpDir);
    assert.deepEqual(stacks, ['Next.js', 'Vitest']);

    const advisories = inspectHostIsolation(tmpDir, 'qa');
    assert.equal(advisories.length, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('CLI init supports paths with spaces & Chinese characters, renames gitignore -> .gitignore, updates lockfile names, and is idempotent', async () => {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-cli-'));
  const targetRepo = path.join(baseTmp, '示例 业务 项目 Alpha');
  fs.mkdirSync(targetRepo, { recursive: true });
  fs.writeFileSync(path.join(targetRepo, 'package.json'), JSON.stringify({ dependencies: { vue: '^3.5.0' } }), 'utf8');

  try {
    const dryCode = await runCli([
      'init',
      '--name',
      'alpha-portal',
      '--target',
      targetRepo,
      '--dry-run',
      '--lang',
      'en',
    ]);
    assert.equal(dryCode, 0);
    assert.equal(fs.existsSync(path.join(targetRepo, 'qa')), false);

    const initCode = await runCli([
      'init',
      '--name',
      'alpha-portal',
      '--target',
      targetRepo,
      '--skip-install',
      '--loop',
      'none',
      '--lang',
      'en',
    ]);
    assert.equal(initCode, 0);

    const qaDir = path.join(targetRepo, 'qa');
    assert.equal(fs.existsSync(path.join(qaDir, '.gitignore')), true);
    assert.equal(fs.existsSync(path.join(qaDir, 'gitignore')), false);
    assert.equal(fs.existsSync(path.join(qaDir, 'tests', 'api', 'health.spec.ts')), true);

    const qaPkg = JSON.parse(fs.readFileSync(path.join(qaDir, 'package.json'), 'utf8'));
    assert.equal(qaPkg.name, 'alpha-portal-qa');

    const qaLock = JSON.parse(fs.readFileSync(path.join(qaDir, 'package-lock.json'), 'utf8'));
    assert.equal(qaLock.name, 'alpha-portal-qa');
    assert.equal(qaLock.packages[''].name, 'alpha-portal-qa');

    const seedPath = path.join(qaDir, 'tests', 'seed.spec.ts');
    const customSeed = '// USER CUSTOMIZED SEED\n' + fs.readFileSync(seedPath, 'utf8');
    fs.writeFileSync(seedPath, customSeed, 'utf8');

    const secondInit = await runCli([
      'init',
      '--name',
      'alpha-portal',
      '--target',
      targetRepo,
      '--skip-install',
      '--loop',
      'none',
      '--lang',
      'en',
    ]);
    assert.equal(secondInit, 0);
    assert.equal(fs.readFileSync(seedPath, 'utf8'), customSeed);
  } finally {
    fs.rmSync(baseTmp, { recursive: true, force: true });
  }
});

test('CLI init --preset demo-campus overlays Smart Campus E2E and API specs', async () => {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-preset-'));
  try {
    const code = await runCli([
      'init',
      '--name',
      'campus-demo',
      '--target',
      baseTmp,
      '--preset',
      'demo-campus',
      '--skip-install',
      '--loop',
      'none',
      '--lang',
      'en',
    ]);
    assert.equal(code, 0);
    assert.equal(fs.existsSync(path.join(baseTmp, 'qa', 'tests', 'e2e', 'campus-portal.spec.ts')), true);
    assert.equal(fs.existsSync(path.join(baseTmp, 'qa', 'tests', 'api', 'courses.spec.ts')), true);
  } finally {
    fs.rmSync(baseTmp, { recursive: true, force: true });
  }
});

test('CLI init refuses to overwrite existing non-Playwright qa/ directory', async () => {
  const baseTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-conflict-'));
  const qaDir = path.join(baseTmp, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, 'manual-checklist.xlsx'), 'binary-placeholder', 'utf8');

  try {
    const code = await runCli(['init', '--target', baseTmp, '--skip-install', '--loop', 'none', '--lang', 'en']);
    assert.equal(code, 2);
  } finally {
    fs.rmSync(baseTmp, { recursive: true, force: true });
  }
});
