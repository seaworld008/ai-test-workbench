import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHttpServer } from '../src/mcp/transport-http.mjs';
import { SUPPORTED_MCP_VERSIONS } from '../src/mcp/protocol.mjs';
import { WORKBENCH_VERSION } from '../src/version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const AITEST_BIN = path.join(REPO_ROOT, 'tools', 'aitest.mjs');

const EXPECTED_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const VALID_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);

function validateToolSchemas(tools) {
  assert.equal(tools.length, 17, `Expected exactly 17 canonical MCP tools, got ${tools.length}`);
  const seenNames = new Set();
  for (const tool of tools) {
    assert.equal(typeof tool.name, 'string');
    assert.ok(tool.name.startsWith('aitest_'), `Tool name must start with aitest_: ${tool.name}`);
    assert.ok(!seenNames.has(tool.name), `Duplicate tool name: ${tool.name}`);
    seenNames.add(tool.name);
    assert.equal(typeof tool.description, 'string');
    assert.ok(tool.description.trim().length > 0, `Tool ${tool.name} must have non-empty description`);
    assert.ok(tool.inputSchema && typeof tool.inputSchema === 'object', `Tool ${tool.name} missing inputSchema`);
    assert.equal(tool.inputSchema.type, 'object', `Tool ${tool.name} inputSchema.type must be 'object'`);
    const props = tool.inputSchema.properties || {};
    assert.equal(typeof props, 'object');
    if (Array.isArray(tool.inputSchema.required)) {
      for (const reqKey of tool.inputSchema.required) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(props, reqKey),
          `Tool ${tool.name} required property "${reqKey}" missing from inputSchema.properties`
        );
      }
    }
    for (const [propName, propDef] of Object.entries(props)) {
      assert.ok(propDef && typeof propDef === 'object', `Tool ${tool.name}.${propName} schema must be an object`);
      if (propDef.type) {
        assert.ok(
          VALID_SCHEMA_TYPES.has(propDef.type),
          `Tool ${tool.name}.${propName} has invalid JSON Schema type "${propDef.type}"`
        );
      }
    }
  }
}

async function runSdkClientLifecycleSuite(label, createTransport, tmpWs) {
  const client = new Client({
    name: `aitest-conformance-sdk-client-${label}`,
    version: '1.0.0',
  });
  const transport = createTransport();

  await client.connect(transport);
  try {
    // 1. ServerInfo & negotiated capabilities
    const serverInfo = client.getServerVersion();
    assert.equal(serverInfo?.name, 'ai-test-workbench', `${label}: unexpected serverInfo.name`);
    assert.equal(serverInfo?.version, WORKBENCH_VERSION, `${label}: unexpected serverInfo.version`);
    const caps = client.getServerCapabilities();
    assert.ok(caps?.tools, `${label}: missing tools capability`);
    assert.ok(caps?.resources, `${label}: missing resources capability`);
    assert.ok(caps?.prompts, `${label}: missing prompts capability`);

    // 2. Ping health check
    await client.ping();

    // 3. tools/list: exactly 17 canonical tools with valid schemas
    const listRes = await client.listTools();
    validateToolSchemas(listRes.tools);

    // 4. resources & prompts sanity checks
    const resourcesRes = await client.listResources();
    assert.ok(resourcesRes.resources.length >= 3, `${label}: expected >= 3 MCP resources`);
    const presetsResource = await client.readResource({ uri: 'aitest://mcp/presets' });
    assert.ok(presetsResource.contents.length === 1);
    const promptRes = await client.getPrompt({ name: 'first-time-onboarding', arguments: { lang: 'en' } });
    assert.ok(promptRes.messages.length >= 1);

    // 5. Read-only tools/call with structuredContent + progress notifications
    const progressEvents = [];
    const doctorRes = await client.callTool(
      {
        name: 'aitest_doctor',
        arguments: { target: tmpWs, lang: 'en' },
      },
      undefined,
      {
        onprogress: (progress) => {
          progressEvents.push(progress);
        },
      }
    );

    assert.equal(doctorRes.isError, false, `${label}: aitest_doctor returned isError=true`);
    assert.ok(Array.isArray(doctorRes.content) && doctorRes.content.length >= 1, `${label}: missing content array`);
    assert.equal(doctorRes.content[0].type, 'text');
    const parsedText = JSON.parse(doctorRes.content[0].text);
    assert.equal(parsedText.tool, 'aitest_doctor');
    assert.equal(parsedText.ok, true);

    assert.ok(
      doctorRes.structuredContent && typeof doctorRes.structuredContent === 'object',
      `${label}: missing structuredContent on aitest_doctor`
    );
    assert.equal(doctorRes.structuredContent.ok, true);
    assert.equal(doctorRes.structuredContent.exitCode, 0);
    assert.equal(doctorRes.structuredContent.tool, 'aitest_doctor');
    assert.ok(typeof doctorRes.structuredContent.summary === 'string' && doctorRes.structuredContent.summary.length > 0);
    assert.ok(doctorRes.structuredContent.data && typeof doctorRes.structuredContent.data === 'object');
    assert.ok(Array.isArray(doctorRes.structuredContent.nextRecommendedActions));

    assert.ok(
      progressEvents.length >= 1,
      `${label}: expected >= 1 progress notification on aitest_doctor, got ${progressEvents.length}`
    );
    for (const evt of progressEvents) {
      assert.equal(typeof evt.progress, 'number', `${label}: progress.progress must be a number`);
    }

    // 6. Cancellation via AbortController (triggers MCP notifications/cancelled)
    const ac = new AbortController();
    const cancelTimer = setTimeout(() => {
      if (!ac.signal.aborted) ac.abort('conformance-cancel-request');
    }, 10);

    let cancelError = null;
    try {
      await client.callTool(
        {
          name: 'aitest_doctor',
          arguments: { target: tmpWs, lang: 'en' },
        },
        undefined,
        {
          signal: ac.signal,
          onprogress: () => {
            if (!ac.signal.aborted) ac.abort('conformance-cancel-on-progress');
          },
        }
      );
    } catch (err) {
      cancelError = err;
    } finally {
      clearTimeout(cancelTimer);
    }

    assert.ok(cancelError !== null, `${label}: expected AbortController cancellation to reject callTool`);

    // 7. Server and session remain healthy immediately after cancellation
    await client.ping();
    const presetsCall = await client.callTool({
      name: 'aitest_mcp_hub',
      arguments: { action: 'presets' },
    });
    assert.equal(presetsCall.isError, false);
    assert.equal(presetsCall.structuredContent?.ok, true);
    assert.equal(presetsCall.structuredContent?.tool, 'aitest_mcp_hub');
  } finally {
    await client.close().catch(() => {});
  }
}

async function negotiateVersionOverStdio(requestedVersion, tmpWs) {
  const child = spawn(
    process.execPath,
    [AITEST_BIN, 'mcp-serve', '--transport', 'stdio', '--workspace-root', tmpWs, '--target', tmpWs],
    { cwd: REPO_ROOT, stdio: ['pipe', 'pipe', 'pipe'] }
  );
  try {
    const rl = readline.createInterface({ input: child.stdout });
    const responsePromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timeout waiting for stdio initialize (${requestedVersion})`)), 10_000);
      rl.once('line', (line) => {
        clearTimeout(timer);
        resolve(JSON.parse(line));
      });
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: requestedVersion,
          capabilities: {},
          clientInfo: { name: 'version-negotiation-probe', version: '1.0.0' },
        },
      }) + '\n'
    );
    const resp = await responsePromise;
    rl.close();
    return resp.result.protocolVersion;
  } finally {
    child.stdin.end();
    child.kill();
  }
}

async function negotiateVersionOverStreamableHttp(baseUrl, requestedVersion) {
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: requestedVersion,
        capabilities: {},
        clientInfo: { name: 'version-negotiation-probe', version: '1.0.0' },
      },
    }),
  });
  assert.equal(res.status, 200);
  const sid = res.headers.get('mcp-session-id');
  assert.ok(sid, 'Expected Mcp-Session-Id header');
  const body = await res.json();
  const headerVer = res.headers.get('mcp-protocol-version');
  assert.equal(headerVer, body.result.protocolVersion);
  await fetch(`${baseUrl}/mcp`, { method: 'DELETE', headers: { 'Mcp-Session-Id': sid } }).catch(() => {});
  return body.result.protocolVersion;
}

async function negotiateVersionOverLegacySse(baseUrl, requestedVersion) {
  const ac = new AbortController();
  const res = await fetch(`${baseUrl}/sse`, { signal: ac.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let endpoint = null;

  const readEvent = async () => {
    while (true) {
      const idx = buf.indexOf('\n\n');
      if (idx >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = block.split('\n');
        let event = 'message';
        let data = '';
        for (const l of lines) {
          if (l.startsWith('event:')) event = l.slice(6).trim();
          else if (l.startsWith('data:')) data += l.slice(5).trim();
        }
        if (data) return { event, data };
        continue;
      }
      const chunk = await reader.read();
      if (chunk.done) throw new Error('SSE stream ended unexpectedly');
      buf += decoder.decode(chunk.value, { stream: true });
    }
  };

  try {
    const first = await readEvent();
    assert.equal(first.event, 'endpoint');
    endpoint = first.data;
    const postRes = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: requestedVersion,
          capabilities: {},
          clientInfo: { name: 'version-negotiation-probe', version: '1.0.0' },
        },
      }),
    });
    assert.equal(postRes.status, 202);
    const replyEvt = await readEvent();
    const parsed = JSON.parse(replyEvt.data);
    return parsed.result.protocolVersion;
  } finally {
    ac.abort();
  }
}

test('MCP SDK 1.32.2 Reference Client interoperability across stdio, Streamable HTTP, and Legacy SSE', async (t) => {
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-sdk-conf-'));
  const httpServer = createMcpHttpServer({
    host: '127.0.0.1',
    workspaceRoots: [tmpWs],
    defaultTarget: tmpWs,
  });

  await new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const addr = httpServer.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    await new Promise((resolve) => httpServer.close(resolve));
    fs.rmSync(tmpWs, { recursive: true, force: true });
  });

  await t.test('Protocol version negotiation (2024-11-05 .. 2025-11-25 + fallback) across all 3 transports', async () => {
    for (const ver of EXPECTED_VERSIONS) {
      assert.ok(SUPPORTED_MCP_VERSIONS.includes(ver), `Server SUPPORTED_MCP_VERSIONS must include ${ver}`);
      assert.equal(await negotiateVersionOverStdio(ver, tmpWs), ver, `stdio should negotiate ${ver}`);
      assert.equal(await negotiateVersionOverStreamableHttp(baseUrl, ver), ver, `Streamable HTTP should negotiate ${ver}`);
      assert.equal(await negotiateVersionOverLegacySse(baseUrl, ver), ver, `Legacy SSE should negotiate ${ver}`);
    }
    // Unsupported future version falls back to latest supported (2025-11-25)
    assert.equal(await negotiateVersionOverStreamableHttp(baseUrl, '2099-01-01'), '2025-11-25');
    assert.equal(await negotiateVersionOverStdio('2099-01-01', tmpWs), '2025-11-25');
    assert.equal(await negotiateVersionOverLegacySse(baseUrl, '2099-01-01'), '2025-11-25');
  });

  await t.test('StdioClientTransport: init, 17 tools + valid schemas, structuredContent, progress, cancellation', async () => {
    await runSdkClientLifecycleSuite(
      'stdio',
      () =>
        new StdioClientTransport({
          command: process.execPath,
          args: [AITEST_BIN, 'mcp-serve', '--transport', 'stdio', '--workspace-root', tmpWs, '--target', tmpWs],
          cwd: REPO_ROOT,
          stderr: 'pipe',
        }),
      tmpWs
    );
  });

  await t.test('StreamableHTTPClientTransport (/mcp): init, 17 tools + valid schemas, structuredContent, progress, cancellation', async () => {
    await runSdkClientLifecycleSuite(
      'streamable-http',
      () => new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`)),
      tmpWs
    );
  });

  await t.test('SSEClientTransport (/sse + /messages): init, 17 tools + valid schemas, structuredContent, progress, cancellation', async () => {
    await runSdkClientLifecycleSuite(
      'legacy-sse',
      () => new SSEClientTransport(new URL(`${baseUrl}/sse`)),
      tmpWs
    );
  });
});
