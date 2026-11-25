import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildInTotoVerdictAttestation, verifyAttestationFile } from '../../src/app/index.mjs';
import { redactSecrets, redactStructuredValue } from '../../src/core/redact.mjs';
import {
  checkOutgoingRequestSafety,
  computeNextRedirectRequest,
  evaluateTargetSafety,
} from '../../src/kernel/target-guard.mjs';
import { createMcpHttpServer } from '../../src/mcp-server.mjs';
import { runReadOnlyApiBenchmark } from '../../src/perf/collectors.mjs';
import { createEphemeralFulcioCa } from '../../bench/agentic/lib/t2-ca.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(__dirname, '..', 'fixtures', 't2-attestation');
const ROOT_CA_PEM = path.join(FIXTURES, 'trusted-root-ca.pem');
const ROOT_CA_SHA256 = crypto
  .createHash('sha256')
  .update(new crypto.X509Certificate(fs.readFileSync(ROOT_CA_PEM, 'utf8')).raw)
  .digest('hex');
const VALID_ATT = path.join(FIXTURES, 'valid-attestation.json');
const VALID_BUNDLE = path.join(FIXTURES, 'valid-t2.sigstore.json');

test('WU-03: Redirect semantics & live HTTP 302 redirect bypass to non-allowlisted host are blocked', async () => {
  // 1. 301/302/303 downgrade POST -> GET and strip content headers + cross-origin auth headers
  const r302 = computeNextRedirectRequest(
    'POST',
    302,
    'https://other.example.com/landing',
    'http://127.0.0.1:4100/submit',
    { authorization: 'Bearer tok', cookie: 'sid=1', 'content-type': 'application/json', 'x-trace': 'ok' }
  );
  assert.equal(r302.method, 'GET');
  assert.equal(r302.dropBody, true);
  assert.equal(r302.crossOrigin, true);
  assert.equal(r302.headers.authorization, undefined);
  assert.equal(r302.headers.cookie, undefined);
  assert.equal(r302.headers['content-type'], undefined);
  assert.equal(r302.headers['x-trace'], 'ok');

  // 2. 307/308 preserve POST method & body
  const r307 = computeNextRedirectRequest('POST', 307, '/v2/submit', 'http://127.0.0.1:4100/v1/submit', {
    'content-type': 'application/json',
  });
  assert.equal(r307.method, 'POST');
  assert.equal(r307.dropBody, false);
  assert.equal(r307.headers['content-type'], 'application/json');

  // 3. Invalid TEST_EGRESS_MODE fails closed & exact host:port matching on baseURL
  const badEnv = evaluateTargetSafety({
    TEST_ENV: 'local',
    TEST_BASE_URL: 'http://127.0.0.1:4100',
    TEST_EGRESS_MODE: 'allow-list',
  });
  assert.equal(badEnv.ok, false);
  assert.match(badEnv.errors.join(' '), /Invalid TEST_EGRESS_MODE/i);

  const badCheck = checkOutgoingRequestSafety('GET', 'http://127.0.0.1:4100/api', {
    egressMode: 'allow-list',
  });
  assert.equal(badCheck.blocked, true);

  // Port-exact implicit baseURL check when allowedHosts has no hostname wildcard
  const diffPort = checkOutgoingRequestSafety('GET', 'http://127.0.0.1:9999/secret', {
    baseURL: 'http://127.0.0.1:4100',
    allowedHosts: [],
    egressMode: 'allowlist',
  });
  assert.equal(diffPort.blocked, true);

  // 4. Live HTTP server returning 302 -> blocked external host must be caught in runReadOnlyApiBenchmark
  const srv = http.createServer((req, res) => {
    res.writeHead(302, { Location: 'https://evil-exfil.example.org/steal' });
    res.end();
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  try {
    const benchOut = await runReadOnlyApiBenchmark(`http://127.0.0.1:${port}/redir`, 1, 2, {
      baseURL: `http://127.0.0.1:${port}`,
      allowedHosts: ['127.0.0.1'],
      egressMode: 'allowlist',
    });
    assert.equal(benchOut.errorCount, 2, 'Every 302 redirect to non-allowlisted host must fail closed');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('WU-03: MCP HTTP/SSE enforces 421 Host validation, 415 Content-Type, 409 duplicate GET SSE, and batch <= 16 cap', async () => {
  const server = createMcpHttpServer({ host: '127.0.0.1', authToken: 'wu03-tok' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // 1. Wrong Content-Type -> 415
    const wrongCt = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        Authorization: 'Bearer wu03-tok',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    assert.equal(wrongCt.status, 415);

    // 2. Spoofed Host header on GET /sse -> 421
    const rawHostRes = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'GET',
          path: '/sse',
          headers: {
            Host: 'evil.attacker.internal:8080',
            Authorization: 'Bearer wu03-tok',
          },
        },
        (res) => resolve(res.statusCode)
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rawHostRes, 421);

    // 3. Initialize 2025-03-26 batch-capable session & reject batch length > 16
    const initRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer wu03-tok' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-03-26' } }),
    });
    assert.equal(initRes.status, 200);
    const sid = initRes.headers.get('mcp-session-id');
    assert.ok(sid);

    const bigBatch = Array.from({ length: 17 }, (_, i) => ({ jsonrpc: '2.0', id: 100 + i, method: 'ping' }));
    const batchRes = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer wu03-tok',
        'Mcp-Session-Id': sid,
      },
      body: JSON.stringify(bigBatch),
    });
    assert.equal(batchRes.status, 400);

    // 4. Duplicate GET /mcp SSE stream -> 409 Conflict
    const ac1 = new AbortController();
    const sse1 = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { Authorization: 'Bearer wu03-tok', 'Mcp-Session-Id': sid },
      signal: ac1.signal,
    });
    assert.equal(sse1.status, 200);
    const sse2 = await fetch(`${baseUrl}/mcp`, {
      method: 'GET',
      headers: { Authorization: 'Bearer wu03-tok', 'Mcp-Session-Id': sid },
    });
    assert.equal(sse2.status, 409);
    ac1.abort();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('WU-03: Redaction v3 strips infix keys, modern SaaS/LLM tokens, Slack webhooks, AccountKey, and cookies/localStorage', () => {
  const sample = [
    'AWS_SECRET_ACCESS_KEY=myInfixSecret123456',
    `anthropic=sk-ant-${'api03-abcdef1234567890abcdef'}`,
    `svc=sk-svc${'acct-1234567890abcdef1234'}`,
    `stripe_test=sk_test_${'51N9x8Abcdef1234567890'}`,
    `google=AIza${'SyDaGmWKa4JsXZ-HjGw7ISLn_3namBGt2E'}`,
    `npm_tok=npm_${'1234567890abcdef1234567890'}`,
    `hook=https://hooks.${'slack.com/services/T00000000/B00000000/'}${'XXXXXXXXXXXXXXXXXXXXXXXX'}`,
    'conn=DefaultEndpointsProtocol=https;AccountName=dev;AccountKey=abc123def456ghi789/+==;',
    'X-Api-Key: secret-api-key-999',
  ].join('\n');

  const clean = redactSecrets(sample);
  for (const leaked of [
    'myInfixSecret123456',
    `sk-ant-${'api03'}`,
    `sk-svc${'acct-123456'}`,
    `sk_test_${'51N9x8'}`,
    `AIza${'SyDaGmWKa4'}`,
    `npm_${'1234567890'}`,
    `hooks.${'slack.com/services/T00000000'}`,
    'abc123def456ghi789',
    'secret-api-key-999',
  ]) {
    assert.equal(clean.includes(leaked), false, `Redaction v3 missed "${leaked}"`);
  }

  const scrubbed = redactStructuredValue({
    sessionId: 'heal_deadbeef1234',
    cookies: [{ name: 'sid', value: 'raw-cookie-val' }],
    origins: [
      {
        origin: 'http://localhost:3000',
        localStorage: [
          { name: 'auth_token', value: 'raw-ls-jwt-value' },
          { name: 'theme', value: 'dark' },
        ],
      },
    ],
  });
  assert.equal(scrubbed.sessionId, 'heal_deadbeef1234');
  assert.equal(scrubbed.cookies[0].value, '[REDACTED]');
  assert.equal(scrubbed.origins[0].localStorage[0].value, '[REDACTED]');
  assert.equal(scrubbed.origins[0].localStorage[1].value, 'dark');
});

test('WU-03: Attestation enforces --expect-git-sha, --expect-tree-digest, and marks unpinned custom root mergeGradeGreen=false', () => {
  // Unpinned custom root -> trustRoot='custom', mergeGradeGreen=false
  const unpinned = verifyAttestationFile(VALID_ATT, {
    bundlePath: VALID_BUNDLE,
    expectRepo: 'seaworld008/ai-test-workbench',
    expectWorkflow: '.github/workflows/aitest-verify.yml',
    expectRef: 'refs/heads/main',
    trustedRootCertPath: ROOT_CA_PEM,
  });
  assert.equal(unpinned.ok, true);
  assert.equal(unpinned.trustRoot, 'custom');
  assert.equal(unpinned.mergeGradeGreen, false);

  // Wrong trustedRootSha256 pin -> rejected
  const wrongPin = verifyAttestationFile(VALID_ATT, {
    bundlePath: VALID_BUNDLE,
    trustedRootCertPath: ROOT_CA_PEM,
    trustedRootSha256: '0'.repeat(64),
  });
  assert.equal(wrongPin.ok, false);
  assert.equal(wrongPin.reasonCode, 'TRUSTED_ROOT_FINGERPRINT_MISMATCH');

  // Expect git SHA & tree digest binding
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-wu03-att-'));
  try {
    const qaDir = path.join(tmpDir, 'qa');
    fs.mkdirSync(qaDir, { recursive: true });
    const ca = createEphemeralFulcioCa('WU03 Pin CA');
    const statement = buildInTotoVerdictAttestation({
      repoDir: tmpDir,
      qaDir,
      treeDigest: 'treehash9999999999',
      gateKernelVersion: '6.1.0',
      verdictPayload: {
        gitSha: 'commitsha123456',
        verdict: 'pass',
        trustTier: 'T2',
        trustLevel: 'T2',
        runId: '01WU03ATTEST00000000000000',
        acceptanceScope: 'business-e2e',
        gates: { governance: 'pass', static: 'pass', runtime: 'pass', semanticDiff: 'pass' },
      },
    });
    const attPath = path.join(qaDir, 'att.json');
    const bundlePath = path.join(qaDir, 'att.sigstore.json');
    fs.writeFileSync(attPath, JSON.stringify(statement, null, 2) + '\n', 'utf8');
    ca.signAttestationFile(attPath, {
      repo: 'seaworld008/ai-test-workbench',
      workflow: '.github/workflows/aitest-verify.yml',
      ref: 'refs/heads/main',
      bundleOutPath: bundlePath,
    });

    const okBound = verifyAttestationFile(attPath, {
      bundlePath,
      expectRepo: 'seaworld008/ai-test-workbench',
      expectWorkflow: '.github/workflows/aitest-verify.yml',
      expectRef: 'refs/heads/main',
      expectGitSha: 'commitsha123456',
      expectTreeDigest: 'treehash9999999999',
      trustedRootCertPem: ca.rootCertPem,
      trustedRootSha256: ca.rootCertSha256,
    });
    assert.equal(okBound.ok, true, okBound.errors.join('\n'));
    assert.equal(okBound.trustRoot, 'pinned-custom');
    assert.equal(okBound.mergeGradeGreen, true);

    const badSha = verifyAttestationFile(attPath, {
      bundlePath,
      expectGitSha: 'othercommit000',
      trustedRootCertPem: ca.rootCertPem,
      trustedRootSha256: ca.rootCertSha256,
    });
    assert.equal(badSha.ok, false);
    assert.equal(badSha.reasonCode, 'GIT_SHA_MISMATCH');

    const badTree = verifyAttestationFile(attPath, {
      bundlePath,
      expectTreeDigest: 'othertree000',
      trustedRootCertPem: ca.rootCertPem,
      trustedRootSha256: ca.rootCertSha256,
    });
    assert.equal(badTree.ok, false);
    assert.equal(badTree.reasonCode, 'TREE_DIGEST_MISMATCH');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
