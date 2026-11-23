import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../src/cli.mjs';
import {
  MCP_PILLARS,
  MCP_PRESETS,
  auditMcpSafety,
  mergeMcpServersIntoCodexToml,
  mergeMcpServersIntoJson,
} from '../src/mcp-hub.mjs';

test('MCP_PRESETS covers all 7 pillars including built-in ai-test-workbench orchestrator', () => {
  const pillarsFound = new Set(Object.values(MCP_PRESETS).map((p) => p.pillar));
  assert.ok(MCP_PILLARS.includes('orchestrator'));
  assert.ok(MCP_PRESETS['ai-test-workbench']);
  assert.deepEqual(MCP_PRESETS['ai-test-workbench'].args, ['-y', 'ai-test-workbench', 'mcp-serve']);
  for (const pillar of MCP_PILLARS) {
    assert.equal(pillarsFound.has(pillar), true, `Missing MCP pillar: ${pillar}`);
  }
  assert.ok(MCP_PRESETS.grafana.args.includes('--disable-write'));
  assert.equal(MCP_PRESETS['mysql-readonly'].env.ALLOW_DELETE_OPERATION, 'false');
  assert.ok(MCP_PRESETS['redis-readonly'].args.includes('--readonly'));
});

test('mergeMcpServersIntoJson and mergeMcpServersIntoCodexToml preserve existing custom entries cleanly', () => {
  const jsonRes = mergeMcpServersIntoJson({ mcpServers: { custom: { command: 'node', args: ['x.js'] } } }, ['grafana', 'loki']);
  assert.ok(jsonRes.config.mcpServers.custom);
  assert.ok(jsonRes.config.mcpServers.grafana);
  assert.equal(jsonRes.added.length, 2);

  const tomlRes = mergeMcpServersIntoCodexToml('[mcp_servers.custom]\ncommand = "node"\n', ['grafana', 'mysql-readonly']);
  assert.match(tomlRes.content, /\[mcp_servers\.custom\]/);
  assert.match(tomlRes.content, /\[mcp_servers\.grafana\]/);
  assert.match(tomlRes.content, /ALLOW_DELETE_OPERATION = "false"/);
});

test('auditMcpSafety rejects unsafe write-enabled Grafana/MySQL or hardcoded credentials', () => {
  const safeRes = auditMcpSafety(
    {
      mcpServers: {
        grafana: { command: 'uvx', args: ['mcp-grafana', '--disable-write'], env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: '${GRAFANA_SERVICE_ACCOUNT_TOKEN}' } },
        'mysql-readonly': { command: 'npx', args: ['-y', '@benborla29/mcp-server-mysql'], env: { ALLOW_DELETE_OPERATION: 'false', MYSQL_PASS: '${MYSQL_READONLY_PASS}' } },
      },
    },
    ''
  );
  assert.equal(safeRes.ok, true);

  const unsafeRes = auditMcpSafety(
    {
      mcpServers: {
        grafana: { command: 'uvx', args: ['mcp-grafana'], env: { GRAFANA_SERVICE_ACCOUNT_TOKEN: 'glsa_hardcoded_secret_value' } },
        'mysql-readonly': { command: 'npx', args: ['-y', '@benborla29/mcp-server-mysql'], env: { ALLOW_DELETE_OPERATION: 'true' } },
      },
    },
    ''
  );
  assert.equal(unsafeRes.ok, false);
  assert.equal(unsafeRes.issues.length, 3);
});

test('CLI `mcp add --profile full-link` and `mcp doctor` write and audit QA MCP config cleanly', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-mcp-cli-'));
  try {
    await runCli(['init', '--name', 'mcp-demo', '--target', tmpDir, '--skip-install', '--loop', 'none']);

    const addCode = await runCli(['mcp', 'add', '--target', tmpDir, '--profile', 'full-link', '--lang', 'en']);
    assert.equal(addCode, 0);

    const qaDir = path.join(tmpDir, 'qa');
    assert.equal(fs.existsSync(path.join(qaDir, '.mcp.json')), true);
    assert.equal(fs.existsSync(path.join(qaDir, '.codex', 'config.toml')), true);
    assert.equal(fs.existsSync(path.join(qaDir, '.env.mcp.example')), true);

    const docOkCode = await runCli(['mcp', 'doctor', '--target', tmpDir, '--lang', 'en']);
    assert.equal(docOkCode, 0);

    // Inject unsafe write flag and confirm mcp doctor returns exit code 2
    const mcpJsonPath = path.join(qaDir, '.mcp.json');
    const parsed = JSON.parse(fs.readFileSync(mcpJsonPath, 'utf8'));
    parsed.mcpServers['mysql-readonly'].env.ALLOW_INSERT_OPERATION = 'true';
    fs.writeFileSync(mcpJsonPath, JSON.stringify(parsed, null, 2), 'utf8');

    const docFailCode = await runCli(['mcp', 'doctor', '--target', tmpDir, '--lang', 'en']);
    assert.equal(docFailCode, 2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
