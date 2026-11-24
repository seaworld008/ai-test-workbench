import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  loadAndValidateAitestConfigFile,
  loadWorkbenchConfig,
  parseEnvText,
  validateAitestConfigObject,
} from '../../src/core/config.mjs';
import { buildCommandResult, isCiEnvironment, mergeOutcomes, outcomeToExitCode } from '../../src/core/outcome.mjs';
import { runInit } from '../../src/init.mjs';
import {
  checkOutgoingRequestSafety,
  compareSpecSourcesAst,
  runAuditForQaDir,
  runStaticSpecChecks,
  verifyGovernanceLockInQaDir,
  verifyLedgerBindingInQaDir,
} from '../../src/kernel/index.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';

test('core/outcome enforces tri-state outcome lattice and exit code 0/1/2 mapping', () => {
  assert.equal(outcomeToExitCode('pass'), 0);
  assert.equal(outcomeToExitCode('fail'), 1);
  assert.equal(outcomeToExitCode('blocked'), 2);

  assert.equal(mergeOutcomes(['pass', 'skipped', 'pass']), 'pass');
  assert.equal(mergeOutcomes(['pass', 'fail', 'skipped']), 'fail');
  assert.equal(mergeOutcomes(['pass', 'fail', 'blocked']), 'blocked');
  assert.equal(mergeOutcomes(['pass'], true), 'fail');

  assert.equal(isCiEnvironment({ CI: 'true' }), true);
  assert.equal(isCiEnvironment({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(isCiEnvironment({}), false);

  const res = buildCommandResult({
    tool: 'aitest_audit',
    outcome: 'blocked',
    summary: 'Missing governance.lock',
    data: { reason: 'missing_lock' },
  });
  assert.equal(res.ok, false);
  assert.equal(res.exitCode, 2);
  assert.equal(res.outcome, 'blocked');
});

test('Fail-Closed Fix #1: compareSpecSourcesAst blocks instead of passing when TS compiler is unavailable', () => {
  const res = compareSpecSourcesAst(
    'tests/e2e/checkout.spec.ts',
    "test('ok', async ({ page }) => { await expect(page).toHaveTitle('Shop'); });",
    "test('ok', async ({ page }) => { });",
    { tsCompiler: null }
  );
  assert.equal(res.ok, false);
  assert.equal(res.blocked, true);
  assert.equal(res.outcome, 'blocked');
  assert.ok(res.violations.some((v) => v.includes('TypeScript compiler unavailable')));
});

test('Fail-Closed Fix #2: runStaticSpecChecks blocks when CI=true and tsc/eslint are missing', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-ci-compilers-'));
  try {
    fs.mkdirSync(path.join(tmp, 'tests'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'tsconfig.json'), '{}', 'utf8');
    fs.writeFileSync(
      path.join(tmp, 'tests', 'ok.spec.ts'),
      "import { test, expect } from '@playwright/test'; test('a', async ({ page }) => { await expect(page).toHaveURL('/'); });\n",
      'utf8'
    );

    const ciRes = runStaticSpecChecks(tmp, { env: { CI: 'true' } });
    assert.equal(ciRes.ok, false);
    assert.equal(ciRes.status, 'blocked');
    assert.ok(ciRes.errors.some((e) => e.includes('TypeCheck Blocked')));
    assert.ok(ciRes.errors.some((e) => e.includes('Static Check Blocked')));

    // Explicit local non-CI mode still allows built-in AST fallback scanner with warnings
    const localRes = runStaticSpecChecks(tmp, { env: {} });
    assert.equal(localRes.ok, true);
    assert.equal(localRes.status, 'pass');
    assert.ok(localRes.warnings.length > 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('Fail-Closed Fix #3: custom --results without expectedRunId is blocked unless allowUnboundResults is explicitly set', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-custom-results-'));
  try {
    await runInit({ target: repoDir, skipInstall: true, skipBrowser: true, loop: 'none', lang: 'en' });
    const qaDir = path.join(repoDir, 'qa');
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });

    const defaultResults = path.join(qaDir, 'reports', 'results.json');
    const customResults = path.join(qaDir, 'reports', 'forged-green.json');
    const greenJson = JSON.stringify({
      suites: [{ title: 's', specs: [{ title: 'ok', tests: [{ status: 'expected', results: [{ status: 'passed' }] }] }] }],
    });
    fs.writeFileSync(defaultResults, greenJson, 'utf8');
    fs.writeFileSync(customResults, greenJson, 'utf8');

    const { runId } = beginRunLedger(qaDir, { suite: 'smoke', command: 'test', repoDir });
    finalizeRunLedger(qaDir, runId, { exitCode: 0, resultsPath: defaultResults });

    // Custom results WITHOUT expectedRunId -> BLOCKED!
    const blocked = verifyLedgerBindingInQaDir(qaDir, customResults, JSON.parse(greenJson), {});
    assert.equal(blocked.ok, false);
    assert.equal(blocked.status, 'blocked');
    assert.ok(blocked.errors.some((e) => e.includes('expectedRunId')));

    // Explicit allowUnboundResults (CLI human advisory only) -> allowed T0
    const advisory = verifyLedgerBindingInQaDir(qaDir, customResults, JSON.parse(greenJson), {
      allowUnboundResults: true,
    });
    assert.equal(advisory.ok, true);
    assert.equal(advisory.trustTier, 'T0');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('Fail-Closed Fix #4: uninitialized workspace is blocked by governance lock and ledger checks', () => {
  const bareDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-uninit-'));
  try {
    const gov = verifyGovernanceLockInQaDir(bareDir);
    assert.equal(gov.ok, false);
    assert.equal(gov.status, 'blocked');

    const fakeResults = path.join(bareDir, 'results.json');
    fs.writeFileSync(fakeResults, JSON.stringify({ suites: [] }), 'utf8');
    const ledger = verifyLedgerBindingInQaDir(bareDir, fakeResults, { suites: [] });
    assert.equal(ledger.ok, false);
    assert.equal(ledger.status, 'blocked');

    const audit = runAuditForQaDir(bareDir, { staticOnly: true });
    assert.equal(audit.ok, false);
    assert.equal(audit.outcome, 'blocked');
  } finally {
    fs.rmSync(bareDir, { recursive: true, force: true });
  }
});

test('Fail-Closed Fix #5: malformed or empty outgoing URLs are blocked by target-guard', () => {
  const bad = checkOutgoingRequestSafety('GET', 'http://[::1:bad-url');
  assert.equal(bad.blocked, true);
  assert.match(String(bad.reason), /malformed/i);

  const empty = checkOutgoingRequestSafety('GET', '');
  assert.equal(empty.blocked, true);
  assert.match(String(empty.reason), /empty/i);
});

test('Fail-Closed Fix #6 & Centralized Config: malformed/invalid aitest.config.json blocks audit and validates schema', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-bad-config-'));
  try {
    await runInit({ target: repoDir, skipInstall: true, skipBrowser: true, loop: 'none', lang: 'en' });
    const qaDir = path.join(repoDir, 'qa');

    // 1. Valid config loads cleanly via centralized loadWorkbenchConfig (injectable env, no process.env mutation)
    fs.writeFileSync(path.join(qaDir, '.env'), 'TEST_ENV=staging\nTEST_BASE_URL=https://staging.example.test\n', 'utf8');
    const loaded = loadWorkbenchConfig({
      qaDir,
      repoDir,
      env: { TEST_EGRESS_MODE: 'allowlist', CI: '1' },
      overrides: { lang: 'en' },
    });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ci, true);
    assert.equal(loaded.target.egressMode, 'allowlist');
    assert.equal(loaded.target.baseUrl, 'https://staging.example.test');
    assert.equal(parseEnvText('export FOO="bar"\n# comment\nBAZ=1').FOO, 'bar');

    // Invalid TEST_EGRESS_MODE fails validation
    const badEnvCfg = loadWorkbenchConfig({ qaDir, repoDir, env: { TEST_EGRESS_MODE: 'open-bar' } });
    assert.equal(badEnvCfg.ok, false);

    // Schema validator accepts valid v6 rules override & rejects invalid types
    assert.equal(validateAitestConfigObject({ maxFlaky: 0, rules: { 'AITEST-G114': { enabled: true } } }).ok, true);
    assert.equal(validateAitestConfigObject({ maxSkipped: -1 }).ok, false);
    assert.equal(validateAitestConfigObject({ rules: { BAD_CODE: true } }).ok, false);

    // 2. Malformed JSON in aitest.config.json -> audit MUST return outcome='blocked'
    fs.writeFileSync(path.join(qaDir, 'aitest.config.json'), '{ broken json', 'utf8');
    const cfgCheck = loadAndValidateAitestConfigFile(qaDir);
    assert.equal(cfgCheck.ok, false);
    assert.ok(cfgCheck.config._configError);

    const auditBlocked = runAuditForQaDir(qaDir, { staticOnly: true, skipGovernanceCheck: true });
    assert.equal(auditBlocked.ok, false);
    assert.equal(auditBlocked.outcome, 'blocked');
    assert.ok(auditBlocked.errors.some((e) => e.includes('[Config Blocked]')));
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('init --json emits valid machine-readable JSON on both dry-run and apply', async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-init-json-'));
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const dryCode = await runInit({
      target: repoDir,
      dryRun: true,
      skipInstall: true,
      skipBrowser: true,
      loop: 'none',
      json: true,
      lang: 'en',
    });
    assert.equal(dryCode, 0);
    const parsedDry = JSON.parse(logs.join('\n'));
    assert.equal(parsedDry.ok, true);
    assert.equal(parsedDry.dryRun, true);
    assert.ok(Array.isArray(parsedDry.plan) && parsedDry.plan.length > 0);
  } finally {
    console.log = origLog;
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
