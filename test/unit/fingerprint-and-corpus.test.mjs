import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli.mjs';
import { importTrafficCorpus } from '../../src/corpus.mjs';
import { clusterDiagnosedFailures, generateDiagnosticsMarkdown } from '../../src/diagnose.mjs';
import {
  inferJsonSchemaFromSample,
  inferUnionSchemaFromSamples,
  mergeInferredSchemas,
  writeInferredApiSchemas,
} from '../../src/explore/schema-inferrer.mjs';
import { verifyGovernanceLockInQaDir } from '../../src/kernel/gate-kernel.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('Root-cause fingerprinting clusters 50 failures from 5 underlying defects into exactly 5 clusters, picks minimalReproducerSpec, and tracks unmaskedAfterFixOf cascade', () => {
  const qaDir = makeTempDir('aitest-cluster-');
  try {
    const defectTemplates = [
      {
        file: 'tests/api/orders.spec.ts',
        route: 'POST /api/v1/orders',
        makeErr: (i) => `Error: expect(received).toBe(expected) at tests/api/orders.spec.ts:${10 + i}:5\nExpected: 201\nReceived: 500\nPOST https://staging.local/api/v1/orders/${1000 + i} failed`,
      },
      {
        file: 'tests/api/messages.spec.ts',
        route: 'POST /api/v1/messages',
        makeErr: (i) => `JSON Schema contract violation at $.content[${i}].text: expected string, got null (req 550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')})`,
      },
      {
        file: 'tests/e2e/auth.spec.ts',
        route: '/api/auth/session',
        makeErr: (i) => `[AI Test Workbench Network Guard] 401 Unauthorized on GET https://staging.local/api/auth/session?t=${1700000000 + i}`,
      },
      {
        file: 'tests/e2e/nav.spec.ts',
        route: 'tests/e2e/nav.spec.ts',
        makeErr: (i) => `TimeoutError: locator('button.checkout').click: Timeout ${5000 + i * 10}ms exceeded.\nwaiting for getByRole('button', { name: 'Checkout' })`,
      },
      {
        file: 'tests/api/billing.spec.ts',
        route: 'GET /api/v1/invoices',
        makeErr: (i) => `Error: expect(received).toHaveText(expected) at line ${20 + i}\nExpected: "$49.00"\nReceived: "$0.00"\nGET https://staging.local/api/v1/invoices/${200 + i}`,
      },
    ];

    const specs = [];
    for (let d = 0; d < defectTemplates.length; d += 1) {
      const tpl = defectTemplates[d];
      for (let k = 0; k < 10; k += 1) {
        specs.push({
          title: `defect-${d}-case-${k}`,
          file: tpl.file,
          line: 10 + k,
          tests: [
            {
              projectName: 'e2e',
              status: 'unexpected',
              results: [
                {
                  status: 'failed',
                  duration: k === 3 ? 42 : 250 + k * 40, // case k=3 is strictly fastest in every cluster!
                  error: { message: tpl.makeErr(k) },
                },
              ],
            },
          ],
        });
      }
    }

    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const resultsPath = path.join(reportsDir, 'results.json');
    fs.writeFileSync(resultsPath, JSON.stringify({ suites: [{ file: 'root', specs }] }), 'utf8');

    const diag1 = generateDiagnosticsMarkdown(qaDir, resultsPath);
    assert.equal(diag1.failureCount, 50);
    assert.equal(diag1.clusters.length, 5, `Expected 50 failures to cluster into exactly 5 root-cause clusters, got ${diag1.clusters.length}`);
    for (const c of diag1.clusters) {
      assert.equal(c.count, 10);
      assert.equal(c.minimalDurationMs, 42, `Cluster ${c.fingerprintId} must pick fastest reproducer (42ms)`);
      assert.match(c.minimalTestId, /case-3$/);
      assert.equal(c.unmaskedAfterFixOf, null);
    }
    assert.match(diag1.markdown, /Root-Cause Fingerprint Clusters/);

    // Masking cascade: save round-1 clusters, then fix defect-0 (POST /api/v1/orders status 500)
    // and expose a downstream contract mismatch on the same route `POST /api/v1/orders`!
    const ordersOldCluster = diag1.clusters.find((c) => c.routePattern.includes('/api/v1/orders'));
    assert.ok(ordersOldCluster);

    const round2Clusters = clusterDiagnosedFailures(
      [
        {
          testId: 'tests/api/orders.spec.ts::downstream-total-check',
          file: 'tests/api/orders.spec.ts',
          line: 44,
          durationMs: 85,
          categoryCode: 'C',
          errorSnippet: 'JSON Schema contract violation at $.totals.tax on POST https://staging.local/api/v1/orders/555',
        },
      ],
      { previousClusters: diag1.clusters }
    );
    assert.equal(round2Clusters.length, 1);
    assert.equal(round2Clusters[0].unmaskedAfterFixOf, ordersOldCluster.fingerprintId);
  } finally {
    fs.rmSync(qaDir, { recursive: true, force: true });
  }
});

test('corpus import sanitizes HAR 1.2, JSONL & OTel spans, strips production hosts, extracts cohorts & enforces Layer 0 governance lock', async () => {
  const tmpRepo = makeTempDir('aitest-corpus-');
  try {
    await runCli(['init', '--name', 'corpus-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // 1. HAR 1.2 with production host, secrets, streaming + tools + emoji + pagination, plus high-risk DELETE & payment paths
    const harPath = path.join(tmpRepo, 'prod-export.har');
    fs.writeFileSync(
      harPath,
      JSON.stringify({
        log: {
          version: '1.2',
          entries: [
            {
              request: {
                method: 'POST',
                url: 'https://api.prod.example.com/v1/messages?limit=20&api_key=sk-ant-secretvalue1234567890',
                headers: [
                  { name: 'Authorization', value: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567890' },
                  { name: 'Cookie', value: 'session_id=topsecret_cookie_val' },
                  { name: 'Accept', value: 'text/event-stream' },
                  { name: 'Content-Type', value: 'application/json' },
                ],
                postData: {
                  text: JSON.stringify({
                    stream: true,
                    tools: [{ name: 'calc' }],
                    password: 'my_super_secret_password',
                    prompt: 'Launch 🚀',
                  }),
                },
              },
              response: { status: 200, content: { text: 'event: message_stop\ndata: {}\n\n' } },
            },
            {
              request: { method: 'DELETE', url: 'https://api.prod.example.com/api/users/99', headers: [] },
              response: { status: 204 },
            },
            {
              request: { method: 'POST', url: 'https://api.prod.example.com/api/payments/charge', headers: [] },
              response: { status: 200 },
            },
          ],
        },
      }),
      'utf8'
    );

    const cliCode = await runCli(['corpus', 'import', '--target', tmpRepo, '--from', harPath, '--json']);
    assert.equal(cliCode, 0);

    const outPath = path.join(qaDir, 'corpus', 'sanitized-requests.jsonl');
    assert.equal(fs.existsSync(outPath), true);
    const outText = fs.readFileSync(outPath, 'utf8');
    assert.equal(outText.includes('api.prod.example.com'), false, 'Production host must be stripped');
    assert.equal(outText.includes('sk-ant-secretvalue'), false, 'API key secret must be redacted');
    assert.equal(outText.includes('eyJhbGciOiJIUzI1NiJ9'), false, 'JWT must be redacted');
    assert.equal(outText.includes('topsecret_cookie_val'), false, 'Cookie must be redacted');
    assert.equal(outText.includes('my_super_secret_password'), false, 'Body password must be redacted');

    const rows = outText.trim().split(/\r?\n/).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1, 'DELETE and payment routes must be filtered by default');
    assert.ok(rows[0].path.startsWith('/v1/messages?'));
    for (const tag of ['streaming', 'tools', 'unicode-emoji', 'pagination', 'json-payload', 'auth-scoped']) {
      assert.ok(rows[0].featureCohort.includes(tag), `Expected featureCohort to include "${tag}", got ${JSON.stringify(rows[0].featureCohort)}`);
    }

    // Governance Lock immediately protects newly created `corpus/sanitized-requests.jsonl`!
    const govCheck = verifyGovernanceLockInQaDir(qaDir);
    assert.equal(govCheck.ok, false);
    assert.equal(govCheck.status, 'blocked');
    assert.ok(govCheck.errors.some((e) => e.includes('corpus/sanitized-requests.jsonl')));

    // 2. OTel HTTP Span JSON import (dryRun)
    const otelPath = path.join(tmpRepo, 'spans.json');
    fs.writeFileSync(
      otelPath,
      JSON.stringify({
        resourceSpans: [
          {
            scopeSpans: [
              {
                spans: [
                  {
                    attributes: [
                      { key: 'http.request.method', value: { stringValue: 'GET' } },
                      { key: 'url.full', value: { stringValue: 'https://prod.internal/api/courses?page=2' } },
                      { key: 'http.response.status_code', value: { intValue: 200 } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    const otelRes = importTrafficCorpus({ qaDir, fromPath: otelPath, dryRun: true });
    assert.equal(otelRes.format, 'otel');
    assert.equal(otelRes.importedCount, 1);
    assert.equal(otelRes.records[0].path, '/api/courses?page=2');
    assert.ok(otelRes.records[0].featureCohort.includes('pagination'));

    // 3. JSONL import with --allow-mutation preserves DELETE
    const jsonlPath = path.join(tmpRepo, 'raw.jsonl');
    fs.writeFileSync(
      jsonlPath,
      `${JSON.stringify({ method: 'DELETE', url: 'https://staging.local/api/items/1' })}\n`,
      'utf8'
    );
    const mutRes = importTrafficCorpus({ qaDir, fromPath: jsonlPath, allowMutation: true, dryRun: true });
    assert.equal(mutRes.format, 'jsonl');
    assert.equal(mutRes.importedCount, 1);

    // 4. CLI `corpus` dry-run & usage/missing-file error handling
    assert.equal(await runCli(['corpus', 'import', '--target', tmpRepo, '--from', jsonlPath, '--dry-run']), 0);
    assert.equal(await runCli(['corpus', 'invalid-action', '--target', tmpRepo, '--from', jsonlPath, '--json']), 64);
    assert.equal(await runCli(['corpus', 'import', '--target', tmpRepo, '--json']), 64);
    assert.equal(await runCli(['corpus', 'import', '--target', tmpRepo, '--from', jsonlPath, '--format', 'xml', '--json']), 64);
    assert.equal(await runCli(['corpus', 'import', '--target', tmpRepo, '--from', path.join(tmpRepo, 'missing.har'), '--json']), 1);
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('Multi-sample union Schema inferrer merges empty/non-empty arrays, nullable, oneOf, >1 array elements, and unicode-emoji-parity suggestions', () => {
  const qaDir = makeTempDir('aitest-schema-');
  try {
    // Empty array merged with non-empty array preserves items schema
    const mergedArr = mergeInferredSchemas(
      { type: 'array', items: {} },
      { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } }
    );
    assert.equal(mergedArr.type, 'array');
    assert.equal(mergedArr.items.type, 'object');
    assert.equal(mergedArr.items.properties.id.type, 'integer');

    // Array sampling inspects beyond element 0 (up to 50 elements)
    const bigArr = Array.from({ length: 30 }, (_, i) => (i === 24 ? { id: i, lateField: 'present' } : { id: i }));
    const bigSchema = inferJsonSchemaFromSample(bigArr);
    assert.equal(bigSchema.items.properties.lateField.type, 'string');
    assert.deepEqual(bigSchema.items.required, ['id']);

    // Multi-sample union across endpoint captures: nullable + oneOf + required intersection + emoji traits
    const union = inferUnionSchemaFromSamples(
      [
        { id: 1, title: 'Alpha 🚀', note: 'hi', payload: 'text' },
        { id: 2, title: 'Beta', note: null, payload: 42, extra: true },
      ],
      { rawTexts: ['{"title":"Alpha \\ud83d\\ude80"}', '{"title":"Beta"}'] }
    );
    assert.equal(union.sampleCount, 2);
    assert.deepEqual(union.schema.required, ['id', 'title', 'payload']);
    assert.equal(union.schema.properties.note.nullable, true);
    assert.ok(Array.isArray(union.schema.properties.payload.oneOf));
    assert.ok(union.encodingTraits.includes('emoji-utf8'));
    assert.ok(union.encodingTraits.includes('unicode-escape'));

    const written = writeInferredApiSchemas(qaDir, [
      { method: 'GET', pathname: '/api/messages', status: 200, sample: { items: [] } },
      {
        method: 'GET',
        pathname: '/api/messages',
        status: 200,
        sample: { items: [{ id: 1, text: 'Done 🎉', tag: null }] },
      },
    ]);
    assert.equal(written.count, 1);
    const ep = written.endpoints[0];
    assert.equal(ep.sampleCount, 2);
    assert.equal(ep.responseSchema.properties.items.items.type, 'object');
    assert.ok(ep.testSuggestions.includes('unicode-emoji-parity'));
  } finally {
    fs.rmSync(qaDir, { recursive: true, force: true });
  }
});
