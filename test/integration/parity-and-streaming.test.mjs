import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../src/cli.mjs';
import { handleMcpJsonRpcMessage } from '../../src/mcp-server.mjs';
import { loadParityRequests, runParityCommand, runParityCore, validateDualTargetSafety } from '../../src/parity.mjs';
import { checkOutgoingRequestSafety } from '../../src/origin-guard.mjs';
import { runPerfCommand } from '../../src/perf.mjs';
import {
  computeRequestShapeHash,
  loadVerifiedUpstreamCassette,
  startCassetteReplayServer,
} from '../../src/replay/cassette.mjs';
import { verifyChangeCore } from '../../src/verdict.mjs';
import { runVerdictParityHook } from '../../src/verdict/parity-hook.mjs';
import { hasPlaywrightChromium } from '../fixtures/playwright-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..', '..');
const TEMPLATE_MODULES = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa', 'node_modules');

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function startDualTargetServer(mode) {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const urlPath = (req.url || '/').split('?')[0];
      if (urlPath === '/api/health') {
        res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': `req_${mode}_${Date.now()}` });
        res.end(JSON.stringify({ ok: true, requestId: `r_${mode}_${Math.random()}` }));
        return;
      }
      if (urlPath === '/api/orders') {
        const status = mode === 'candidate-buggy' ? 201 : 409;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: status === 409 ? 'DUPLICATE' : 'CREATED', secretCustomer: 'TOP_SECRET_BUYER_777' }));
        return;
      }
      if (urlPath === '/api/emoji') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        if (mode === 'candidate-buggy') {
          res.end('{"text":"Rocket 🚀","secretNote":"PRIVATE_EMOJI_NOTE_42"}');
        } else {
          res.end('{"text":"Rocket \\ud83d\\ude80","secretNote":"PRIVATE_EMOJI_NOTE_42"}');
        }
        return;
      }
      if (urlPath === '/api/stream') {
        const delay = mode === 'slow-sse' ? 45 : 0;
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
        const emit = () => {
          if (mode === 'candidate-buggy') {
            res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"drifted"}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          } else if (mode === 'error-sse') {
            res.write('event: error\ndata: {"type":"error","error":{"message":"boom","code":500}}\n\n');
          } else {
            res.write('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5}}}\n\n');
            res.write('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}\n\n');
            res.write('event: message_stop\ndata: {"type":"message_stop"}\n\n');
          }
          res.end();
        };
        if (delay > 0) setTimeout(emit, delay);
        else emit();
        return;
      }
      if (urlPath === '/api/redirect-evil') {
        res.writeHead(302, { Location: 'https://evil.example.com/steal' });
        res.end();
        return;
      }
      if (urlPath === '/page') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(
          mode === 'candidate-buggy'
            ? '<!doctype html><html><body><main><h1>Changed Heading</h1></main></body></html>'
            : '<!doctype html><html><body><main><h1>Stable Heading</h1></main></body></html>'
        );
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ path: urlPath, idx: req.url }));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

async function humanApprove(tmpRepo, reason) {
  const saved = {
    AITEST_MCP_SUBPROCESS: process.env.AITEST_MCP_SUBPROCESS,
    AITEST_APPROVE_NON_INTERACTIVE: process.env.AITEST_APPROVE_NON_INTERACTIVE,
    ANTIGRAVITY_CONVERSATION_ID: process.env.ANTIGRAVITY_CONVERSATION_ID,
    CLAUDECODE: process.env.CLAUDECODE,
    CODEX_CI: process.env.CODEX_CI,
    CODEX_SANDBOX: process.env.CODEX_SANDBOX,
    CURSOR_TRACE_ID: process.env.CURSOR_TRACE_ID,
    AIDER_MODEL: process.env.AIDER_MODEL,
  };
  delete process.env.AITEST_MCP_SUBPROCESS;
  delete process.env.ANTIGRAVITY_CONVERSATION_ID;
  delete process.env.CLAUDECODE;
  delete process.env.CODEX_CI;
  delete process.env.CODEX_SANDBOX;
  delete process.env.CURSOR_TRACE_ID;
  delete process.env.AIDER_MODEL;
  process.env.AITEST_APPROVE_NON_INTERACTIVE = '1';
  try {
    const code = await runCli([
      'governance',
      'approve',
      '--target',
      tmpRepo,
      '--by',
      'alice@example.com',
      '--reason',
      reason,
      '--yes',
      '--json',
    ]);
    assert.equal(code, 0, 'Human governance approve should succeed');
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

test('Dual-target parity executes 100 mixed JSON + SSE samples in < 1.0s, catches CP1..CP3 diffs with shape-only zero-plaintext privacy, and blocks production targets', async () => {
  const baseline = await startDualTargetServer('baseline');
  const candSame = await startDualTargetServer('baseline');
  const candBuggy = await startDualTargetServer('candidate-buggy');
  const tmpRepo = makeTempDir('aitest-parity-100-');

  try {
    await runCli(['init', '--name', 'parity-demo', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');
    fs.writeFileSync(
      path.join(qaDir, '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${candSame.url}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\n`,
      'utf8'
    );

    // Build 100 mixed JSON + SSE corpus samples
    const corpusDir = path.join(qaDir, 'corpus');
    fs.mkdirSync(corpusDir, { recursive: true });
    const corpus100Path = path.join(corpusDir, 'sanitized-requests.jsonl');
    const lines = [];
    for (let i = 0; i < 100; i += 1) {
      if (i % 5 === 0) {
        lines.push(JSON.stringify({ id: `req_${i}`, method: 'GET', path: '/api/stream', headers: { accept: 'text/event-stream' }, body: null, featureCohort: ['streaming'] }));
      } else {
        lines.push(JSON.stringify({ id: `req_${i}`, method: 'GET', path: `/api/item?n=${i}`, headers: {}, body: null, featureCohort: ['json-payload'] }));
      }
    }
    fs.writeFileSync(corpus100Path, lines.join('\n') + '\n', 'utf8');

    // 1. 100-sample performance SLA (< 1000ms)
    const fastRes = await runParityCore({
      target: tmpRepo,
      baselineUrl: baseline.url,
      candidateUrl: candSame.url,
      concurrency: 8,
    });
    assert.equal(fastRes.ok, true);
    assert.equal(fastRes.totalSamples, 100);
    assert.equal(fastRes.matchedSamples, 100);
    assert.equal(fastRes.parityPct, 100);
    assert.ok(fastRes.elapsedMs < 1000, `Expected 100 mixed JSON+SSE parity samples < 1000ms, took ${fastRes.elapsedMs}ms`);
    console.log(`[Parity 100-Sample Benchmark] elapsedMs=${fastRes.elapsedMs}ms (100 mixed JSON+SSE samples, concurrency=8)`);

    // 1b. CLI dry-run, missing-arg, missing-corpus, knowledge fallback & redirect-hop guard
    assert.equal(await runParityCommand({ target: tmpRepo, baselineUrl: baseline.url, candidateUrl: candSame.url, dryRun: true }), 0);
    assert.equal(await runParityCommand({ target: tmpRepo, json: true }), 64);
    assert.equal(await runParityCommand({ target: tmpRepo, baselineUrl: baseline.url, candidateUrl: candSame.url, corpus: 'corpus/does-not-exist.jsonl', json: true }), 1);

    const redirBlocked = await runParityCore({
      target: tmpRepo,
      baselineUrl: baseline.url,
      candidateUrl: candSame.url,
      routes: '/api/redirect-evil',
    });
    assert.equal(redirBlocked.ok, false);
    assert.equal(redirBlocked.outcome, 'blocked');
    assert.equal(redirBlocked.exitCode, 2);

    // Knowledge fallback priority: api-schemas.json -> code-map.json -> '/'
    const fallbackQa = makeTempDir('aitest-parity-fb-');
    try {
      assert.equal(loadParityRequests(fallbackQa).requests[0].path, '/');
      fs.mkdirSync(path.join(fallbackQa, 'knowledge'), { recursive: true });
      fs.writeFileSync(path.join(fallbackQa, 'knowledge', 'code-map.json'), JSON.stringify({ routes: { '/dashboard': {} } }), 'utf8');
      assert.equal(loadParityRequests(fallbackQa).requests[0].path, '/dashboard');
      fs.writeFileSync(
        path.join(fallbackQa, 'knowledge', 'api-schemas.json'),
        JSON.stringify({ endpoints: [{ method: 'GET', pathname: '/api/catalog' }] }),
        'utf8'
      );
      assert.equal(loadParityRequests(fallbackQa).requests[0].path, '/api/catalog');
    } finally {
      fs.rmSync(fallbackQa, { recursive: true, force: true });
    }

    // Optional CP4 ARIA snapshot diff when Chromium is present
    if (hasPlaywrightChromium(TEMPLATE_MODULES)) {
      if (!fs.existsSync(path.join(qaDir, 'node_modules'))) {
        fs.symlinkSync(TEMPLATE_MODULES, path.join(qaDir, 'node_modules'), 'junction');
      }
      const ariaDiff = await runParityCore({
        target: tmpRepo,
        baselineUrl: baseline.url,
        candidateUrl: candBuggy.url,
        routes: '/page',
        checkAria: true,
      });
      assert.equal(ariaDiff.ok, false);
      assert.ok(ariaDiff.clusters.some((c) => c.checkpoint === 'CP4-DOM-ARIA-And-Runtime' || c.diffKind === 'text-mismatch'));
    }

    // Verdict parity hook direct edge cases (missing baselineUrl, missing candidate, blocked prod, matching pass)
    const hookMissingBase = await runVerdictParityHook({ target: tmpRepo, lang: 'en', requestedMode: 'parity', effectiveBaseUrl: candSame.url, options: {} });
    assert.equal(hookMissingBase?.blocked, true);
    const hookMissingCand = await runVerdictParityHook({ target: tmpRepo, lang: 'en', requestedMode: 'parity', effectiveBaseUrl: null, options: { baselineUrl: baseline.url } });
    assert.equal(hookMissingCand?.blocked, true);
    const hookProdBlocked = await runVerdictParityHook({ target: tmpRepo, lang: 'en', requestedMode: 'parity', effectiveBaseUrl: candSame.url, options: { baselineUrl: 'https://api.prod.example.com' } });
    assert.equal(hookProdBlocked?.blocked, true);
    const hookPass = await runVerdictParityHook({ target: tmpRepo, lang: 'en', requestedMode: 'parity', effectiveBaseUrl: candSame.url, options: { baselineUrl: baseline.url, routes: '/api/item' } });
    assert.equal(hookPass?.ok, true);
    assert.equal(hookPass?.gateStatus, 'pass');

    // 2. Divergent Candidate + shape-only + strictByteEscape catches status (409 vs 201), emoji escape, and SSE drift with ZERO plaintext
    const diffCorpus = path.join(corpusDir, 'diff-check.jsonl');
    fs.writeFileSync(
      diffCorpus,
      [
        JSON.stringify({ id: 'd1', method: 'POST', path: '/api/orders', headers: {}, body: { sku: 'A1' }, featureCohort: ['orders'] }),
        JSON.stringify({ id: 'd2', method: 'GET', path: '/api/emoji', headers: {}, body: null, featureCohort: ['unicode-emoji'] }),
        JSON.stringify({ id: 'd3', method: 'GET', path: '/api/stream', headers: { accept: 'text/event-stream' }, body: null, featureCohort: ['streaming'] }),
      ].join('\n') + '\n',
      'utf8'
    );
    const diffRes = await runParityCore({
      target: tmpRepo,
      baselineUrl: baseline.url,
      candidateUrl: candBuggy.url,
      corpus: 'corpus/diff-check.jsonl',
      privacyMode: 'shape-only',
      strictByteEscape: true,
    });
    assert.equal(diffRes.ok, false);
    assert.equal(diffRes.exitCode, 1);
    assert.equal(diffRes.clusters.length, 3);
    const reportText = fs.readFileSync(diffRes.reportJsonPath, 'utf8');
    const summaryText = fs.readFileSync(diffRes.summaryMdPath, 'utf8');
    assert.equal(reportText.includes('TOP_SECRET_BUYER_777'), false, 'shape-only JSON report must contain 0 secret bytes');
    assert.equal(reportText.includes('PRIVATE_EMOJI_NOTE_42'), false, 'shape-only JSON report must contain 0 secret bytes');
    assert.equal(summaryText.includes('TOP_SECRET_BUYER_777'), false, 'shape-only MD summary must contain 0 secret bytes');

    // 3. Production target blocked fail-closed (exitCode 2)
    const prodBlocked = await runParityCore({
      target: tmpRepo,
      baselineUrl: 'https://api.prod.example.com',
      candidateUrl: candSame.url,
    });
    assert.equal(prodBlocked.ok, false);
    assert.equal(prodBlocked.outcome, 'blocked');
    assert.equal(prodBlocked.exitCode, 2);

    // 3b. Non-loopback shared staging environment defaults to strictReadonly=true (blocks POST),
    //     while explicit allowMutation=true unlocks POST on both baseline & candidate guards!
    const stagingQa = makeTempDir('aitest-parity-staging-');
    try {
      fs.writeFileSync(
        path.join(stagingQa, '.env'),
        'TEST_ENV=staging\nTEST_ALLOWED_HOSTS=baseline.staging.internal,candidate.staging.internal\n',
        'utf8'
      );
      const defaultSafety = validateDualTargetSafety(
        stagingQa,
        'https://baseline.staging.internal',
        'https://candidate.staging.internal'
      );
      assert.equal(defaultSafety.ok, true);
      assert.equal(defaultSafety.baseGuard?.strictReadonly, true, 'Non-loopback shared staging must default strictReadonly=true');
      assert.equal(defaultSafety.candGuard?.strictReadonly, true);
      assert.equal(
        checkOutgoingRequestSafety('POST', 'https://candidate.staging.internal/api/orders', defaultSafety.candGuard).blocked,
        true,
        'POST write request against shared staging must be blocked when allowMutation is omitted'
      );
      assert.equal(
        checkOutgoingRequestSafety('GET', 'https://candidate.staging.internal/api/courses', defaultSafety.candGuard).blocked,
        false
      );

      const mutSafety = validateDualTargetSafety(
        stagingQa,
        'https://baseline.staging.internal',
        'https://candidate.staging.internal',
        { allowMutation: true }
      );
      assert.equal(mutSafety.ok, true);
      assert.equal(mutSafety.baseGuard?.strictReadonly, false, 'Explicit allowMutation=true unlocks write requests');
      assert.equal(mutSafety.candGuard?.strictReadonly, false);
      assert.equal(
        checkOutgoingRequestSafety('POST', 'https://candidate.staging.internal/api/orders', mutSafety.candGuard).blocked,
        false
      );
    } finally {
      fs.rmSync(stagingQa, { recursive: true, force: true });
    }

    // 4. MCP tool `aitest_parity` end-to-end call (with explicit config normalizePaths for `$.requestId`) & path boundary block
    const cfgPath = path.join(qaDir, 'aitest.config.json');
    const cfgObj = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfgObj.parity = { normalizePaths: ['$.requestId'] };
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj, null, 2) + '\n', 'utf8');

    const mcpReply = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 101,
        method: 'tools/call',
        params: {
          name: 'aitest_parity',
          arguments: {
            target: tmpRepo,
            baselineUrl: baseline.url,
            candidateUrl: candSame.url,
            routes: '/api/health,/api/stream',
          },
        },
      },
      { workspaceRoots: [tmpRepo] }
    );
    assert.equal(mcpReply.result.isError, false);
    assert.equal(mcpReply.result.structuredContent.ok, true);
    assert.equal(mcpReply.result.structuredContent.data.parityPct, 100);

    const mcpBoundaryBlocked = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 102,
        method: 'tools/call',
        params: {
          name: 'aitest_parity',
          arguments: {
            target: tmpRepo,
            baselineUrl: baseline.url,
            corpus: '../../outside.jsonl',
          },
        },
      },
      { workspaceRoots: [tmpRepo] }
    );
    assert.equal(mcpBoundaryBlocked.result.isError, true);
    assert.match(mcpBoundaryBlocked.result.structuredContent.summary, /Workspace Boundary Blocked/);
  } finally {
    await baseline.close();
    await candSame.close();
    await candBuggy.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('verify-change --mode parity --baseline-url intercepts S5->S5 literal-catering spec tampering via live Baseline oracle', async () => {
  const baseline = await startDualTargetServer('baseline');
  const candBuggy = await startDualTargetServer('candidate-buggy');
  const tmpRepo = makeTempDir('aitest-verify-parity-');

  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tmpRepo, stdio: 'ignore' });

    await runCli(['init', '--name', 'parity-verdict', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');
    if (fs.existsSync(TEMPLATE_MODULES)) {
      fs.symlinkSync(TEMPLATE_MODULES, path.join(qaDir, 'node_modules'), 'junction');
    }

    fs.writeFileSync(
      path.join(qaDir, '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${candBuggy.url}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\n`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'smoke', 'orders-dup.spec.ts'),
      `import { test, expect } from '../fixtures/base';
test('duplicate order status check', async ({ request }) => {
  const res = await request.post('/api/orders', { data: { sku: 'A1' } });
  expect(res.status()).toBe(409);
});
`,
      'utf8'
    );
    fs.mkdirSync(path.join(qaDir, 'corpus'), { recursive: true });
    fs.writeFileSync(
      path.join(qaDir, 'corpus', 'sanitized-requests.jsonl'),
      `${JSON.stringify({ id: 'ord_1', method: 'POST', path: '/api/orders', headers: {}, body: { sku: 'A1' }, featureCohort: ['orders'] })}\n`,
      'utf8'
    );

    await humanApprove(tmpRepo, 'seal parity corpus');
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline commit'], { cwd: tmpRepo, stdio: 'ignore' });

    // Attacker tampers S5 -> S5 literal (409 -> 201) to match buggy candidate so Playwright tests pass!
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'smoke', 'orders-dup.spec.ts'),
      `import { test, expect } from '../fixtures/base';
test('duplicate order status check', async ({ request }) => {
  const res = await request.post('/api/orders', { data: { sku: 'A1' } });
  expect(res.status()).toBe(201);
});
`,
      'utf8'
    );

    const verdict = await verifyChangeCore({
      target: tmpRepo,
      mode: 'parity',
      baseUrl: candBuggy.url,
      baselineUrl: baseline.url,
      allowMutation: true,
      lang: 'en',
    });

    assert.equal(verdict.ok, false, 'Differential parity oracle must reject S5->S5 literal-catering drift');
    assert.equal(verdict.verdict, 'fail');
    assert.equal(verdict.exitCode, 1);
    assert.equal(verdict.gates.parity, 'fail');
    assert.ok(verdict.paritySummary && verdict.paritySummary.mismatchedSamples >= 1);
    assert.ok(verdict.gateErrors.some((e) => e.includes('Differential Parity Oracle')));
  } finally {
    await baseline.close();
    await candBuggy.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('Upstream replay cassette requires governance.lock seal & allowlisted external host, and perf --mode sse enforces TTFT & cleanTermination SLOs', async () => {
  const tmpRepo = makeTempDir('aitest-cassette-sse-');
  const fastSse = await startDualTargetServer('baseline');
  const slowSse = await startDualTargetServer('slow-sse');
  const errSse = await startDualTargetServer('error-sse');

  try {
    await runCli(['init', '--name', 'cassette-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Configure replayAllowedUpstreamHosts
    const cfgPath = path.join(qaDir, 'aitest.config.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.replayAllowedUpstreamHosts = ['api.anthropic.com'];
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');

    const cassetteRel = 'fixtures/upstream-cassettes/fake-model.json';
    const cassetteAbs = path.join(qaDir, cassetteRel);
    fs.mkdirSync(path.dirname(cassetteAbs), { recursive: true });
    const reqHash = computeRequestShapeHash('POST', '/v1/messages', { prompt: 'hello' });
    const cassetteDoc = {
      schemaVersion: 1,
      upstreamHost: 'api.anthropic.com',
      recordedAt: '2026-11-26T00:00:00.000Z',
      entries: [
        {
          method: 'POST',
          path: '/v1/messages',
          requestShapeHash: reqHash,
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8' },
          body: null,
          sseFrames: [
            { event: 'message_start', data: '{"type":"message_start","message":{"usage":{"input_tokens":3}}}' },
            { event: 'content_block_delta', data: '{"type":"content_block_delta","delta":{"type":"text_delta","text":"deterministic"}}' },
            { event: 'message_stop', data: '{"type":"message_stop"}' },
          ],
        },
        {
          method: 'POST',
          path: '/v1/json-reply',
          status: 200,
          headers: {},
          body: { ok: true, model: 'fake-v1' },
        },
      ],
    };
    fs.writeFileSync(cassetteAbs, JSON.stringify(cassetteDoc, null, 2) + '\n', 'utf8');

    // 0. Path traversal, missing file, loopback host & unallowlisted host rejections
    assert.equal(loadVerifiedUpstreamCassette(qaDir, '../outside.json').exitCode, 2);
    assert.equal(loadVerifiedUpstreamCassette(qaDir, 'fixtures/upstream-cassettes/missing.json').exitCode, 2);

    // 1. Unlocked cassette -> blocked (exitCode 2)
    const unlocked = loadVerifiedUpstreamCassette(qaDir, cassetteRel);
    assert.equal(unlocked.ok, false);
    assert.equal(unlocked.outcome, 'blocked');
    assert.equal(unlocked.exitCode, 2);

    // 2. Human governance approve -> passes & replays deterministically (both SSE & JSON + 404 miss)
    await humanApprove(tmpRepo, 'approve fake-model cassette');
    const verified = loadVerifiedUpstreamCassette(qaDir, cassetteRel);
    assert.equal(verified.ok, true);
    assert.equal(verified.exitCode, 0);

    const stub = await startCassetteReplayServer(verified.cassette);
    try {
      const r1 = await fetch(`${stub.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      });
      const r2 = await fetch(`${stub.baseUrl}/v1/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      });
      const rJson = await fetch(`${stub.baseUrl}/v1/json-reply`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ x: 1 }),
      });
      const rMiss = await fetch(`${stub.baseUrl}/v1/unknown`);
      const t1 = await r1.text();
      const t2 = await r2.text();
      assert.equal(r1.status, 200);
      assert.equal(t1, t2);
      assert.ok(t1.includes('deterministic'));
      assert.equal(rJson.status, 200);
      assert.equal((await rJson.json()).model, 'fake-v1');
      assert.equal(rMiss.status, 404);
      assert.equal(stub.getHitCount(), 3);
    } finally {
      await stub.close();
    }

    // 2b. Sealed cassette pointing to 127.0.0.1 or non-allowlisted host is STILL blocked
    const badHostRel = 'fixtures/upstream-cassettes/bad-host.json';
    fs.writeFileSync(
      path.join(qaDir, badHostRel),
      JSON.stringify({ schemaVersion: 1, upstreamHost: '127.0.0.1', entries: [] }, null, 2) + '\n',
      'utf8'
    );
    const unallowRel = 'fixtures/upstream-cassettes/unallowlisted.json';
    fs.writeFileSync(
      path.join(qaDir, unallowRel),
      JSON.stringify({ schemaVersion: 1, upstreamHost: 'api.other.example', entries: [] }, null, 2) + '\n',
      'utf8'
    );
    await humanApprove(tmpRepo, 'seal negative host cassettes for policy test');
    assert.equal(loadVerifiedUpstreamCassette(qaDir, badHostRel).exitCode, 2);
    assert.equal(loadVerifiedUpstreamCassette(qaDir, unallowRel).exitCode, 2);

    // 3. Tamper 1 byte -> immediately blocked (exitCode 2)
    fs.writeFileSync(cassetteAbs, fs.readFileSync(cassetteAbs, 'utf8') + ' ', 'utf8');
    const tampered = loadVerifiedUpstreamCassette(qaDir, cassetteRel);
    assert.equal(tampered.ok, false);
    assert.equal(tampered.outcome, 'blocked');
    assert.equal(tampered.exitCode, 2);

    // 4. Perf `--mode sse --enforce-budget` pass vs TTFT / error-envelope violations
    fs.writeFileSync(
      path.join(qaDir, '.env'),
      `TEST_ENV=local\nTEST_BASE_URL=${fastSse.url}\nTEST_ALLOWED_HOSTS=127.0.0.1,localhost\n`,
      'utf8'
    );
    const ssePassCode = await runPerfCommand({
      target: tmpRepo,
      baseUrl: fastSse.url,
      mode: 'sse',
      sseEndpoint: '/api/stream',
      iterations: 3,
      enforceBudget: true,
      json: false,
      lang: 'en',
    });
    assert.equal(ssePassCode, 0);
    const perfReport = JSON.parse(fs.readFileSync(path.join(qaDir, 'reports', 'perf-report.json'), 'utf8'));
    assert.equal(perfReport.sseBenchmark.cleanTerminationRate, 1);
    assert.equal(perfReport.sseBenchmark.envelopeErrors, 0);
    assert.ok(typeof perfReport.sseBenchmark.ttftMedianMs === 'number');

    // Strict TTFT budget catches slow SSE (45ms > 15ms)
    fs.writeFileSync(
      path.join(qaDir, 'perf-budget.json'),
      JSON.stringify({ streaming: { maxTtftMedianMs: 15, maxTtftP95Ms: 20, maxStreamTotalP95Ms: 5000, requireCleanTermination: true } }, null, 2),
      'utf8'
    );
    const sseSlowFail = await runPerfCommand({
      target: tmpRepo,
      baseUrl: slowSse.url,
      mode: 'sse',
      sseEndpoint: '/api/stream',
      iterations: 2,
      enforceBudget: true,
      lang: 'en',
    });
    assert.equal(sseSlowFail, 1);

    // Error envelope SSE fails cleanTermination & envelopeErrors gate
    const sseErrFail = await runPerfCommand({
      target: tmpRepo,
      baseUrl: errSse.url,
      mode: 'sse',
      sseEndpoint: '/api/stream',
      iterations: 2,
      enforceBudget: true,
      lang: 'en',
    });
    assert.equal(sseErrFail, 1);
  } finally {
    await fastSse.close();
    await slowSse.close();
    await errSse.close();
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
