import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  SUPPORTED_LOOPS,
  loadAgentsManifest,
  resolveQaDirectory,
  runUpdateAgents,
  sanitizeStagedContent,
  saveAgentsManifest,
  sha256Text,
} from '../../src/agents.mjs';
import { runAuthLoginCommand, validateLoopbackCdpUrl } from '../../src/auth-login.mjs';
import { runCli } from '../../src/cli.mjs';
import {
  findExecutable,
  killProcessTree,
  probeToolVersion,
  resolveNpmCliPath,
  runProcess,
} from '../../src/core/proc.mjs';
import {
  detectHostGateKernelVersion,
  getBrowserCacheCandidates,
  inspectBrowserCache,
  runDoctor,
} from '../../src/doctor.mjs';
import { runReportCommand } from '../../src/report.mjs';
import { resolveSkillDestination, runSkillInstallCommand } from '../../src/skill-install.mjs';
import {
  buildRequirementTraceMatrix,
  renderTraceMatrixMarkdown,
  runTraceMatrixCommand,
} from '../../src/traceability.mjs';

test('doctor: inspects environment, browser cache, and detects host Gate Kernel version drift', async () => {
  const candidates = getBrowserCacheCandidates();
  assert.ok(Array.isArray(candidates) && candidates.length >= 1);
  const cacheInfo = inspectBrowserCache();
  assert.equal(typeof cacheInfo.exists, 'boolean');

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-doc-unit-'));
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => logs.push(a.join(' '));
  try {
    await runCli(['init', '--name', 'doc-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Run doctor without target (text mode) and with target (json mode)
    const plainCode = await runDoctor({ lang: 'en', json: false });
    assert.equal(plainCode, 0);

    logs.length = 0;
    const jsonCode = await runDoctor({ target: tmpRepo, lang: 'zh', json: true });
    assert.equal(jsonCode, 0);
    const parsed = JSON.parse(logs.join('\n'));
    assert.equal(parsed.ok, true);
    assert.ok(parsed.checks.some((c) => c.name === 'Gate Kernel Version' && c.status === 'OK'));

    // Simulate outdated host gate kernel -> doctor reports drift warning!
    const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
    const manifestObj = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifestObj.gateKernelVersion = '4.0.0';
    manifestObj.workbenchVersion = '4.0.0';
    fs.writeFileSync(manifestPath, JSON.stringify(manifestObj, null, 2), 'utf8');
    assert.equal(detectHostGateKernelVersion(qaDir).version, '4.0.0');

    logs.length = 0;
    await runDoctor({ target: tmpRepo, lang: 'en', json: true });
    const drifted = JSON.parse(logs.join('\n'));
    assert.ok(drifted.checks.some((c) => c.name === 'Gate Kernel Version' && c.status === 'WARN'));
  } finally {
    console.log = origLog;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('agents: resolveQaDirectory, manifest persistence, and update-agents error/dry-run paths', async () => {
  assert.ok(SUPPORTED_LOOPS.includes('codex'));
  assert.equal(sha256Text('abc').length, 64);

  const fakeStage = path.join(os.tmpdir(), 'aitest-agents-stage-123');
  const fakeQa = path.join(os.tmpdir(), 'my-app', 'qa');
  const sanitized = sanitizeStagedContent(`config: "${fakeStage.replace(/\\/g, '/')}/playwright.config.ts"`, fakeStage, fakeQa);
  assert.equal(sanitized.includes('aitest-agents-'), false);

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-agents-unit-'));
  try {
    assert.equal(resolveQaDirectory(tmpRepo), null);
    await runCli(['init', '--name', 'agents-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    assert.equal(resolveQaDirectory(tmpRepo), qaDir);
    assert.equal(resolveQaDirectory(qaDir), qaDir);
    assert.equal(resolveQaDirectory(tmpRepo, 'qa'), qaDir);

    const manifest = loadAgentsManifest(qaDir);
    assert.equal(manifest.version, 1);
    saveAgentsManifest(qaDir, { ...manifest, files: { '.mcp.json': { sha256: sha256Text('{}'), updatedAt: new Date().toISOString() } } });
    const reloaded = loadAgentsManifest(qaDir);
    assert.equal(reloaded.files['.mcp.json'].sha256, sha256Text('{}'));

    // Guard paths on runUpdateAgents
    assert.equal(await runUpdateAgents({ lang: 'en' }), 1);
    assert.equal(await runUpdateAgents({ target: path.join(tmpRepo, 'missing'), lang: 'zh' }), 1);
    assert.equal(await runUpdateAgents({ target: tmpRepo, loop: 'none', lang: 'en' }), 0);
    assert.equal(await runUpdateAgents({ target: tmpRepo, loop: 'invalid-loop', lang: 'en' }), 1);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('report, skill-install, traceability & auth-login guards cover full CLI branches', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-ws-cmds-'));
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = () => {};

  try {
    // 1. Missing target / missing QA directory guards
    assert.equal(await runReportCommand({ lang: 'en' }), 1);
    assert.equal(await runReportCommand({ target: tmpRepo, lang: 'zh' }), 1);
    assert.equal(await runSkillInstallCommand({ lang: 'en' }), 1);
    assert.equal(await runTraceMatrixCommand({ lang: 'en' }), 1);
    assert.equal(await runTraceMatrixCommand({ target: tmpRepo, lang: 'en' }), 1);
    assert.equal(await runAuthLoginCommand({ lang: 'en' }), 1);
    assert.equal(await runAuthLoginCommand({ target: tmpRepo, lang: 'zh' }), 1);

    await runCli(['init', '--name', 'ws-cmds-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // 2. report: finds nested trace.zip and prints both JSON and text summaries
    const traceDir = path.join(qaDir, 'test-results', 'run-1');
    fs.mkdirSync(traceDir, { recursive: true });
    fs.writeFileSync(path.join(traceDir, 'trace.zip'), 'PK', 'utf8');
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'reports', 'results.json'), '{"suites":[]}', 'utf8');

    logs.length = 0;
    assert.equal(await runReportCommand({ target: tmpRepo, json: true, lang: 'en' }), 0);
    const repJson = JSON.parse(logs.join('\n'));
    assert.equal(repJson.traces.length, 1);
    assert.ok(repJson.resultsJson);

    assert.equal(await runReportCommand({ target: tmpRepo, json: false, lang: 'zh' }), 0);
    assert.equal(await runReportCommand({ target: tmpRepo, json: false, lang: 'en' }), 0);

    // 3. skill-install across all 6 clients, dry-run, skip existing, force overwrite, invalid client
    for (const client of ['qa', 'codex', 'claude', 'agents', 'gemini', 'copilot']) {
      const dest = resolveSkillDestination(tmpRepo, client);
      assert.ok(dest.includes('ai-test-workbench'));
    }
    assert.throws(() => resolveSkillDestination(tmpRepo, 'unknown-client'));
    await assert.rejects(() => runSkillInstallCommand({ target: tmpRepo, client: 'unknown-client', lang: 'en' }));
    assert.equal(await runSkillInstallCommand({ target: tmpRepo, client: 'codex', dryRun: true, json: true }), 0);
    assert.equal(await runSkillInstallCommand({ target: tmpRepo, client: 'codex', json: true }), 0);
    assert.equal(await runSkillInstallCommand({ target: tmpRepo, client: 'codex', json: false, lang: 'zh' }), 0);
    assert.equal(await runSkillInstallCommand({ target: tmpRepo, client: 'codex', force: true, json: false, lang: 'en' }), 0);

    // 4. traceability: REQ-xxx matrix generation (dry-run + write + zh/en rendering)
    fs.writeFileSync(
      path.join(qaDir, 'specs', 'checkout.md'),
      '# Checkout\n- [REQ-CHK-001] Validate cart total\n- [REQ-CHK-002] Uncovered flow\n',
      'utf8'
    );
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'checkout.spec.ts'),
      "import { test, expect } from '../fixtures/base';\ntest('[REQ-CHK-001] cart total', async ({ page }) => { await expect(page).toHaveURL(/cart/); });\n",
      'utf8'
    );
    const matrix = buildRequirementTraceMatrix(qaDir);
    assert.ok(matrix.totalRequirements >= 2);
    assert.ok(renderTraceMatrixMarkdown(matrix, 'zh').includes('REQ-CHK-001'));
    assert.ok(renderTraceMatrixMarkdown(matrix, 'en').includes('REQ-CHK-002'));

    logs.length = 0;
    assert.equal(await runTraceMatrixCommand({ target: tmpRepo, dryRun: true, json: true }), 0);
    assert.equal(fs.existsSync(path.join(qaDir, 'reports', 'trace-matrix.md')), false);

    assert.equal(await runTraceMatrixCommand({ target: tmpRepo, dryRun: false, json: false, lang: 'zh' }), 0);
    assert.equal(fs.existsSync(path.join(qaDir, 'reports', 'trace-matrix.md')), true);
    assert.equal(await runTraceMatrixCommand({ target: tmpRepo, dryRun: false, json: false, lang: 'en' }), 0);

    // 5. auth-login: loopback validation & target guard blocks
    assert.equal(validateLoopbackCdpUrl('').ok, false);
    assert.equal(validateLoopbackCdpUrl('not-a-url').ok, false);
    assert.equal(validateLoopbackCdpUrl('ftp://127.0.0.1:9222').ok, false);
    assert.equal(validateLoopbackCdpUrl('http://10.0.0.5:9222').ok, false);
    assert.equal(validateLoopbackCdpUrl('http://127.0.0.1:9222').ok, true);
    assert.equal(validateLoopbackCdpUrl('ws://[::1]:9222/devtools/browser').ok, true);

    // Missing playwright package in fresh --skip-install qaDir returns 1
    assert.equal(await runAuthLoginCommand({ target: tmpRepo, baseUrl: 'https://prod.example.com', lang: 'en' }), 1);
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('core/proc: findExecutable, resolveNpmCliPath, probeToolVersion, runProcess & killProcessTree', async () => {
  assert.ok(await findExecutable('node'));
  assert.equal(await findExecutable('definitely_nonexistent_binary_xyz_999'), null);
  assert.ok(resolveNpmCliPath());

  const nodeVer = await probeToolVersion('node', ['--version']);
  assert.equal(nodeVer.installed, true);
  assert.match(nodeVer.version || '', /v?\d+\./);

  const okRes = await runProcess(process.execPath, ['-e', 'console.log("hello-proc")'], { capture: true });
  assert.equal(okRes.code, 0);
  assert.equal(okRes.stdout.trim(), 'hello-proc');

  const errRes = await runProcess(process.execPath, ['-e', 'console.error("boom"); process.exit(3)'], { capture: true });
  assert.equal(errRes.code, 3);
  assert.match(errRes.stderr, /boom/);

  const timeoutRes = await runProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    capture: true,
    timeoutMs: 120,
  });
  assert.equal(timeoutRes.timedOut, true);
  assert.notEqual(timeoutRes.code, 0);

  // killProcessTree handles null/invalid pids gracefully without throwing
  killProcessTree(0);
  killProcessTree(undefined);
});
