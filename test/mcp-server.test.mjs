import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  SUPPORTED_MCP_VERSIONS,
  createMcpHttpServer,
  getMcpPromptDefinitions,
  getMcpToolDefinitions,
  handleMcpJsonRpcMessage,
} from '../src/mcp-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..');

test('MCP server negotiates all supported protocol versions (2024-11-05 .. 2025-11-25) and exposes 21 typed tools (zero governance_approve)', async () => {
  for (const ver of SUPPORTED_MCP_VERSIONS) {
    const res = await handleMcpJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: ver, clientInfo: { name: 'unit-test', version: '1.0' } },
    });
    assert.equal(res.result.protocolVersion, ver);
    assert.equal(res.result.serverInfo.version, '5.0.0');
    assert.ok(res.result.capabilities.tools);
    assert.ok(res.result.capabilities.resources);
    assert.ok(res.result.capabilities.prompts);
  }

  const futureRes = await handleMcpJsonRpcMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'initialize',
    params: { protocolVersion: '2099-01-01' },
  });
  assert.equal(futureRes.result.protocolVersion, '2025-11-25');

  const tools = getMcpToolDefinitions();
  assert.equal(tools.length, 21);
  assert.equal(tools.some((t) => t.name === 'aitest_verify_change'), true);
  assert.equal(tools.some((t) => t.name === 'aitest_heal_begin'), true);
  assert.equal(tools.some((t) => t.name === 'aitest_job_status'), true);
  assert.equal(tools.some((t) => t.name.includes('governance')), false);

  for (const tool of tools) {
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    assert.ok(tool.annotations);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }

  // M-06: Verify accurate readOnlyHint annotations
  const exploreTool = tools.find((t) => t.name === 'aitest_explore');
  const doctorTool = tools.find((t) => t.name === 'aitest_doctor');
  assert.equal(exploreTool.annotations.readOnlyHint, false);
  assert.equal(doctorTool.annotations.readOnlyHint, true);

  const prompts = getMcpPromptDefinitions();
  assert.ok(prompts.length >= 5);
  const zhPrompt = await handleMcpJsonRpcMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'prompts/get',
    params: { name: 'first-time-onboarding', arguments: { target: '.' } },
  });
  assert.match(zhPrompt.result.messages[0].content.text, /[\u4e00-\u9fff]/);

  const enPrompt = await handleMcpJsonRpcMessage({
    jsonrpc: '2.0',
    id: 4,
    method: 'prompts/get',
    params: { name: 'first-time-onboarding', arguments: { target: '.', lang: 'en' } },
  });
  assert.match(enPrompt.result.messages[0].content.text, /Initialize AI Test Workbench/i);
});

test('MCP stdio transport emits pure NDJSON JSON-RPC frames across initialize, tools/call, progress & resources/read', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-mcp-stdio-'));
  let child = null;
  try {
    child = spawn(
      process.execPath,
      [path.join(WORKBENCH_ROOT, 'tools', 'aitest.mjs'), 'mcp-serve', '--workspace-root', tmpRepo],
      {
        cwd: WORKBENCH_ROOT,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true,
      }
    );

    const lines = [];
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const p of parts) {
        if (p.trim()) lines.push(JSON.parse(p));
      }
    });

    const sendAndWait = (msg, expectedId) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timeout waiting for MCP id=${expectedId}`)), 15000);
        const timer = setInterval(() => {
          const hit = lines.find((l) => l.id === expectedId);
          if (hit) {
            clearInterval(timer);
            clearTimeout(timeout);
            resolve(hit);
          }
        }, 20);
        child.stdin.write(JSON.stringify(msg) + '\n');
      });

    const initReply = await sendAndWait(
      {
        jsonrpc: '2.0',
        id: 10,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      },
      10
    );
    assert.equal(initReply.result.serverInfo.name, 'ai-test-workbench');

    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const logRes = await sendAndWait(
      { jsonrpc: '2.0', id: 11, method: 'logging/setLevel', params: { level: 'warning' } },
      11
    );
    assert.deepEqual(logRes.result, {});

    const initDryRes = await sendAndWait(
      {
        jsonrpc: '2.0',
        id: 12,
        method: 'tools/call',
        params: {
          name: 'aitest_init',
          arguments: { target: tmpRepo, dryRun: true, lang: 'zh' },
          _meta: { progressToken: 'prog-12' },
        },
      },
      12
    );
    assert.equal(initDryRes.result.isError, false);
    assert.equal(initDryRes.result.structuredContent.ok, true);
    assert.equal(initDryRes.result.structuredContent.tool, 'aitest_init');
    assert.ok(initDryRes.result.structuredContent.nextRecommendedActions.length >= 1);
    assert.equal(lines.some((l) => l.method === 'notifications/progress' && l.params?.progressToken === 'prog-12'), true);

    const presetRes = await sendAndWait(
      {
        jsonrpc: '2.0',
        id: 13,
        method: 'resources/read',
        params: { uri: 'aitest://mcp/presets' },
      },
      13
    );
    const presetJson = JSON.parse(presetRes.result.contents[0].text);
    assert.ok(presetJson.pillars.includes('orchestrator'));
    assert.ok(presetJson.presets['ai-test-workbench']);

    child.stdin.end();
    await new Promise((resolve) => child.once('close', resolve));
    assert.equal(buffer.trim(), '');
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
    }
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('MCP Streamable HTTP (/mcp) enforces initialize-only sessions, 404 on unknown session, protocol-aware batching, and Legacy SSE', async () => {
  assert.throws(() => createMcpHttpServer({ host: '0.0.0.0' }), /without --auth-token/);

  const server = createMcpHttpServer({ host: '127.0.0.1', authToken: 'tok-v5-test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);

    // DNS-rebinding Origin rejection (403)
    const badOrigin = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Authorization: 'Bearer tok-v5-test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(badOrigin.status, 403);

    // Auth rejection (401)
    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(unauth.status, 401);

    // M-05: Non-initialize POST or DELETE without valid Mcp-Session-Id returns 404!
    const noSessionPing = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-v5-test' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
    });
    assert.equal(noSessionPing.status, 404);

    const unknownDel = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-v5-test', 'Mcp-Session-Id': 'non-existent' },
    });
    assert.equal(unknownDel.status, 404);

    // Streamable HTTP initialize (2025-06-18) -> rejects JSON-RPC batch per MCP spec!
    const initModern = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-v5-test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    });
    assert.equal(initModern.status, 200);
    const sidModern = initModern.headers.get('mcp-session-id');
    assert.ok(sidModern);

    const sseToolRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer tok-v5-test',
        'Mcp-Session-Id': sidModern,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'aitest_mcp_hub', arguments: { action: 'presets' } },
      }),
    });
    assert.equal(sseToolRes.status, 200);
    const sseText = await sseToolRes.text();
    const dataLine = sseText.split(/\r?\n/).find((l) => l.startsWith('data: '));
    const parsedToolReply = JSON.parse(dataLine.slice(6));
    assert.equal(parsedToolReply.result.structuredContent.ok, true);

    const batchRejected = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-v5-test',
        'Mcp-Session-Id': sidModern,
      },
      body: JSON.stringify([{ jsonrpc: '2.0', id: 22, method: 'ping' }]),
    });
    assert.equal(batchRejected.status, 400);

    // 2025-03-26 session -> accepts JSON-RPC batch!
    const initLegacyBatch = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-v5-test' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 30,
        method: 'initialize',
        params: { protocolVersion: '2025-03-26' },
      }),
    });
    const sidBatch = initLegacyBatch.headers.get('mcp-session-id');
    const batchOkRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-v5-test',
        'Mcp-Session-Id': sidBatch,
      },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 31, method: 'ping' },
        { jsonrpc: '2.0', id: 32, method: 'tools/list' },
      ]),
    });
    assert.equal(batchOkRes.status, 200);
    const batchJson = await batchOkRes.json();
    assert.equal(batchJson.length, 2);
    assert.equal(batchJson[1].result.tools.length, 21);

    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-v5-test', 'Mcp-Session-Id': sidModern },
    });
    assert.equal(delRes.status, 200);

    // Legacy 2024-11-05 HTTP+SSE (/sse + /messages)
    await new Promise((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/sse`,
        { headers: { Authorization: 'Bearer tok-v5-test' } },
        (res) => {
          let buf = '';
          let messagesPath = null;
          res.on('data', async (chunk) => {
            buf += chunk.toString('utf8');
            if (!messagesPath) {
              const epMatch = /event:\s*endpoint\r?\ndata:\s*(\/messages\?sessionId=[^\r\n]+)/.exec(buf);
              if (epMatch) {
                messagesPath = epMatch[1];
                try {
                  const postRes = await fetch(`${baseUrl}${messagesPath}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-v5-test' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'prompts/list' }),
                  });
                  assert.equal(postRes.status, 202);
                } catch (err) {
                  req.destroy();
                  reject(err);
                }
              }
            }
            const msgMatch = /event:\s*message\r?\ndata:\s*([^\r\n]+)/.exec(buf);
            if (msgMatch) {
              const rpc = JSON.parse(msgMatch[1]);
              assert.equal(rpc.id, 99);
              assert.ok(rpc.result.prompts.length >= 5);
              req.destroy();
              resolve();
            }
          });
        }
      );
      req.on('error', (err) => {
        if (err.code !== 'ECONNRESET') reject(err);
      });
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
