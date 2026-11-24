import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLI_COMMANDS, runCli } from '../../src/cli.mjs';
import { McpJobManager } from '../../src/jobs.mjs';
import {
  DEPRECATED_TOOL_ALIASES,
  TOOL_REGISTRY,
  getMcpToolDefinitions,
  handleMcpJsonRpcMessage,
} from '../../src/mcp-server.mjs';

test('MCP v6 tool surface exposes 17 canonical tools and forwards all 6 deprecated v5 aliases with warnings', async () => {
  const defs = getMcpToolDefinitions('2025-11-25');
  assert.equal(defs.length, 17);
  assert.equal(TOOL_REGISTRY.length, 17);

  const names = new Set(defs.map((d) => d.name));
  assert.equal(names.has('aitest_heal'), true);
  assert.equal(names.has('aitest_job'), true);
  assert.equal(names.has('aitest_verify_change'), true);
  for (const deprecated of Object.keys(DEPRECATED_TOOL_ALIASES)) {
    assert.equal(names.has(deprecated), false, `Deprecated v5 tool ${deprecated} must not appear in tools/list`);
  }

  // Verify canonical aitest_job(status/result/cancel) AND deprecated v5 job aliases
  const jm = new McpJobManager();
  const bg = await jm.executeOrBackground({
    toolName: 'synthetic_job',
    cliArgs: [],
    syncBudgetMs: 50,
    customCommand: {
      command: process.execPath,
      args: ['-e', 'setTimeout(() => console.log(JSON.stringify({ ok: true, done: 1 })), 500);'],
    },
  });
  assert.equal(bg.backgrounded, true);
  const jobId = bg.job.jobId;

  const canonStatus = await handleMcpJsonRpcMessage(
    { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'aitest_job', arguments: { action: 'status', jobId } } },
    { jobManager: jm }
  );
  assert.equal(canonStatus.result.structuredContent.ok, true);
  assert.equal(canonStatus.result.structuredContent.data._deprecation, undefined);

  const legacyStatus = await handleMcpJsonRpcMessage(
    { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'aitest_job_status', arguments: { jobId } } },
    { jobManager: jm }
  );
  assert.equal(legacyStatus.result.structuredContent.ok, true);
  assert.equal(legacyStatus.result.structuredContent.data._deprecation.deprecatedTool, 'aitest_job_status');
  assert.equal(legacyStatus.result.structuredContent.data._deprecation.replacement, 'aitest_job(action="status")');
  assert.match(legacyStatus.result.structuredContent.summary, /DEPRECATED aitest_job_status/);

  const canonResult = await handleMcpJsonRpcMessage(
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'aitest_job', arguments: { action: 'result', jobId, waitMs: 3000 } } },
    { jobManager: jm }
  );
  assert.equal(canonResult.result.structuredContent.ok, true);
  assert.equal(canonResult.result.structuredContent.data.status, 'succeeded');

  const legacyCancel = await handleMcpJsonRpcMessage(
    { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'aitest_job_cancel', arguments: { jobId } } },
    { jobManager: jm }
  );
  assert.equal(legacyCancel.result.structuredContent.ok, true);
  assert.equal(legacyCancel.result.structuredContent.data._deprecation.replacement, 'aitest_job(action="cancel")');

  // Verify aitest_heal cross-field validation: attempt/conclude require sessionId
  const missingSession = await handleMcpJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'aitest_heal', arguments: { action: 'attempt', target: process.cwd() } },
    },
    { workspaceRoots: [process.cwd()] }
  );
  assert.equal(missingSession.result.isError, true);
  assert.match(missingSession.result.structuredContent.summary, /Schema Validation Failed/);

  // Deprecated aitest_heal_attempt without sessionId still enforces validation AND reports deprecation metadata
  const legacyMissingSession = await handleMcpJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'aitest_heal_attempt', arguments: { target: process.cwd() } },
    },
    { workspaceRoots: [process.cwd()] }
  );
  assert.equal(legacyMissingSession.result.isError, true);
  assert.equal(legacyMissingSession.result.structuredContent.data._deprecation.replacement, 'aitest_heal(action="attempt")');
});

test('CLI per-command strict option tables reject unrelated cross-command flags and support deprecated --approver alias', async () => {
  assert.ok(Object.keys(CLI_COMMANDS).length >= 22);

  // 1. Cross-command unrelated flags are rejected with exit 1
  const badDoctor = await runCli(['doctor', '--suite', 'smoke']);
  assert.equal(badDoctor, 1, 'doctor must reject --suite (belongs to run)');

  const badFlaky = await runCli(['flaky', '--max-pages', '5']);
  assert.equal(badFlaky, 1, 'flaky must reject --max-pages (belongs to explore)');

  const badUnknown = await runCli(['totally-unknown-cmd']);
  assert.equal(badUnknown, 1);

  // 2. Per-command --help exits 0
  assert.equal(await runCli(['doctor', '--help']), 0);
  assert.equal(await runCli(['governance', '--help']), 0);

  // 3. Deprecated --approver alias on `governance approve` maps to --by with deprecation warning on stderr
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-cli-approver-'));
  const origErr = console.error;
  const stderrLines = [];
  console.error = (...args) => stderrLines.push(args.join(' '));
  try {
    await runCli(['init', '--name', 'approver-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const cfgPath = path.join(tmpRepo, 'qa', 'aitest.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.maxFlaky = 1;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const prevMcp = process.env.AITEST_MCP_SUBPROCESS;
    delete process.env.AITEST_MCP_SUBPROCESS;
    try {
      const approveCode = await runCli([
        'governance',
        'approve',
        '--target',
        tmpRepo,
        '--approver',
        'alice@example.com',
        '--reason',
        'legacy flag migration test',
        '--json',
      ]);
      assert.equal(approveCode, 0);
      assert.ok(
        stderrLines.some((l) => /DEPRECATED.*--approver.*--by/.test(l)),
        `Expected deprecation warning for --approver, got: ${stderrLines.join('\n')}`
      );
    } finally {
      if (prevMcp !== undefined) process.env.AITEST_MCP_SUBPROCESS = prevMcp;
    }
  } finally {
    console.error = origErr;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
