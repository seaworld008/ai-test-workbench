#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpHttpServer } from '../src/mcp/transport-http.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const EXPECTED_FAILURES_PATH = path.join(__dirname, 'expected-failures.json');
const RESULTS_DIR = path.join(__dirname, 'results');
const OFFICIAL_OUT_DIR = path.join(RESULTS_DIR, 'official');
const SUMMARY_PATH = path.join(RESULTS_DIR, 'summary.json');
const CONFORMANCE_BIN = path.join(__dirname, 'node_modules', '@modelcontextprotocol', 'conformance', 'dist', 'index.js');

const officialOnly = process.argv.includes('--official-only');
const sdkOnly = process.argv.includes('--sdk-only');

function loadAndValidateExpectedFailures() {
  if (!fs.existsSync(EXPECTED_FAILURES_PATH)) {
    throw new Error(`Missing ${EXPECTED_FAILURES_PATH}`);
  }
  const raw = JSON.parse(fs.readFileSync(EXPECTED_FAILURES_PATH, 'utf8'));
  const list = Array.isArray(raw.server) ? raw.server : [];
  const seen = new Set();
  for (const [idx, entry] of list.entries()) {
    if (!entry || typeof entry.scenario !== 'string' || !entry.scenario.trim()) {
      throw new Error(`expected-failures.json server[${idx}] missing non-empty "scenario"`);
    }
    if (seen.has(entry.scenario)) {
      throw new Error(`expected-failures.json duplicate scenario "${entry.scenario}"`);
    }
    seen.add(entry.scenario);
    if (typeof entry.reason !== 'string' || entry.reason.trim().length < 10) {
      throw new Error(`expected-failures.json "${entry.scenario}" must include a descriptive "reason"`);
    }
    if (typeof entry.issue !== 'string' || !/^https:\/\/github\.com\//.test(entry.issue)) {
      throw new Error(`expected-failures.json "${entry.scenario}" must include a valid GitHub "issue" URL`);
    }
  }
  return { raw, list, map: new Map(list.map((e) => [e.scenario, e])) };
}

function writeBaselineYaml(tmpDir, entries) {
  const yamlPath = path.join(tmpDir, 'expected-failures.yml');
  const lines = ['server:'];
  for (const entry of entries) {
    lines.push(`  - ${entry.scenario}`);
  }
  fs.writeFileSync(yamlPath, `${lines.join('\n')}\n`, 'utf8');
  return yamlPath;
}

function collectOfficialResults(outDir, expectedMap) {
  const passed = [];
  const expectedFailed = [];
  const unexpectedFailed = [];
  const staleBaselines = [];

  if (!fs.existsSync(outDir)) {
    return { total: 0, passed, expectedFailed, unexpectedFailed, staleBaselines };
  }

  for (const dirName of fs.readdirSync(outDir).sort()) {
    const checksPath = path.join(outDir, dirName, 'checks.json');
    if (!fs.existsSync(checksPath)) continue;
    const scenario = dirName.replace(/^server-/, '').replace(/-\d{4}-\d{2}-\d{2}T.*$/, '');
    const checks = JSON.parse(fs.readFileSync(checksPath, 'utf8'));
    const failures = checks.filter((c) => c.status === 'FAILURE');
    const isExpected = expectedMap.has(scenario);

    if (failures.length === 0) {
      if (isExpected) {
        staleBaselines.push(scenario);
      } else {
        passed.push({ scenario, checksPassed: checks.filter((c) => c.status === 'SUCCESS').length });
      }
    } else if (isExpected) {
      expectedFailed.push({
        scenario,
        category: expectedMap.get(scenario).category || 'known',
        error: failures[0]?.errorMessage || failures[0]?.description || 'failure',
      });
    } else {
      unexpectedFailed.push({
        scenario,
        error: failures[0]?.errorMessage || failures[0]?.description || 'failure',
      });
    }
  }

  return {
    total: passed.length + expectedFailed.length + unexpectedFailed.length + staleBaselines.length,
    passed,
    expectedFailed,
    unexpectedFailed,
    staleBaselines,
  };
}

function spawnAndWait(cmd, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

async function runOfficialSuite() {
  if (!fs.existsSync(CONFORMANCE_BIN)) {
    throw new Error(`Missing @modelcontextprotocol/conformance binary at ${CONFORMANCE_BIN}. Run "npm ci" in conformance/.`);
  }

  const { raw, list, map } = loadAndValidateExpectedFailures();
  const tmpWs = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-official-conf-'));
  fs.rmSync(OFFICIAL_OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OFFICIAL_OUT_DIR, { recursive: true });

  const baselineYaml = writeBaselineYaml(tmpWs, list);
  const server = createMcpHttpServer({
    host: '127.0.0.1',
    workspaceRoots: [tmpWs],
    defaultTarget: tmpWs,
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const url = `http://127.0.0.1:${port}/mcp`;

  console.log(`\n[conformance] Running @modelcontextprotocol/conformance@${raw.conformanceVersion} (suite=${raw.suite}) against ${url}`);
  let exitCode = 1;
  try {
    exitCode = await spawnAndWait(
      process.execPath,
      [
        CONFORMANCE_BIN,
        'server',
        '--url',
        url,
        '--suite',
        raw.suite || 'active',
        '--expected-failures',
        baselineYaml,
        '--output-dir',
        OFFICIAL_OUT_DIR,
      ],
      __dirname
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpWs, { recursive: true, force: true });
  }

  const stats = collectOfficialResults(OFFICIAL_OUT_DIR, map);
  console.log(
    `\n[conformance] Official Streamable HTTP summary: total=${stats.total}, passed=${stats.passed.length}, expectedFailures=${stats.expectedFailed.length}, unexpectedFailures=${stats.unexpectedFailed.length}, staleBaselines=${stats.staleBaselines.length}, exitCode=${exitCode}`
  );
  if (stats.unexpectedFailed.length > 0) {
    console.error('[conformance] UNEXPECTED FAILURES (not registered in expected-failures.json):', stats.unexpectedFailed);
  }
  if (stats.staleBaselines.length > 0) {
    console.error('[conformance] STALE BASELINES (now passing — remove from expected-failures.json):', stats.staleBaselines);
  }

  const ok = exitCode === 0 && stats.unexpectedFailed.length === 0 && stats.staleBaselines.length === 0 && stats.total > 0;
  return {
    ok,
    exitCode,
    conformanceVersion: raw.conformanceVersion,
    suite: raw.suite || 'active',
    ...stats,
  };
}

async function runSdkTests() {
  console.log('\n[conformance] Running @modelcontextprotocol/sdk reference Client tests across stdio / Streamable HTTP / Legacy SSE...');
  const exitCode = await spawnAndWait(
    process.execPath,
    ['--test', '--test-reporter=spec', path.join(__dirname, 'sdk-client.test.mjs')],
    __dirname
  );
  return { ok: exitCode === 0, exitCode };
}

async function main() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
  const report = {
    generatedAt: new Date().toISOString(),
    conformancePackageVersion: pkg.devDependencies['@modelcontextprotocol/conformance'],
    sdkPackageVersion: pkg.devDependencies['@modelcontextprotocol/sdk'],
    officialNote: '@modelcontextprotocol/conformance@0.1.16 server mode tests HTTP/Streamable HTTP only; stdio, Streamable HTTP, and Legacy SSE are all covered by the official @modelcontextprotocol/sdk reference client tests.',
    official: null,
    sdk: null,
  };

  if (!sdkOnly) {
    report.official = await runOfficialSuite();
  }
  if (!officialOnly) {
    report.sdk = await runSdkTests();
  }

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  fs.writeFileSync(SUMMARY_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  const allOk = (report.official ? report.official.ok : true) && (report.sdk ? report.sdk.ok : true);
  if (!allOk) {
    process.exit(1);
  }
  console.log(`\n[conformance] ALL CHECKS PASSED. Summary saved to ${path.relative(REPO_ROOT, SUMMARY_PATH)}`);
}

main().catch((err) => {
  console.error('[conformance] Fatal error:', err?.stack || err?.message || String(err));
  process.exit(1);
});
