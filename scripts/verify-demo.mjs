#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDemoServer } from '../examples/demo-webapp/server.mjs';
import { runCli } from '../src/cli.mjs';
import { handleMcpJsonRpcMessage } from '../src/mcp-server.mjs';
import { verifyAttestationFile } from '../src/trust.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_MODULES = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa', 'node_modules');

if (!fs.existsSync(path.join(TEMPLATE_MODULES, '@playwright', 'test', 'cli.js'))) {
  console.error(
    `Template dependencies not installed in ${path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa')}. Run npm install there first.`
  );
  process.exit(1);
}

const tempWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-demo-verify-'));
const demo = await startDemoServer({ port: 0, host: '127.0.0.1' });

const savedEnv = {
  TEST_BASE_URL: process.env.TEST_BASE_URL,
  TEST_ALLOWED_HOSTS: process.env.TEST_ALLOWED_HOSTS,
  REQUIRE_TEST_TARGET: process.env.REQUIRE_TEST_TARGET,
  TEST_ALLOW_MUTATION: process.env.TEST_ALLOW_MUTATION,
};

let exitCode = 1;
try {
  console.log(`[Demo Verify] Demo server ready at ${demo.baseURL}`);
  const initCode = await runCli([
    'init',
    '--name',
    'smart-campus-demo',
    '--target',
    tempWorkspace,
    '--preset',
    'demo-campus',
    '--skip-install',
    '--skip-browser',
    '--loop',
    'none',
  ]);
  if (initCode !== 0) {
    throw new Error(`init failed with exit code ${initCode}`);
  }

  // Initialize a real Git repository + baseline commit BEFORE linking node_modules so verify_change
  // exercises ALL 4 layers including Layer 3 AST Semantic Diff Guard & in-toto attestation!
  const gitExec = (args) =>
    spawnSync('git', ['-c', 'core.quotePath=off', ...args], {
      cwd: tempWorkspace,
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
  gitExec(['init']);
  gitExec(['config', 'user.email', 'demo-verify@ai-test-workbench.local']);
  gitExec(['config', 'user.name', 'Demo Verify']);
  gitExec(['add', '.']);
  gitExec(['commit', '-m', 'chore: initial baseline']);

  // Link template node_modules for fast zero-network local verification
  const qaModules = path.join(tempWorkspace, 'qa', 'node_modules');
  fs.symlinkSync(TEMPLATE_MODULES, qaModules, process.platform === 'win32' ? 'junction' : 'dir');

  process.env.TEST_BASE_URL = demo.baseURL;
  process.env.TEST_ALLOWED_HOSTS = '127.0.0.1,localhost';
  process.env.REQUIRE_TEST_TARGET = '1';
  process.env.TEST_ALLOW_MUTATION = '1';
  process.env.E2E_USERNAME = 'student_qa_0';
  process.env.E2E_PASSWORD = 'qa-pass-123';

  const seedCode = await runCli(['run', '--target', tempWorkspace, '--suite', 'seed']);
  const allCode = await runCli(['run', '--target', tempWorkspace, '--suite', 'all', '--audit']);
  const auditCode = await runCli(['audit', '--target', tempWorkspace, '--check-specs', '--require-e2e']);
  const exploreCode = await runCli(['explore', '--target', tempWorkspace, '--base-url', demo.baseURL, '--max-pages', '5']);
  const mapCode = await runCli(['map', '--target', tempWorkspace]);
  const mcpAddCode = await runCli(['mcp', 'add', '--target', tempWorkspace, '--profile', 'full-link']);
  const mcpDocCode = await runCli(['mcp', 'doctor', '--target', tempWorkspace]);
  const perfCode = await runCli([
    'perf',
    '--target',
    tempWorkspace,
    '--base-url',
    demo.baseURL,
    '--routes',
    '/',
    '--endpoint',
    '/api/courses',
    '--concurrency',
    '2',
    '--iterations',
    '6',
    '--enforce-budget',
  ]);

  const mcpCtx = { workspaceRoots: [tempWorkspace] };
  const mcpReportReply = await handleMcpJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'aitest_report', arguments: { target: tempWorkspace } },
    },
    mcpCtx
  );
  const mcpOk = mcpReportReply?.result?.structuredContent?.ok === true;

  const verifyReply = await handleMcpJsonRpcMessage(
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'aitest_verify_change',
        arguments: { target: tempWorkspace, mode: 'full', baseUrl: demo.baseURL },
      },
    },
    mcpCtx
  );
  const verifyData = verifyReply?.result?.structuredContent?.data;
  const attestPath = verifyData?.artifacts?.attestationPath;
  const attestCheck = attestPath
    ? verifyAttestationFile(attestPath, { allowT1: true })
    : { ok: false, errors: ['missing attestationPath'] };
  const strictT2RejectCheck = attestPath ? verifyAttestationFile(attestPath) : { ok: true };
  const verifyOk =
    verifyReply?.result?.structuredContent?.ok === true &&
    verifyData?.verdict === 'pass' &&
    verifyData?.gates?.semanticDiff === 'pass' &&
    verifyData?.acceptanceScope === 'business-e2e' &&
    attestCheck.ok === true &&
    strictT2RejectCheck.ok === false &&
    strictT2RejectCheck.trustLevel !== 'T2';

  if (!mcpOk || !verifyOk) {
    console.error('[Demo Verify] MCP/Verify failure details:', JSON.stringify({
      mcpOk,
      verifyOk,
      mcpSummary: mcpReportReply?.result?.structuredContent?.summary,
      verifyOkFlag: verifyReply?.result?.structuredContent?.ok,
      verifySummary: verifyReply?.result?.structuredContent?.summary,
      verdict: verifyData?.verdict,
      gates: verifyData?.gates,
      acceptanceScope: verifyData?.acceptanceScope,
      gateErrors: verifyData?.gateErrors,
      attestCheck,
    }, null, 2));
  }

  exitCode =
    seedCode === 0 &&
    allCode === 0 &&
    auditCode === 0 &&
    exploreCode === 0 &&
    mapCode === 0 &&
    mcpAddCode === 0 &&
    mcpDocCode === 0 &&
    perfCode === 0 &&
    mcpOk &&
    verifyOk
      ? 0
      : 1;
} finally {
  const qaModules = path.join(tempWorkspace, 'qa', 'node_modules');
  try {
    if (fs.existsSync(qaModules)) fs.unlinkSync(qaModules);
  } catch {
    // ignore cleanup
  }
  fs.rmSync(tempWorkspace, { recursive: true, force: true });
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await demo.close();
}

process.exit(exitCode);
