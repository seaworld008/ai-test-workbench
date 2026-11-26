import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { validateAitestConfigObject } from '../../src/core/config.mjs';
import { measureSseEndpoint, parseSseStreamText } from '../../src/core/stream-sse.mjs';
import {
  DEFAULT_NORMALIZE_PATHS,
  compareParityCheckpoints,
  computeShapeFingerprint,
} from '../../src/kernel/diff-oracle.mjs';
import { compareSpecSourcesAst } from '../../src/kernel/gate-kernel.mjs';

test('parseSseStreamText parses Anthropic Messages SSE & OpenAI SSE formats, multi-line data, comments, errors & truncation', () => {
  const anthropicStream = [
    ': keep-alive comment',
    'event: message_start',
    'id: evt_1',
    'retry: 2000',
    'data: {"type":"message_start","message":{"usage":{"input_tokens":42}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step 1"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Hello "}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"world!"}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"toolu_1","name":"search","input":{}}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"{\\"q\\":\\"rust\\""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"}"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","usage":{"output_tokens":18}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
    '',
  ].join('\r\n');

  const parsedA = parseSseStreamText(anthropicStream);
  assert.equal(parsedA.format, 'anthropic');
  assert.equal(parsedA.cleanTermination, true);
  assert.equal(parsedA.hasEnvelopeError, false);
  assert.equal(parsedA.thinking, 'step 1');
  assert.equal(parsedA.text, 'Hello world!');
  assert.equal(parsedA.toolCalls.length, 1);
  assert.equal(parsedA.toolCalls[0].name, 'search');
  assert.deepEqual(parsedA.toolCalls[0].input, { q: 'rust' });
  assert.deepEqual(parsedA.usage, { input_tokens: 42, output_tokens: 18 });
  assert.equal(parsedA.frames[0].id, 'evt_1');
  assert.equal(parsedA.frames[0].retry, 2000);

  const openAiStream = [
    'data: {"choices":[{"delta":{"reasoning_content":"plan","content":"Hi "}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"there","tool_calls":[{"index":0,"id":"call_1","function":{"name":"lookup","arguments":"{\\"id\\":"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"7}"}}]},"finish_reason":"tool_calls"}],"usage":{"total_tokens":33}}',
    '',
    'data: [DONE]',
    '',
    '',
  ].join('\n');

  const parsedO = parseSseStreamText(openAiStream);
  assert.equal(parsedO.format, 'openai');
  assert.equal(parsedO.cleanTermination, true);
  assert.equal(parsedO.thinking, 'plan');
  assert.equal(parsedO.text, 'Hi there');
  assert.equal(parsedO.toolCalls[0].name, 'lookup');
  assert.deepEqual(parsedO.toolCalls[0].input, { id: 7 });
  assert.deepEqual(parsedO.usage, { total_tokens: 33 });

  // Multi-line data + mid-stream error envelope
  const errStream = [
    'event: error',
    'data: {"type":"error",',
    'data: "error":{"type":"overloaded_error","message":"Upstream overloaded","code":529}}',
    '',
    '',
  ].join('\n');
  const parsedErr = parseSseStreamText(errStream);
  assert.equal(parsedErr.hasEnvelopeError, true);
  assert.equal(parsedErr.cleanTermination, false);
  assert.equal(parsedErr.envelopeErrors[0].code, 529);

  // Truncated Anthropic stream (missing message_stop) & malformed JSON
  const truncated = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n';
  assert.equal(parseSseStreamText(truncated).cleanTermination, false);
  const brokenJson = 'data: {"choices":[{"delta":{"content":"cut\n\n';
  assert.equal(parseSseStreamText(brokenJson).cleanTermination, false);
});

test('measureSseEndpoint records TTFT, interFrameMs, totalMs, and enforces validateHop + maxRedirects: 0', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/stream' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8' });
    setTimeout(() => {
      res.write('data: {"choices":[{"delta":{"content":"first"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":" second"},"finish_reason":"stop"}]}\n\n');
        res.write('data: [DONE]\n\n');
        res.end();
      }, 25);
    }, 25);
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    const res = await measureSseEndpoint(`${base}/stream`);
    assert.equal(res.ok, true);
    assert.equal(res.status, 200);
    assert.ok(typeof res.ttftMs === 'number' && res.ttftMs >= 15);
    assert.ok(res.interFrameMs.length >= 1);
    assert.ok(res.totalMs >= res.ttftMs);
    assert.equal(res.parsed.text, 'first second');
    assert.equal(res.parsed.cleanTermination, true);

    // maxRedirects: 0 blocks redirect fail-closed
    const redir = await measureSseEndpoint(`${base}/redirect`, { maxRedirects: 0 });
    assert.equal(redir.ok, false);
    assert.equal(redir.blocked, true);

    // validateHop hook blocks disallowed target
    const blocked = await measureSseEndpoint(`${base}/stream`, {
      validateHop: () => ({ blocked: true, reason: 'Blocked by test hop guard' }),
    });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.blocked, true);
    assert.match(blocked.error || '', /hop guard/);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('compareParityCheckpoints enforces CP1..CP5, strictByteEscape (\\uXXXX vs UTF-8), and zero-plaintext shape-only privacy', () => {
  assert.ok(DEFAULT_NORMALIZE_PATHS.includes('headers.x-request-id'));

  // 1. Key-order-independent match with explicit normalizePaths
  const matched = compareParityCheckpoints(
    {
      routePattern: 'POST /api/v1/messages',
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Request-Id': 'req_base_1', Date: 'Thu, 26 Nov 2026 00:00:00 GMT' },
      bodyText: '{"requestId":"r1","b":2,"a":{"x":1}}',
      durationMs: 20,
    },
    {
      routePattern: 'POST /api/v1/messages',
      status: 200,
      headers: { 'content-type': 'application/json;charset=UTF-8', 'x-request-id': 'req_cand_9', date: 'Thu, 26 Nov 2026 00:00:09 GMT' },
      bodyText: '{"a":{"x":1},"b":2,"requestId":"r999"}',
      durationMs: 18,
    },
    { normalizePaths: ['$.requestId'] }
  );
  assert.equal(matched.ok, true);
  assert.equal(matched.checkpoints.CP1, 'pass');
  assert.equal(matched.checkpoints.CP2, 'pass');

  // 2. CP1 exact status mismatch (200 !== 201)
  const statusDiff = compareParityCheckpoints(
    { routePattern: 'POST /api/orders', status: 200, headers: { 'content-type': 'application/json' }, bodyText: '{"ok":true}' },
    { routePattern: 'POST /api/orders', status: 201, headers: { 'content-type': 'application/json' }, bodyText: '{"ok":true}' }
  );
  assert.equal(statusDiff.ok, false);
  assert.equal(statusDiff.checkpoints.CP1, 'fail');
  assert.equal(statusDiff.primaryMismatch?.diffKind, 'status-mismatch');

  // 3. CP2 strictByteEscape catches Python \ud83d\ude80 vs Rust raw UTF-8 emoji even with reordered keys & normalized requestId
  const pyBody = '{"requestId":"py1","content":[{"text":"Launch \\ud83d\\ude80 now"}]}';
  const rsBody = '{"content":[{"text":"Launch 🚀 now"}],"requestId":"rs2"}';
  const semanticOnly = compareParityCheckpoints(
    { routePattern: 'POST /api/v1/messages', status: 200, headers: { 'content-type': 'application/json' }, bodyText: pyBody },
    { routePattern: 'POST /api/v1/messages', status: 200, headers: { 'content-type': 'application/json' }, bodyText: rsBody },
    { normalizePaths: ['$.requestId'], strictByteEscape: false }
  );
  assert.equal(semanticOnly.ok, true);

  const byteStrict = compareParityCheckpoints(
    { routePattern: 'POST /api/v1/messages', status: 200, headers: { 'content-type': 'application/json' }, bodyText: pyBody, featureCohort: ['unicode-emoji'] },
    { routePattern: 'POST /api/v1/messages', status: 200, headers: { 'content-type': 'application/json' }, bodyText: rsBody, featureCohort: ['unicode-emoji'] },
    { normalizePaths: ['$.requestId'], strictByteEscape: true, privacyMode: 'shape-only' }
  );
  assert.equal(byteStrict.ok, false);
  assert.equal(byteStrict.primaryMismatch?.diffKind, 'byte-escape-mismatch');
  assert.equal(byteStrict.primaryMismatch?.pieceOrJsonPath, '$.content[0].text');
  assert.equal(byteStrict.primaryMismatch?.baselinePreview, null);
  assert.equal(byteStrict.primaryMismatch?.candidatePreview, null);
  assert.match(byteStrict.fingerprint?.fingerprintId || '', /^fp_[0-9a-f]{12}$/);

  // 4. Zero-plaintext shape-only guarantee: sensitive customer payload never appears in output JSON
  const secretStr = 'CONFIDENTIAL_CUSTOMER_PROMPT_XYZZY_99812';
  const shapeOnlyDiff = compareParityCheckpoints(
    { routePattern: 'POST /api/chat', status: 200, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ reply: `${secretStr}_v1` }) },
    { routePattern: 'POST /api/chat', status: 200, headers: { 'content-type': 'application/json' }, bodyText: JSON.stringify({ reply: `${secretStr}_v2` }) },
    { privacyMode: 'shape-only' }
  );
  assert.equal(shapeOnlyDiff.ok, false);
  assert.equal(JSON.stringify(shapeOnlyDiff).includes(secretStr), false, 'shape-only output must contain ZERO plaintext business payload');
  assert.equal(shapeOnlyDiff.primaryMismatch?.firstDiffByteOffset, secretStr.length + 2);

  // 5. CP3 Stream Frames + CP4 ARIA/runtime + CP5 Perf Ratio
  const sseDiff = compareParityCheckpoints(
    {
      routePattern: 'POST /api/stream',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: 'data: {"choices":[{"delta":{"content":"hello"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ariaSnapshot: '- main:\n  - heading "OK"',
      pageErrors: [],
      durationMs: 10,
      ttftMs: 5,
    },
    {
      routePattern: 'POST /api/stream',
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
      bodyText: 'data: {"choices":[{"delta":{"content":"helX"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      ariaSnapshot: '- main:\n  - heading "BROKEN"',
      pageErrors: ['TypeError: boom'],
      durationMs: 50,
      ttftMs: 30,
    },
    { maxLatencyRatio: 2.0, maxTtftRatio: 2.0 }
  );
  assert.equal(sseDiff.ok, false);
  assert.equal(sseDiff.checkpoints.CP3, 'fail');
  assert.equal(sseDiff.checkpoints.CP4, 'fail');
  assert.equal(sseDiff.checkpoints.CP5, 'warn');
  assert.equal(sseDiff.perfWarnings.length, 2);

  // Deterministic fingerprint stability
  const fp1 = computeShapeFingerprint({
    checkpoint: 'CP2-Body-Shape-And-Value',
    routePattern: 'POST /api/v1/messages',
    pieceOrJsonPath: '$.content[0].text',
    firstDiffByteOffset: 17,
    baselineByteLen: 190,
    candidateByteLen: 186,
    diffKind: 'byte-escape-mismatch',
    featureCohort: ['tools', 'streaming'],
  });
  const fp2 = computeShapeFingerprint({
    checkpoint: 'CP2-Body-Shape-And-Value',
    routePattern: 'POST /api/v1/messages',
    pieceOrJsonPath: '$.content[0].text',
    firstDiffByteOffset: 17,
    baselineByteLen: 190,
    candidateByteLen: 186,
    diffKind: 'byte-escape-mismatch',
    featureCohort: ['streaming', 'tools'],
  });
  assert.equal(fp1.fingerprintId, fp2.fingerprintId);
});

test('AITEST-G114 refines external upstream replay hosts while still blocking SUT/loopback/wildcards, and config schema validates parity & replayAllowedUpstreamHosts', () => {
  // Config validation
  assert.equal(
    validateAitestConfigObject({
      parity: { normalizePaths: ['$.requestId'], strictByteEscape: true, maxLatencyRatio: 1.5, maxTtftRatio: 1.2, privacyMode: 'shape-only' },
      replayAllowedUpstreamHosts: ['api.anthropic.com', 'api.openai.com'],
    }).ok,
    true
  );
  for (const badHost of ['localhost', '127.0.0.1', '::1', '0.0.0.0', '', '*.openai.com', 'https://api.openai.com']) {
    const res = validateAitestConfigObject({ replayAllowedUpstreamHosts: [badHost] });
    assert.equal(res.ok, false, `Expected replayAllowedUpstreamHosts to reject "${badHost}"`);
  }
  assert.equal(validateAitestConfigObject({ parity: { privacyMode: 'plaintext' } }).ok, false);

  const baseSpec = `
import { test, expect } from '../fixtures/base';
test('chat flow', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveText('Ready');
});`;

  // Allowed: external upstream declared in replayAllowedUpstreamHosts (not stubbing asserted status)
  const allowedUpstreamSpec = `
import { test, expect } from '../fixtures/base';
test('chat flow', async ({ page }) => {
  await page.route('https://api.anthropic.com/v1/messages', (route) => route.fulfill({ status: 200, body: '{}' }));
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveText('Ready');
});`;
  const okRes = compareSpecSourcesAst('tests/e2e/chat.spec.ts', baseSpec, allowedUpstreamSpec, {
    replayAllowedUpstreamHosts: ['api.anthropic.com'],
  });
  assert.equal(okRes.ok, true);

  // Still BLOCKED: relative SUT path, localhost, wildcard host, undeclared external host, or stubbing asserted status
  const blockedVariants = [
    `await page.route('/api/orders', (r) => r.fulfill({ status: 200, body: '{}' }));`,
    `await page.route('http://127.0.0.1:4173/api/orders', (r) => r.fulfill({ status: 200, body: '{}' }));`,
    `await page.route('https://*.anthropic.com/v1/messages', (r) => r.fulfill({ status: 200, body: '{}' }));`,
    `await page.route('https://api.undeclared.example/v1/chat', (r) => r.fulfill({ status: 200, body: '{}' }));`,
  ];
  for (const snippet of blockedVariants) {
    const headSpec = `
import { test, expect } from '../fixtures/base';
test('chat flow', async ({ page }) => {
  ${snippet}
  await page.goto('/');
  await expect(page.getByRole('heading')).toHaveText('Ready');
});`;
    const cmp = compareSpecSourcesAst('tests/e2e/chat.spec.ts', baseSpec, headSpec, {
      replayAllowedUpstreamHosts: ['api.anthropic.com'],
    });
    assert.equal(cmp.ok, false, `Expected AITEST-G114 to block: ${snippet}`);
    assert.ok(cmp.findings.some((f) => f.code === 'AITEST-G114'));
  }

  // Still BLOCKED when directly fabricating a status code asserted by the same test
  const stubbedStatusSpec = `
import { test, expect } from '../fixtures/base';
test('chat flow', async ({ page }) => {
  await page.route('https://api.anthropic.com/v1/messages', (r) => r.fulfill({ status: 200, body: '{}' }));
  const res = await page.request.get('/api/health');
  expect(res.status()).toBe(200);
});`;
  const stubCmp = compareSpecSourcesAst('tests/e2e/chat.spec.ts', baseSpec, stubbedStatusSpec, {
    replayAllowedUpstreamHosts: ['api.anthropic.com'],
  });
  assert.equal(stubCmp.ok, false);
  assert.ok(stubCmp.findings.some((f) => f.code === 'AITEST-G114'));
});
