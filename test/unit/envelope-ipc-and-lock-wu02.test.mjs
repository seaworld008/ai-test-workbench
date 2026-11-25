import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT, SCHEMA_VERSIONS, WORKBENCH_VERSION, resolveWorkspace } from '../../src/app/index.mjs';
import { runCli } from '../../src/cli.mjs';
import { loadWorkbenchConfig } from '../../src/core/config.mjs';
import { acquireDiskLock } from '../../src/core/disk-lock.mjs';
import { McpJobManager } from '../../src/jobs.mjs';
import { readEnvFileIfPresent } from '../../src/kernel/target-guard.mjs';
import { handleMcpJsonRpcMessage } from '../../src/mcp-server.mjs';

test('WU-02: CLI --json usage errors and missing required --target exit 64 with v2 CommandResult + --version', async () => {
  const logs = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = () => {};
  try {
    // 1. Unknown command with --json
    const unkCode = await runCli(['no-such-cmd', '--json']);
    assert.equal(unkCode, 64);
    const unkEnv = JSON.parse(logs.join('\n'));
    assert.equal(unkEnv.schemaVersion, SCHEMA_VERSIONS.resultEnvelope);
    assert.equal(unkEnv.ok, false);
    assert.equal(unkEnv.exitCode, 64);
    assert.equal(unkEnv.outcome, 'usage');
    assert.equal(unkEnv.blockerKind, 'USAGE_ERROR');
    assert.equal(unkEnv.recoverable, true);
    assert.ok(Array.isArray(unkEnv.recoverySteps) && unkEnv.recoverySteps.length >= 1);

    // 2. Missing mandatory --target on CLI with --json
    logs.length = 0;
    const missTargetCode = await runCli(['audit', '--json']);
    assert.equal(missTargetCode, 64);
    const missEnv = JSON.parse(logs.join('\n'));
    assert.equal(missEnv.exitCode, 64);
    assert.equal(missEnv.outcome, 'usage');

    // 3. --version and -V print exact WORKBENCH_VERSION
    logs.length = 0;
    assert.equal(await runCli(['-V']), 0);
    assert.equal(logs[0].trim(), WORKBENCH_VERSION);

    logs.length = 0;
    assert.equal(await runCli(['--version', '--json']), 0);
    const verJson = JSON.parse(logs.join('\n'));
    assert.equal(verJson.data.version, WORKBENCH_VERSION);
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test('WU-02: Framed AITEST_RESULT_FILE IPC delivers deterministic aitest_doctor summary (never "]")', async () => {
  const mcpCtx = { workspaceRoots: [REPO_ROOT], jobManager: new McpJobManager() };
  const reply = await handleMcpJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'aitest_doctor', arguments: { lang: 'en' } },
    },
    mcpCtx
  );
  const sc = reply.result.structuredContent;
  assert.equal(sc.schemaVersion, 2);
  assert.equal(sc.tool, 'aitest_doctor');
  assert.notEqual(sc.summary, ']');
  assert.match(sc.summary, /^Doctor checked \d+ items: OK=\d+, WARN=\d+, FAIL=\d+/);
  assert.ok(Array.isArray(sc.data.checks));
});

test('WU-02: Atomic acquireDiskLock preserves partial concurrent locks and fails closed with WORKSPACE_LOCK_BUSY', async () => {
  const tmpQa = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-wu02-lock-'));
  const aitestDir = path.join(tmpQa, '.aitest');
  fs.mkdirSync(aitestDir, { recursive: true });
  const lockFile = path.join(aitestDir, '.write.lock');

  try {
    // 1. Live holder -> timeout returns WORKSPACE_LOCK_BUSY
    const first = await acquireDiskLock(tmpQa, 1000);
    assert.equal(first.ok, true);
    const busy = await acquireDiskLock(tmpQa, 120);
    assert.equal(busy.ok, false);
    assert.equal(busy.reason, 'WORKSPACE_LOCK_BUSY');
    if (first.ok) first.release();
    assert.equal(fs.existsSync(lockFile), false);

    // 2. Partial/non-JSON fresh lock file must NEVER be unlinked on JSON.parse error
    fs.writeFileSync(lockFile, '{"pid":', 'utf8');
    const partialRes = await acquireDiskLock(tmpQa, 120);
    assert.equal(partialRes.ok, false);
    assert.equal(partialRes.reason, 'WORKSPACE_LOCK_BUSY');
    assert.equal(fs.existsSync(lockFile), true, 'Fresh unparseable lock file must not be unlinked prematurely');
    fs.rmSync(lockFile, { force: true });

    // 3. Dead PID lock file IS cleanly reaped
    fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, acquiredAt: new Date().toISOString() }), 'utf8');
    const recovered = await acquireDiskLock(tmpQa, 500);
    assert.equal(recovered.ok, true);
    if (recovered.ok) recovered.release();
  } finally {
    fs.rmSync(tmpQa, { recursive: true, force: true });
  }
});

test('WU-02: readEnvFileIfPresent is pure, loadWorkbenchConfig exposes explicit caller, and resolveWorkspace works', () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-wu02-cfg-'));
  const qaDir = path.join(tmpRepo, 'qa');
  fs.mkdirSync(qaDir, { recursive: true });
  fs.writeFileSync(path.join(qaDir, 'playwright.config.ts'), 'export default {};\n', 'utf8');
  fs.writeFileSync(path.join(qaDir, '.env'), 'WU02_PURE_ENV_TEST=should-not-leak\nTEST_ENV=local\n', 'utf8');

  try {
    delete process.env.WU02_PURE_ENV_TEST;
    const parsed = readEnvFileIfPresent(path.join(qaDir, '.env'));
    assert.equal(parsed.WU02_PURE_ENV_TEST, 'should-not-leak');
    assert.equal(process.env.WU02_PURE_ENV_TEST, undefined, 'readEnvFileIfPresent must never mutate process.env');

    const ws = resolveWorkspace(tmpRepo);
    assert.equal(ws.repoDir, tmpRepo);
    assert.equal(ws.qaDir, qaDir);

    const cleanEnv = { ...process.env };
    delete cleanEnv.CI;
    delete cleanEnv.GITHUB_ACTIONS;
    delete cleanEnv.GITLAB_CI;
    delete cleanEnv.TF_BUILD;
    delete cleanEnv.BUILDKITE;
    delete cleanEnv.CIRCLECI;
    delete cleanEnv.AITEST_MCP_CHILD;

    const cfgCli = loadWorkbenchConfig({ qaDir, env: cleanEnv });
    assert.equal(cfgCli.caller, 'human-cli');

    const cfgMcp = loadWorkbenchConfig({ qaDir, env: { ...cleanEnv, AITEST_MCP_CHILD: '1' } });
    assert.equal(cfgMcp.caller, 'mcp-child');

    const cfgCi = loadWorkbenchConfig({ qaDir, env: { ...cleanEnv, CI: 'true' } });
    assert.equal(cfgCi.caller, 'ci');
  } finally {
    delete process.env.WU02_PURE_ENV_TEST;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
