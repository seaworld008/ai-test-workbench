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

test('MCP server negotiates all supported protocol versions (2024-11-05 .. 2025-11-25) and exposes 12 typed tools', async () => {
  for (const ver of SUPPORTED_MCP_VERSIONS) {
    const res = await handleMcpJsonRpcMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: ver, clientInfo: { name: 'unit-test', version: '1.0' } },
    });
    assert.equal(res.result.protocolVersion, ver);
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
  assert.equal(tools.length, 12);
  for (const tool of tools) {
    assert.ok(tool.inputSchema);
    assert.ok(tool.outputSchema);
    assert.ok(tool.annotations);
    assert.equal(typeof tool.annotations.readOnlyHint, 'boolean');
  }

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
  assert.match(enPrompt.result.messages[0].content.text, /Onboard AI Test Workbench|Initialize AI Test Workbench/i);
});

test('MCP stdio transport emits pure NDJSON JSON-RPC frames across initialize, tools/call, resources/read & logging', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-mcp-stdio-'));
  try {
    const child = spawn(process.execPath, [path.join(WORKBENCH_ROOT, 'tools', 'aitest.mjs'), 'mcp-serve'], {
      cwd: WORKBENCH_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: false,
      windowsHide: true,
    });

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
        const timeout = setTimeout(() => reject(new Error(`Timeout waiting for MCP id=${expectedId}`)), 12000);
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
        },
      },
      12
    );
    assert.equal(initDryRes.result.isError, false);
    assert.equal(initDryRes.result.structuredContent.ok, true);
    assert.equal(initDryRes.result.structuredContent.tool, 'aitest_init');
    assert.ok(initDryRes.result.structuredContent.nextRecommendedActions.length >= 1);

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
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('MCP Streamable HTTP (/mcp), Origin/Token security guards, and Legacy SSE (/sse + /messages) work cleanly', async () => {
  assert.throws(() => createMcpHttpServer({ host: '0.0.0.0' }), /without --auth-token/);

  const server = createMcpHttpServer({ host: '127.0.0.1', authToken: 'tok-v4-test' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Health endpoint
    const health = await fetch(`${baseUrl}/health`);
    assert.equal(health.status, 200);
    const healthJson = await health.json();
    assert.equal(healthJson.ok, true);

    // 2. DNS-rebinding Origin rejection (403)
    const badOrigin = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://evil.example.com',
        Authorization: 'Bearer tok-v4-test',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(badOrigin.status, 403);

    // 3. Auth rejection (401)
    const unauth = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(unauth.status, 401);

    // 4. Streamable HTTP initialize + session header + SSE response option + batch + DELETE
    const initHttp = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-v4-test',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 20,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    });
    assert.equal(initHttp.status, 200);
    const sid = initHttp.headers.get('mcp-session-id');
    assert.ok(sid);
    assert.equal(initHttp.headers.get('mcp-protocol-version'), '2025-06-18');
    const initBody = await initHttp.json();
    assert.equal(initBody.result.protocolVersion, '2025-06-18');

    const sseToolRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: 'Bearer tok-v4-test',
        'Mcp-Session-Id': sid,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 21,
        method: 'tools/call',
        params: { name: 'aitest_mcp_hub', arguments: { action: 'presets' } },
      }),
    });
    assert.equal(sseToolRes.status, 200);
    assert.match(sseToolRes.headers.get('content-type') || '', /text\/event-stream/);
    const sseText = await sseToolRes.text();
    const dataLine = sseText.split(/\r?\n/).find((l) => l.startsWith('data: '));
    const parsedToolReply = JSON.parse(dataLine.slice(6));
    assert.equal(parsedToolReply.result.structuredContent.ok, true);
    assert.ok(parsedToolReply.result.structuredContent.data.pillars.includes('orchestrator'));

    const batchRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok-v4-test',
        'Mcp-Session-Id': sid,
      },
      body: JSON.stringify([
        { jsonrpc: '2.0', id: 22, method: 'ping' },
        { jsonrpc: '2.0', id: 23, method: 'tools/list' },
      ]),
    });
    const batchJson = await batchRes.json();
    assert.equal(batchJson.length, 2);
    assert.equal(batchJson[1].result.tools.length, 12);

    const delRes = await fetch(`${baseUrl}/mcp`, {
      method: 'DELETE',
      headers: { Authorization: 'Bearer tok-v4-test', 'Mcp-Session-Id': sid },
    });
    assert.equal(delRes.status, 200);

    // 5. Legacy 2024-11-05 HTTP+SSE (/sse + /messages)
    await new Promise((resolve, reject) => {
      const req = http.get(
        `${baseUrl}/sse`,
        { headers: { Authorization: 'Bearer tok-v4-test' } },
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
                    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-v4-test' },
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
