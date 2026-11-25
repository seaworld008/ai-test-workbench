import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CLI_COMMANDS, runCli } from '../../src/cli.mjs';
import { McpJobManager } from '../../src/jobs.mjs';
import { flattenPlaywrightResults } from '../../src/core/playwright-results.mjs';
import { redactSecrets } from '../../src/core/redact.mjs';
import {
  DEPRECATED_TOOL_ALIASES,
  TOOL_REGISTRY,
  getMcpToolDefinitions,
  handleMcpJsonRpcMessage,
} from '../../src/mcp-server.mjs';
import { upgradeQaWorkspace } from '../../src/upgrade.mjs';

test('MCP v6.2 tool surface exposes 16 canonical tools with 100% parameter descriptions and forwards all 8 deprecated aliases', async () => {
  const defs = getMcpToolDefinitions('2025-11-25');
  assert.equal(defs.length, 16);
  assert.equal(TOOL_REGISTRY.length, 16);

  const names = new Set(defs.map((d) => d.name));
  assert.equal(names.has('aitest_bootstrap'), true);
  assert.equal(names.has('aitest_report'), true);
  assert.equal(names.has('aitest_heal'), true);
  assert.equal(names.has('aitest_job'), true);
  assert.equal(names.has('aitest_verify_change'), true);
  for (const def of defs) {
    assert.match(def.description, /\bUse when\b/i, `Tool ${def.name} description should explain "Use when..."`);
    const props = def.inputSchema?.properties || {};
    for (const [propName, propSchema] of Object.entries(props)) {
      assert.ok(
        typeof propSchema.description === 'string' && propSchema.description.trim().length > 0,
        `Tool ${def.name}.${propName} missing non-empty parameter description`
      );
    }
  }
  for (const deprecated of Object.keys(DEPRECATED_TOOL_ALIASES)) {
    assert.equal(names.has(deprecated), false, `Deprecated tool ${deprecated} must not appear in tools/list`);
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

  // 1. Cross-command unrelated flags are rejected with exit 64 (USAGE)
  const badDoctor = await runCli(['doctor', '--suite', 'smoke']);
  assert.equal(badDoctor, 64, 'doctor must reject --suite (belongs to run)');

  const badFlaky = await runCli(['flaky', '--max-pages', '5']);
  assert.equal(badFlaky, 64, 'flaky must reject --max-pages (belongs to explore)');

  const badUnknown = await runCli(['totally-unknown-cmd']);
  assert.equal(badUnknown, 64);

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
        '--yes',
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

    // 4. `governance status --json` exits 2 (blocked) and emits `exitCode: 2` when governance.lock is missing
    const lockPath = path.join(tmpRepo, 'qa', '.aitest', 'governance.lock');
    fs.rmSync(lockPath, { force: true });
    const origLog = console.log;
    const stdoutLines = [];
    console.log = (...args) => stdoutLines.push(args.join(' '));
    try {
      const govBlockedCode = await runCli(['governance', 'status', '--target', tmpRepo, '--json']);
      assert.equal(govBlockedCode, 2, 'governance status must exit 2 on blocked status');
      const govJson = JSON.parse(stdoutLines.join('\n'));
      assert.equal(govJson.ok, false);
      assert.equal(govJson.status, 'blocked');
      assert.equal(govJson.exitCode, 2);
    } finally {
      console.log = origLog;
    }

    // 5. `explore` accepts positive boolean flags (--explore-portals/--explore-tabs/--explore-dialogs)
    assert.equal(await runCli(['explore', '--explore-portals', '--explore-tabs', '--explore-dialogs', '--help']), 0);

    // 6. Deprecated `aitest_flaky_report` and `aitest_trace_matrix` forward cleanly to `aitest_report`
    const flakyAlias = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'aitest_flaky_report', arguments: { target: tmpRepo } } },
      { workspaceRoots: [tmpRepo] }
    );
    assert.equal(flakyAlias.result.structuredContent.data._deprecation.replacement, 'aitest_report(view="flaky")');
    assert.match(flakyAlias.result.structuredContent.summary, /DEPRECATED aitest_flaky_report/);

    const traceAlias = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 8, method: 'tools/call', params: { name: 'aitest_trace_matrix', arguments: { target: tmpRepo } } },
      { workspaceRoots: [tmpRepo] }
    );
    assert.equal(traceAlias.result.structuredContent.data._deprecation.replacement, 'aitest_report(view="traceability")');

    // 7. VT ANSI stripping, POSIX testId normalization, and idempotent upgradeQaWorkspace
    assert.equal(redactSecrets('\x1b[31mError\x1b[0m \x1b]0;title\x07plain'), 'Error plain');
    assert.equal(redactSecrets('\x1b[31mFailed\x1b[0m {"apiKey":"secret_value_123"}'), 'Failed {"apiKey":"[REDACTED]"}');
    const flat = flattenPlaywrightResults({
      suites: [{ file: 'tests\\e2e\\login.spec.ts', specs: [{ title: 'dir\\case', line: 5, tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }],
    });
    assert.equal(flat[0].testId, 'tests/e2e/login.spec.ts::dir/case');

    const qaDir = path.join(tmpRepo, 'qa');
    const up1 = upgradeQaWorkspace(qaDir, { scope: 'kernel' });
    assert.equal(up1.ok, true);
    const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
    const beforeManifest = fs.readFileSync(manifestPath, 'utf8');
    await new Promise((r) => setTimeout(r, 15));
    const up2 = upgradeQaWorkspace(qaDir, { scope: 'kernel' });
    assert.equal(up2.changedCount, 0);
    assert.equal(fs.readFileSync(manifestPath, 'utf8'), beforeManifest);
  } finally {
    console.error = origErr;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
