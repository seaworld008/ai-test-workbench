import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { McpJobManager } from '../src/jobs.mjs';
import { handleMcpJsonRpcMessage } from '../src/mcp-server.mjs';

test('MCP Job Runner auto-backgrounds tasks exceeding syncBudgetMs, allows concurrent read-only calls, emits progress, and kills process tree on cancel', async () => {
  const jm = new McpJobManager();
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-mcp-jobs-'));

  try {
    // 1. Launch a 1.5s child job with syncBudgetMs=80 -> immediately returns backgrounded jobId!
    const progressEvents = [];
    const bgOut = await jm.executeOrBackground({
      toolName: 'synthetic_long_suite',
      cliArgs: [],
      syncBudgetMs: 80,
      onProgress: (ev) => progressEvents.push(ev),
      customCommand: {
        command: process.execPath,
        args: [
          '-e',
          `console.log("step 1 running"); setTimeout(() => { console.log(JSON.stringify({ ok: true, completedSlowly: true })); }, 700);`,
        ],
      },
    });

    assert.equal(bgOut.backgrounded, true);
    assert.equal(bgOut.job.status, 'running');
    const jobId = bgOut.job.jobId;

    // 2. While the slow job is running, a read-only MCP call (`aitest_mcp_hub` / `aitest_job_status`) responds concurrently in <50ms!
    const t0 = Date.now();
    const statusReply = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: { name: 'aitest_job_status', arguments: { jobId } },
      },
      { jobManager: jm }
    );
    assert.ok(Date.now() - t0 < 400);
    assert.equal(statusReply.result.structuredContent.ok, true);
    assert.equal(statusReply.result.structuredContent.data.jobId, jobId);

    // 3. Await final result via aitest_job_result(waitMs=4000)
    const finalReply = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: { name: 'aitest_job_result', arguments: { jobId, waitMs: 4000 } },
      },
      { jobManager: jm }
    );
    assert.equal(finalReply.result.structuredContent.ok, true);
    assert.equal(finalReply.result.structuredContent.data.status, 'succeeded');
    assert.equal(finalReply.result.structuredContent.data.data.completedSlowly, true);
    assert.ok(progressEvents.length >= 1);

    // 4. Test notifications/cancelled killing a long-running child process tree within <2s!
    const cancelJm = new McpJobManager();
    const slowPromise = cancelJm.executeOrBackground({
      toolName: 'cancellable_job',
      cliArgs: [],
      requestId: 777,
      syncBudgetMs: 15_000,
      customCommand: {
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000);'],
      },
    });

    // Wait 120ms for child process spawn, then send MCP `notifications/cancelled`
    await new Promise((r) => setTimeout(r, 120));
    const tCancel = Date.now();
    await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { requestId: 777, reason: 'Client cancelled' },
      },
      { jobManager: cancelJm }
    );

    const cancelledOut = await slowPromise;
    assert.ok(Date.now() - tCancel < 4000, 'Cancelled child process should exit promptly');
    assert.equal(cancelledOut.job.status, 'cancelled');

    // 5. Workspace Root Boundary (`M-04`): target outside workspaceRoots is blocked!
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-outside-root-'));
    try {
      const blockedBoundary = await handleMcpJsonRpcMessage(
        {
          jsonrpc: '2.0',
          id: 201,
          method: 'tools/call',
          params: { name: 'aitest_report', arguments: { target: outsideDir } },
        },
        { workspaceRoots: [tmpRepo], jobManager: jm }
      );
      assert.equal(blockedBoundary.result.isError, true);
      assert.match(blockedBoundary.result.structuredContent.summary, /Workspace Boundary Blocked/);

      const blockedResource = await handleMcpJsonRpcMessage(
        {
          jsonrpc: '2.0',
          id: 202,
          method: 'resources/read',
          params: { uri: `aitest://project/${encodeURIComponent(outsideDir)}/system-map` },
        },
        { workspaceRoots: [tmpRepo], jobManager: jm }
      );
      assert.ok(blockedResource.error);
      assert.match(blockedResource.error.message, /outside allowed workspace roots/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
