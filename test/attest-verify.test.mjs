import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/cli.mjs';
import {
  TRUST_LEVEL_DEFINITIONS,
  buildInTotoVerdictAttestation,
  verifyAttestationFile,
} from '../src/trust.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, 'fixtures', 't2-attestation');
const ROOT_CA_PEM = path.join(FIXTURES, 'trusted-root-ca.pem');
const VALID_ATT = path.join(FIXTURES, 'valid-attestation.json');
const VALID_BUNDLE = path.join(FIXTURES, 'valid-t2.sigstore.json');
const WRONG_ISSUER_BUNDLE = path.join(FIXTURES, 'wrong-issuer-t2.sigstore.json');
const UNTRUSTED_BUNDLE = path.join(FIXTURES, 'untrusted-selfsigned.sigstore.json');

test('Offline T2 Attestation Verification: valid Sigstore bundle passes with trustLevel=T2 & matching repo/workflow/ref (zero network)', async () => {
  const res = verifyAttestationFile(VALID_ATT, {
    bundlePath: VALID_BUNDLE,
    expectRepo: 'seaworld008/ai-test-workbench',
    expectWorkflow: '.github/workflows/aitest-verify.yml',
    expectRef: 'refs/heads/main',
    trustedRootCertPath: ROOT_CA_PEM,
  });

  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.equal(res.trustLevel, 'T2');
  assert.equal(res.mergeGradeGreen, true);
  assert.equal(res.reasonCode, 'T2_VERIFIED');
  assert.equal(res.identity?.oidcIssuer, 'https://token.actions.githubusercontent.com');
  assert.equal(res.identity?.repo, 'seaworld008/ai-test-workbench');
  assert.equal(res.identity?.workflow, '.github/workflows/aitest-verify.yml');
  assert.equal(res.identity?.ref, 'refs/heads/main');

  // Also test real CLI exit code 0
  const cliExit = await runCli([
    'attest',
    'verify',
    '--file',
    VALID_ATT,
    '--bundle',
    VALID_BUNDLE,
    '--expect-repo',
    'seaworld008/ai-test-workbench',
    '--expect-workflow',
    'aitest-verify.yml',
    '--expect-ref',
    'refs/heads/main',
    '--trusted-root-cert',
    ROOT_CA_PEM,
  ]);
  assert.equal(cliExit, 0);
});

test('Offline T2 Attestation Verification: rejects T1 evidence masquerading as T2 (trustLevel <= T1, non-zero exit)', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-t1-masq-'));
  const prevKey = process.env.AITEST_HMAC_KEY;
  process.env.AITEST_HMAC_KEY = 'offline-test-t1-hmac-key-0123456789abcdef';
  try {
    const qaDir = path.join(tmpDir, 'qa');
    fs.mkdirSync(qaDir, { recursive: true });
    // Build a locally signed T1 attestation that falsely claims trustLevel: 'T2'
    const statement = buildInTotoVerdictAttestation({
      repoDir: tmpDir,
      qaDir,
      gateKernelVersion: '5.1.0',
      verdictPayload: {
        gitSha: 'deadbeef0123456789',
        verdict: 'pass',
        trustTier: 'T2',
        trustLevel: 'T2',
        runId: '01MASQUERADE00000000000000',
        acceptanceScope: 'business-e2e',
        gates: { governance: 'pass', static: 'pass', runtime: 'pass', semanticDiff: 'pass' },
      },
    });
    const attPath = path.join(qaDir, 'attestation.json');
    fs.writeFileSync(attPath, JSON.stringify(statement, null, 2) + '\n', 'utf8');

    const res = verifyAttestationFile(attPath, {
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
    });
    assert.equal(res.ok, false);
    assert.equal(res.trustLevel, 'T1');
    assert.equal(res.mergeGradeGreen, false);
    assert.equal(res.reasonCode, 'T1_ONLY_NOT_T2');

    const cliExit = await runCli([
      'attest',
      'verify',
      '--file',
      attPath,
      '--expect-repo',
      'seaworld008/ai-test-workbench',
    ]);
    assert.notEqual(cliExit, 0);
  } finally {
    if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY;
    else process.env.AITEST_HMAC_KEY = prevKey;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Offline T2 Attestation Verification: rejects wrong workflow, wrong repo, wrong ref, and wrong OIDC issuer', async () => {
  // Wrong workflow
  const badWf = verifyAttestationFile(VALID_ATT, {
    bundlePath: VALID_BUNDLE,
    expectRepo: 'seaworld008/ai-test-workbench',
    expectWorkflow: '.github/workflows/ci-other.yml',
    expectRef: 'refs/heads/main',
    trustedRootCertPath: ROOT_CA_PEM,
  });
  assert.equal(badWf.ok, false);
  assert.notEqual(badWf.trustLevel, 'T2');
  assert.equal(badWf.reasonCode, 'WORKFLOW_IDENTITY_MISMATCH');

  // Wrong repo
  const badRepo = verifyAttestationFile(VALID_ATT, {
    bundlePath: VALID_BUNDLE,
    expectRepo: 'attacker/forked-repo',
    expectWorkflow: '.github/workflows/aitest-verify.yml',
    trustedRootCertPath: ROOT_CA_PEM,
  });
  assert.equal(badRepo.ok, false);
  assert.equal(badRepo.reasonCode, 'WORKFLOW_IDENTITY_MISMATCH');

  // Wrong ref
  const badRef = verifyAttestationFile(VALID_ATT, {
    bundlePath: VALID_BUNDLE,
    expectRepo: 'seaworld008/ai-test-workbench',
    expectWorkflow: '.github/workflows/aitest-verify.yml',
    expectRef: 'refs/heads/release',
    trustedRootCertPath: ROOT_CA_PEM,
  });
  assert.equal(badRef.ok, false);
  assert.equal(badRef.reasonCode, 'WORKFLOW_IDENTITY_MISMATCH');

  // Wrong OIDC issuer (not https://token.actions.githubusercontent.com)
  const badIssuer = verifyAttestationFile(VALID_ATT, {
    bundlePath: WRONG_ISSUER_BUNDLE,
    expectRepo: 'seaworld008/ai-test-workbench',
    expectWorkflow: '.github/workflows/aitest-verify.yml',
    expectRef: 'refs/heads/main',
    trustedRootCertPath: ROOT_CA_PEM,
  });
  assert.equal(badIssuer.ok, false);
  assert.notEqual(badIssuer.trustLevel, 'T2');
  assert.equal(badIssuer.reasonCode, 'OIDC_ISSUER_MISMATCH');

  const cliExit = await runCli([
    'attest',
    'verify',
    '--file',
    VALID_ATT,
    '--bundle',
    VALID_BUNDLE,
    '--expect-workflow',
    '.github/workflows/wrong.yml',
    '--trusted-root-cert',
    ROOT_CA_PEM,
  ]);
  assert.notEqual(cliExit, 0);
});

test('Offline T2 Attestation Verification: rejects 1-byte tampered attestation.json and untrusted self-signed cert chain', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-tamper-1b-'));
  try {
    // 1-byte tamper: append a single trailing space to attestation.json (valid JSON, 1-byte changed!)
    const raw = fs.readFileSync(VALID_ATT, 'utf8');
    const tamperedPath = path.join(tmpDir, 'tampered-1byte.json');
    fs.writeFileSync(tamperedPath, raw + ' ', 'utf8');

    const tamperRes = verifyAttestationFile(tamperedPath, {
      bundlePath: VALID_BUNDLE,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      trustedRootCertPath: ROOT_CA_PEM,
    });
    assert.equal(tamperRes.ok, false);
    assert.equal(tamperRes.trustLevel, 'T0');
    assert.equal(tamperRes.mergeGradeGreen, false);
    assert.equal(tamperRes.reasonCode, 'DIGEST_MISMATCH');

    const cliExit = await runCli([
      'attest',
      'verify',
      '--file',
      tamperedPath,
      '--bundle',
      VALID_BUNDLE,
      '--expect-repo',
      'seaworld008/ai-test-workbench',
      '--trusted-root-cert',
      ROOT_CA_PEM,
    ]);
    assert.notEqual(cliExit, 0);

    // Untrusted self-signed certificate bundle attempting to forge T2
    const untrustedRes = verifyAttestationFile(VALID_ATT, {
      bundlePath: UNTRUSTED_BUNDLE,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      trustedRootCertPath: ROOT_CA_PEM,
    });
    assert.equal(untrustedRes.ok, false);
    assert.equal(untrustedRes.trustLevel, 'T0');
    assert.equal(untrustedRes.reasonCode, 'UNTRUSTED_CERT_CHAIN');

    // Canonical trust level definitions invariant
    assert.equal(TRUST_LEVEL_DEFINITIONS.T0.mergeGradeGreen, false);
    assert.equal(TRUST_LEVEL_DEFINITIONS.T1.mergeGradeGreen, false);
    assert.equal(TRUST_LEVEL_DEFINITIONS.T2.mergeGradeGreen, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
