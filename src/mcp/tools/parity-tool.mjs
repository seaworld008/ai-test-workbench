// @ts-check
import { ASYNC_JOB_PROPS, pushBool, pushOpt } from './shared.mjs';

/**
 * Canonical MCP Tool #17: Dual-Target 5-Checkpoint Differential Parity Oracle (`aitest_parity`, `ADR-0006`).
 * Extracted into its own module to keep `src/mcp/tools/verification.mjs` cleanly under 435 LOC.
 * @type {import('./shared.mjs').ToolRegistryEntry}
 */
export const PARITY_TOOL = {
  name: 'aitest_parity',
  category: 'verification',
  title: 'Run Dual-Target 5-Checkpoint Differential Parity Oracle',
  description:
    'Use when comparing a Candidate service against a live Baseline service across CP1..CP5 (status/headers, key-order-independent JSON + strict byte-escape, SSE stream frames, ARIA/runtime, and latency/TTFT ratios) with deterministic shape fingerprints and optional shape-only zero-plaintext privacy mode.',
  annotations: {
    title: 'Run Dual-Target Differential Parity Oracle',
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  inputSchema: {
    type: 'object',
    properties: {
      target: { type: 'string', description: 'Target repository or QA directory' },
      baselineUrl: { type: 'string', description: 'Allowlisted non-production Baseline service base URL' },
      candidateUrl: { type: 'string', description: 'Allowlisted non-production Candidate service base URL (defaults to TEST_BASE_URL)' },
      corpus: { type: 'string', description: 'Optional relative path to sanitized JSONL/JSON traffic corpus inside QA workspace' },
      routes: { type: 'string', description: 'Optional comma-separated GET routes when no corpus file is provided' },
      privacyMode: {
        type: 'string',
        enum: ['redacted', 'shape-only'],
        description: 'Output privacy mode: redacted (default) or shape-only (zero business payload plaintext)',
      },
      strictByteEscape: {
        type: 'boolean',
        description: 'Enable raw JSON byte-level string escape comparison (e.g. \\uXXXX vs raw UTF-8)',
      },
      checkAria: {
        type: 'boolean',
        description: 'Launch headless Chromium to compare dual-target ARIA snapshots and runtime errors (CP4)',
      },
      allowMutation: {
        type: 'boolean',
        description: 'Explicitly allow write HTTP methods (POST/PUT/PATCH/DELETE) against non-loopback shared targets',
      },
      concurrency: { type: 'integer', minimum: 1, maximum: 32, description: 'Concurrent request workers (1..32, default: 8)' },
      maxLatencyRatio: { type: 'number', minimum: 0.01, description: 'Optional CP5 candidate/baseline latency ratio alert threshold' },
      maxTtftRatio: { type: 'number', minimum: 0.01, description: 'Optional CP5 candidate/baseline SSE TTFT ratio alert threshold' },
      dryRun: { type: 'boolean', description: 'Resolve parity corpus plan without issuing HTTP traffic or writing reports' },
      qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
      lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
      ...ASYNC_JOB_PROPS,
    },
    required: ['target', 'baselineUrl'],
    additionalProperties: false,
  },
  dataProps: {
    parityPct: { type: 'number' },
    totalSamples: { type: 'integer' },
    matchedSamples: { type: 'integer' },
    mismatchedSamples: { type: 'integer' },
    privacyMode: { type: 'string' },
    cohortStats: { type: 'object' },
    clusters: { type: 'array' },
    elapsedMs: { type: 'number' },
  },
  resourceSuffix: 'parity-summary',
  isReadOnly: (args) => Boolean(args.dryRun),
  buildCliArgs: (args, target, lang) => {
    const a = ['parity', '--json', `--lang=${lang}`];
    pushOpt(a, '--target', target);
    pushOpt(a, '--qa-dir', args.qaDir);
    pushOpt(a, '--baseline-url', args.baselineUrl);
    pushOpt(a, '--candidate-url', args.candidateUrl);
    pushOpt(a, '--corpus', args.corpus);
    pushOpt(a, '--routes', args.routes);
    pushOpt(a, '--privacy-mode', args.privacyMode);
    pushOpt(a, '--concurrency', args.concurrency);
    pushOpt(a, '--max-latency-ratio', args.maxLatencyRatio);
    pushOpt(a, '--max-ttft-ratio', args.maxTtftRatio);
    pushBool(a, '--strict-byte-escape', args.strictByteEscape);
    pushBool(a, '--check-aria', args.checkAria);
    pushBool(a, '--allow-mutation', args.allowMutation);
    pushBool(a, '--dry-run', args.dryRun);
    return a;
  },
  nextActions: (ok) =>
    ok
      ? ['Read aitest://project/{target}/parity-summary; pair with aitest_verify_change(mode="parity") for attested verdicts.']
      : ['Inspect deduplicated fingerprint clusters in parity-report.json and reproduce each cluster in an isolated sandbox without weakening assertions.'],
};
