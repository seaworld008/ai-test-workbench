import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAuditForQaDir } from '../../src/audit.mjs';
import { runCli } from '../../src/cli.mjs';
import { syncQuarantineFromLedger } from '../../src/flaky.mjs';
import { runGovernanceCommand } from '../../src/governance.mjs';
import { attemptHealRepair, beginHealSession } from '../../src/heal.mjs';
import { buildSafeChildEnv, McpJobManager } from '../../src/jobs.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';
import { handleMcpJsonRpcMessage } from '../../src/mcp-server.mjs';
import { buildPlaywrightChildEnv } from '../../src/runner.mjs';
import { checkHealSessionConflicts } from '../../src/verdict.mjs';
import {
  canonicalizeJson,
  computeKeyId,
  isBotApprover,
  openTrustContext,
  signPayloadT1,
  verifyGovernanceLockInQaDir,
  verifyPayloadT1,
} from '../../src/kernel/gate-kernel.mjs';

async function withEnv(overrides, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = Object.prototype.hasOwnProperty.call(process.env, k) ? process.env[k] : undefined;
    if (v === undefined || v === null) {
      delete process.env[k];
    } else {
      process.env[k] = String(v);
    }
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('WU-01: RFC 8785 canonicalizeJson rejects non-JSON types and normalizes -0', () => {
  assert.throws(() => canonicalizeJson(undefined), TypeError);
  assert.throws(() => canonicalizeJson([undefined]), TypeError);
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => canonicalizeJson([, 1]), TypeError);
  assert.throws(() => canonicalizeJson(Number.NaN), TypeError);
  assert.throws(() => canonicalizeJson(Number.POSITIVE_INFINITY), TypeError);
  assert.throws(() => canonicalizeJson(Number.NEGATIVE_INFINITY), TypeError);
  assert.throws(() => canonicalizeJson(new Date('2026-01-01T00:00:00Z')), TypeError);
  assert.throws(() => canonicalizeJson(BigInt(42)), TypeError);
  assert.equal(canonicalizeJson(-0), '0');
  assert.equal(canonicalizeJson({ b: 2, a: undefined, c: 1 }), '{"b":2,"c":1}');
});

test('WU-01: Tightened bot approver detection catches compound variants without false positives', () => {
  for (const bot of ['ClaudeCode', 'codex-agent', 'aibot', 'qaBot', 'gpt4', 'auto-agent', 'CopilotUser']) {
    assert.equal(isBotApprover(bot), true, `Expected bot approver rejection for "${bot}"`);
  }
  for (const human of ['alice', 'bob', 'claire', 'qa-director-zhang', 'david.kim@example.com']) {
    assert.equal(isBotApprover(human), false, `Unexpected false positive on human approver "${human}"`);
  }
});

test('WU-01: Non-TTY governance approve requires explicit --yes when not in CI', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-wu01-nontty-'));
  const keyFile = path.join(tmpDir, 't1.key');
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    await withEnv(
      {
        AITEST_HMAC_KEY_FILE: keyFile,
        AITEST_HMAC_KEY: undefined,
        CI: undefined,
        GITHUB_ACTIONS: undefined,
        AITEST_APPROVE_NON_INTERACTIVE: undefined,
        AITEST_MCP_CHILD: undefined,
      },
      async () => {
        const initCode = await runCli(['init', '--name', 'nontty-app', '--target', repoDir, '--skip-install', '--loop', 'none']);
        assert.equal(initCode, 0);

        const rejectedCode = await runGovernanceCommand({
          action: 'approve',
          target: repoDir,
          by: 'alice@example.com',
          reason: 'legitimate test',
          isTTY: false,
          yes: false,
          env: { AITEST_HMAC_KEY_FILE: keyFile },
        });
        assert.equal(rejectedCode, 2);

        const approvedCode = await runGovernanceCommand({
          action: 'approve',
          target: repoDir,
          by: 'alice@example.com',
          reason: 'legitimate test with --yes',
          isTTY: false,
          yes: true,
          env: { AITEST_HMAC_KEY_FILE: keyFile },
        });
        assert.equal(approvedCode, 0);
      }
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WU-01: Blocks aitest_init governance.lock re-sign bypass after protected file tamper or deletion', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-wu01-init-resign-'));
  const keyFile = path.join(tmpDir, 't1.key');
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    await withEnv({ AITEST_HMAC_KEY_FILE: keyFile, AITEST_HMAC_KEY: undefined }, async () => {
      const initCode = await runCli(['init', '--name', 'resign-app', '--target', repoDir, '--skip-install', '--loop', 'none']);
      assert.equal(initCode, 0);
      const qaDir = path.join(repoDir, 'qa');

      // Attacker tampers playwright.config.ts and deletes governance.lock, then calls MCP aitest_init
      const pwCfg = path.join(qaDir, 'playwright.config.ts');
      fs.appendFileSync(pwCfg, "\n// bypass\n", 'utf8');
      const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
      fs.rmSync(lockPath, { force: true });

      const mcpCtx = { workspaceRoots: [repoDir], jobManager: new McpJobManager() };
      const initReply = await handleMcpJsonRpcMessage(
        {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'aitest_init',
            arguments: { target: repoDir, name: 'resign-app', skipInstall: true, loop: 'none' },
          },
        },
        mcpCtx
      );
      assert.equal(initReply.result.isError, true);
      assert.equal(initReply.result.structuredContent.exitCode, 2);
      assert.equal(fs.existsSync(lockPath), false, 'aitest_init must never recreate deleted governance.lock after tampering');

      // Even if a lock exists with source="aitest-init" against tampered files or stripped manifest digest, gate blocks
      const ctx = openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
      const fakeCore = {
        schemaVersion: 2,
        approvedAt: new Date().toISOString(),
        approvedBy: 'aitest-scaffold',
        gitUserEmail: null,
        gitUserName: null,
        reason: 'forged init lock',
        source: 'aitest-init',
        files: {},
      };
      const fakeSig = signPayloadT1('governance.lock', fakeCore, { trustContext: ctx });
      fs.writeFileSync(lockPath, JSON.stringify({ ...fakeCore, mac: fakeSig.mac, macKeyId: fakeSig.keyId }, null, 2), 'utf8');
      const check = verifyGovernanceLockInQaDir(qaDir, { trustContext: ctx });
      assert.equal(check.ok, false);
      assert.equal(check.status, 'blocked');
      assert.match(check.errors.join('\n'), /templateManifestDigest|template-manifest|differs from factory/);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WU-01: Sticky T1 host blocks stripped MACs across lock, ledger, heal session/ledger, and quarantine', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-wu01-sticky-'));
  const keyFile = path.join(tmpDir, 't1.key');
  const repoDir = path.join(tmpDir, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  try {
    await withEnv({ AITEST_HMAC_KEY_FILE: keyFile, AITEST_HMAC_KEY: undefined }, async () => {
      assert.equal(await runCli(['init', '--name', 'sticky-app', '--target', repoDir, '--skip-install', '--loop', 'none']), 0);
      const qaDir = path.join(repoDir, 'qa');
      assert.equal(fs.existsSync(`${keyFile}.sticky`), true, 'Sticky marker must be recorded once T1 key is created');

      // Create valid run + results
      const began = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir });
      const resultsPath = path.join(qaDir, 'reports', 'results.json');
      fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
      const writeResults = (
        status = 'unexpected',
        errorMsg = "TimeoutError: waiting for getByRole('button', { name: 'Pay' })",
        runId = began.runId
      ) =>
        fs.writeFileSync(
          resultsPath,
          JSON.stringify({
            config: { metadata: { runId } },
            suites: [
              {
                file: 'tests/e2e/home.spec.ts',
                specs: [
                  {
                    title: 'checkout @e2e',
                    line: 4,
                    tests: [
                      {
                        projectName: 'e2e',
                        status,
                        results: status === 'expected' ? [{ duration: 10 }] : [{ error: { message: errorMsg } }],
                      },
                    ],
                  },
                ],
              },
            ],
          }),
          'utf8'
        );
      writeResults('expected');
      finalizeRunLedger(qaDir, began.runId, { exitCode: 0, resultsPath });

      // 1) Strip mac/macs from governance.lock -> blocked on sticky host
      const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
      const origLock = fs.readFileSync(lockPath, 'utf8');
      const strippedLock = JSON.parse(origLock);
      delete strippedLock.mac;
      delete strippedLock.macs;
      delete strippedLock.macKeyId;
      fs.writeFileSync(lockPath, JSON.stringify(strippedLock, null, 2), 'utf8');
      const lockAudit = runAuditForQaDir(qaDir, { staticOnly: true });
      assert.equal(lockAudit.ok, false);
      assert.equal(lockAudit.outcome, 'blocked');
      assert.match(lockAudit.errors.join('\n'), /Missing required T1 HMAC signature/);
      fs.writeFileSync(lockPath, origLock, 'utf8');

      // 2) Strip mac from ledger manifest.json -> blocked on sticky host
      const manifestPath = path.join(qaDir, '.aitest', 'runs', began.runId, 'manifest.json');
      const origManifest = fs.readFileSync(manifestPath, 'utf8');
      const strippedManifest = JSON.parse(origManifest);
      delete strippedManifest.mac;
      delete strippedManifest.macKeyId;
      fs.writeFileSync(manifestPath, JSON.stringify(strippedManifest, null, 2), 'utf8');
      const ledgerAudit = runAuditForQaDir(qaDir);
      assert.equal(ledgerAudit.ok, false);
      assert.equal(ledgerAudit.outcome, 'blocked');
      assert.match(ledgerAudit.errors.join('\n'), /Missing required T1 HMAC signature/);
      fs.writeFileSync(manifestPath, origManifest, 'utf8');

      // 3) Emptied quarantine.json with stripped mac on sticky host -> blocked
      syncQuarantineFromLedger(qaDir, { maxQuarantined: 5 });
      const qPath = path.join(qaDir, '.aitest', 'quarantine.json');
      fs.writeFileSync(qPath, JSON.stringify({ schemaVersion: 1, entries: [] }, null, 2), 'utf8');
      const qAudit = runAuditForQaDir(qaDir, { staticOnly: true });
      assert.equal(qAudit.ok, false);
      assert.equal(qAudit.outcome, 'blocked');
      fs.rmSync(qPath, { force: true });

      // 4) Heal session + ledger stripping + deleted heals/ledger.json while session exists
      const failRun = beginRunLedger(qaDir, { suite: 'e2e', command: 'playwright test', repoDir });
      writeResults('unexpected', undefined, failRun.runId);
      finalizeRunLedger(qaDir, failRun.runId, { exitCode: 1, resultsPath });
      const healBegin = beginHealSession(qaDir, { resultsPath });
      assert.equal(healBegin.ok, true);
      const sid = healBegin.session.sessionId;
      const sPath = path.join(qaDir, '.aitest', 'heals', `${sid}.json`);
      const hLedgerPath = path.join(qaDir, '.aitest', 'heals', 'ledger.json');
      const origSession = fs.readFileSync(sPath, 'utf8');
      const strippedSession = JSON.parse(origSession);
      delete strippedSession.mac;
      delete strippedSession.macKeyId;
      fs.writeFileSync(sPath, JSON.stringify(strippedSession, null, 2), 'utf8');
      const healAttemptBlocked = await attemptHealRepair(qaDir, { sessionId: sid, skipRun: true });
      assert.equal(healAttemptBlocked.ok, false);
      assert.equal(healAttemptBlocked.exitCode, 2);
      const conflictRes = checkHealSessionConflicts(qaDir, { isGitRepo: false });
      assert.equal(conflictRes.ok, false);
      fs.writeFileSync(sPath, origSession, 'utf8');

      // Delete heals/ledger.json while session file still exists
      fs.rmSync(hLedgerPath, { force: true });
      const missingLedgerConflict = checkHealSessionConflicts(qaDir, { isGitRepo: false });
      assert.equal(missingLedgerConflict.ok, false);
      assert.match(missingLedgerConflict.errors.join('\n'), /ledger\.json.*missing/i);
    });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WU-01: Multi-key macs treats foreign keyId as T0 but hard-blocks local keyId mismatch with keySource/keyId details', () => {
  const payload = { hello: 'world', n: 1 };
  const keyA = 'key-a-secret-material-0123456789abcdef';
  const keyB = 'key-b-secret-material-0123456789abcdef';
  const keyC = 'key-c-secret-material-0123456789abcdef';
  const ctxA = openTrustContext({ env: { AITEST_HMAC_KEY: keyA } });
  const ctxB = openTrustContext({ env: { AITEST_HMAC_KEY: keyB } });
  const ctxC = openTrustContext({ env: { AITEST_HMAC_KEY: keyC } });

  const sigA = signPayloadT1('governance.lock', payload, { trustContext: ctxA });
  const sigB = signPayloadT1('governance.lock', payload, { trustContext: ctxB });
  const macs = { [sigA.keyId]: sigA.mac, [sigB.keyId]: sigB.mac };

  // Local A and Local B both verify T1
  assert.equal(verifyPayloadT1('governance.lock', payload, sigB.mac, { macs, trustContext: ctxA }).trustTier, 'T1');
  assert.equal(verifyPayloadT1('governance.lock', payload, sigB.mac, { macs, trustContext: ctxB }).trustTier, 'T1');

  // Foreign C (not in macs) returns ok: true, foreign: true, trustTier: 'T0'
  const foreignCheck = verifyPayloadT1('governance.lock', payload, sigB.mac, { macs, trustContext: ctxC });
  assert.equal(foreignCheck.ok, true);
  assert.equal(foreignCheck.foreign, true);
  assert.equal(foreignCheck.trustTier, 'T0');

  // Local A present in macs with wrong MAC -> hard blocked with keySource and keyId
  const badMacs = { [sigA.keyId]: 'hmac-sha256:' + '0'.repeat(64), [sigB.keyId]: sigB.mac };
  const localMismatch = verifyPayloadT1('governance.lock', payload, sigB.mac, { macs: badMacs, trustContext: ctxA });
  assert.equal(localMismatch.ok, false);
  assert.match(localMismatch.reason, /keySource=env:AITEST_HMAC_KEY/);
  assert.ok(localMismatch.reason.includes(computeKeyId(keyA)));
});

test('WU-01: MCP child retains AITEST_HMAC_KEY_FILE while Playwright child env strips all sensitive credentials', () => {
  const fakeEnv = {
    PATH: process.env.PATH || '',
    AITEST_HMAC_KEY_FILE: '/tmp/host-t1.key',
    AITEST_HMAC_KEY: 'super-secret-raw-hmac-key',
    AITEST_MCP_TOKEN: 'mcp-secret',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-jwt-req-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://token.actions.githubusercontent.com',
    AWS_SECRET_ACCESS_KEY: 'aws-secret',
    OPENAI_API_KEY: 'sk-test-secret',
    TEST_BASE_URL: 'http://127.0.0.1:3000',
    PLAYWRIGHT_BROWSERS_PATH: '0',
  };

  const mcpChildEnv = buildSafeChildEnv(fakeEnv);
  assert.equal(mcpChildEnv.AITEST_HMAC_KEY_FILE, '/tmp/host-t1.key');
  assert.equal(mcpChildEnv.AITEST_HMAC_KEY, undefined);
  assert.equal(mcpChildEnv.AITEST_MCP_TOKEN, undefined);

  const pwEnv = buildPlaywrightChildEnv(fakeEnv);
  assert.equal(pwEnv.AITEST_HMAC_KEY_FILE, undefined);
  assert.equal(pwEnv.AITEST_HMAC_KEY, undefined);
  assert.equal(pwEnv.AITEST_MCP_TOKEN, undefined);
  assert.equal(pwEnv.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
  assert.equal(pwEnv.ACTIONS_ID_TOKEN_REQUEST_URL, undefined);
  assert.equal(pwEnv.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(pwEnv.OPENAI_API_KEY, undefined);
  assert.equal(pwEnv.TEST_BASE_URL, 'http://127.0.0.1:3000');
  assert.equal(pwEnv.PLAYWRIGHT_BROWSERS_PATH, '0');
});
