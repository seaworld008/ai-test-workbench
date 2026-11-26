// @ts-check
import {
  executeDiagnoseDryRunFastPath,
  executeImpactReadOnlyFastPath,
  executeReportReadOnlyFastPath,
} from './fast-paths.mjs';
import { PARITY_TOOL } from './parity-tool.mjs';
import { ASYNC_JOB_PROPS, pushBool, pushOpt } from './shared.mjs';

/** @type {import('./shared.mjs').ToolRegistryEntry[]} */
export const VERIFICATION_TOOLS = [
  {
    name: 'aitest_verify_change',
    category: 'verification',
    title: 'One-Call Agent Change Verification & Attested Verdict',
    description:
      'Use when verifying code or spec edits end-to-end. Runs Governance Lock, Git merge-base diff resolution, Impact v2, Ledger-bound Playwright execution, 4-Layer AST Anti-Fake-Green Audit, Heal conflict checks, Diagnostics, and in-toto attestation.',
    annotations: {
      title: 'Verify Code Change End-to-End',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        base: { type: 'string', description: 'Optional explicit Git base ref (default: merge-base or HEAD~1)' },
        mode: { type: 'string', enum: ['impact', 'full', 'smoke', 'e2e', 'api', 'parity'], description: 'Selection scope (default: impact; use parity with baselineUrl for dual-target oracle)' },
        baseUrl: { type: 'string', description: 'Target application base URL override' },
        baselineUrl: { type: 'string', description: 'Optional allowlisted Baseline service URL to enforce differential parity oracle alongside tests' },
        corpus: { type: 'string', description: 'Optional relative path to sanitized corpus file when parity oracle is enabled' },
        privacyMode: { type: 'string', enum: ['redacted', 'shape-only'], description: 'Privacy mode for differential parity output (redacted | shape-only)' },
        strictByteEscape: { type: 'boolean', description: 'Enable raw JSON byte-escape parity checks when baselineUrl is provided' },
        allowMutation: { type: 'boolean', description: 'Explicitly allow or forbid @mutation tests' },
        allowOfflineSmoke: { type: 'boolean', description: 'Explicitly permit offline smoke when no target server URL is reachable' },
        budgetMs: { type: 'integer', minimum: 5000, maximum: 2700000, description: 'Execution timeout budget in milliseconds' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      verdict: { type: 'string' },
      trustTier: { type: 'string' },
      runId: { type: ['string', 'null'] },
      acceptanceScope: { type: 'string' },
      gates: { type: 'object' },
      failures: { type: 'array' },
    },
    resourceSuffix: 'verdict-summary',
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const a = ['verify-change', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--base', args.base);
      pushOpt(a, '--mode', args.mode || 'impact');
      pushOpt(a, '--base-url', args.baseUrl);
      pushOpt(a, '--baseline-url', args.baselineUrl);
      pushOpt(a, '--corpus', args.corpus);
      pushOpt(a, '--privacy-mode', args.privacyMode);
      pushOpt(a, '--budget-ms', args.budgetMs);
      pushBool(a, '--strict-byte-escape', args.strictByteEscape);
      pushBool(a, '--allow-mutation', args.allowMutation);
      pushBool(a, '--allow-offline-smoke', args.allowOfflineSmoke);
      return a;
    },
    getTimeoutMs: (args) => (args.budgetMs ? Number(args.budgetMs) + 30_000 : undefined),
    nextActions: (ok) =>
      ok
        ? ['Read aitest://project/{target}/verdict-summary; run CI workflow for T2 signed merge attestation.']
        : ['Follow nextActions in data to invoke aitest_heal(action="begin") per failing spec.'],
  },
  {
    name: 'aitest_impact',
    category: 'verification',
    title: 'Compute Dependency-Graph Diff-Impact Scope (v2)',
    description:
      'Use when deciding which specs are affected by changed files. Analyzes git diff, reverse static import dependency graphs, CodeMap auto-links, REQ-* tags, and Run Ledger failure history (read-only).',
    annotations: {
      title: 'Compute Git Diff & Import-Graph Test Impact',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        base: { type: 'string', description: 'Git base ref (default: merge-base or HEAD~1)' },
        files: { type: 'string', description: 'Comma-separated changed file paths to simulate' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      mode: { type: 'string' },
      specs: { type: 'array' },
      why: { type: 'array' },
    },
    isReadOnly: () => true,
    execute: executeImpactReadOnlyFastPath,
    buildCliArgs: (args, target, lang) => {
      const a = ['impact', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--base', args.base);
      pushOpt(a, '--files', args.files);
      return a;
    },
    nextActions: () => ['Call aitest_verify_change(mode="impact") for fast attested verification.'],
  },
  {
    name: 'aitest_run',
    category: 'verification',
    title: 'Execute Ledger-Bound Deterministic Playwright Suite',
    description:
      'Use when running a Playwright suite or iterating rapidly on specific test files/lines. Executes tests bound to a T1-signed Run Ledger entry with inline failure ARIA context and optional 4-layer gate audit.',
    annotations: {
      title: 'Run Deterministic Playwright Suite',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        suite: {
          type: 'string',
          enum: ['smoke', 'e2e', 'api', 'a11y', 'critical', 'seed', 'impact', 'all'],
          description: 'Test suite to run (default: smoke)',
        },
        baseUrl: { type: 'string', description: 'Target application base URL override' },
        allowMutation: { type: 'boolean', description: 'Explicitly allow or forbid @mutation write tests' },
        audit: { type: 'boolean', description: 'Run 4-layer anti-fake-green gate immediately after tests (default: true)' },
        workers: { type: 'integer', minimum: 1, maximum: 16, description: 'Playwright parallel worker count (1..16)' },
        retries: { type: 'integer', minimum: 0, maximum: 2, description: 'Maximum Playwright retry count (0..2)' },
        grep: { type: 'string', description: 'Playwright test title filter pattern' },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Relative spec file paths for rapid single-file inner loop',
        },
        line: { type: 'integer', minimum: 1, description: 'Optional 1-based line number when targeting a single file' },
        base: { type: 'string', description: 'Base ref when suite=impact' },
        lastFailed: { type: 'boolean', description: 'Re-run only tests that failed in the previous run' },
        failOnFlaky: { type: 'boolean', description: 'Exit non-zero if any test passes only on retry' },
        headed: { type: 'boolean', description: 'Launch visible Chromium browser window during execution' },
        verbosity: { type: 'string', enum: ['summary', 'full'], description: 'Response detail level (summary or full; default: summary)' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      runId: { type: 'string' },
      suite: { type: 'string' },
      acceptanceScope: { type: 'string' },
      counts: { type: 'object' },
      failures: { type: 'array' },
      audit: { type: 'object' },
    },
    resourceSuffix: 'diagnostics',
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const a = ['run', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--suite', args.suite || 'smoke');
      pushOpt(a, '--base-url', args.baseUrl);
      pushOpt(a, '--workers', args.workers);
      pushOpt(a, '--retries', args.retries);
      pushOpt(a, '--grep', args.grep);
      if (Array.isArray(args.files) && args.files.length > 0) {
        pushOpt(a, '--files', args.files.join(','));
      }
      pushOpt(a, '--line', args.line);
      pushOpt(a, '--base', args.base);
      pushOpt(a, '--verbosity', args.verbosity || 'summary');
      pushBool(a, '--allow-mutation', args.allowMutation);
      pushBool(a, '--audit', args.audit !== false);
      pushBool(a, '--last-failed', args.lastFailed);
      pushBool(a, '--fail-on-flaky', args.failOnFlaky);
      pushBool(a, '--headed', args.headed);
      return a;
    },
    nextActions: (ok) =>
      ok
        ? ['Call aitest_audit(checkSpecs=true) or aitest_verify_change for full attestation.']
        : ['Call aitest_heal(action="begin") to triage failures under stateful A/B/C/D governance.'],
  },
  {
    name: 'aitest_audit',
    category: 'verification',
    title: 'Run 4-Layer Fail-Closed Anti-Fake-Green Quality Gate',
    description:
      'Use when independently verifying governance.lock integrity, Run Ledger binding, static tsc/ESLint/AST checks, and Full-File AST Semantic Diff Guard + product-side Dieselgate checks (read-only).',
    annotations: {
      title: 'Audit 4-Layer Anti-Fake-Green Gates',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        checkSpecs: { type: 'boolean', description: 'Run tsc --noEmit + ESLint + AST checks (default unless staticOnly)' },
        requireE2e: { type: 'boolean', description: 'Fail if zero online E2E tests ran' },
        staticOnly: { type: 'boolean', description: 'Skip runtime results check and audit static/diff layers only' },
        diffBase: { type: 'string', description: 'Git ref for AST Semantic Diff Guard' },
        maxFlaky: { type: 'integer', minimum: 0, maximum: 5, description: 'Maximum allowed flaky tests' },
        maxSkipped: { type: 'integer', minimum: 0, maximum: 5, description: 'Maximum allowed unwaived skipped tests (default: 0)' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      ok: { type: 'boolean' },
      outcome: { type: 'string' },
      trustTier: { type: 'string' },
      runId: { type: ['string', 'null'] },
      gates: { type: 'object' },
      errors: { type: 'array' },
      stats: { type: ['object', 'null'] },
    },
    isReadOnly: () => true,
    buildCliArgs: (args, target, lang) => {
      const a = ['audit', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--diff-base', args.diffBase);
      pushOpt(a, '--max-flaky', args.maxFlaky);
      pushOpt(a, '--max-skipped', args.maxSkipped);
      pushBool(a, '--check-specs', args.checkSpecs);
      pushBool(a, '--require-e2e', args.requireE2e);
      pushBool(a, '--static-only', args.staticOnly);
      return a;
    },
    nextActions: (ok) =>
      ok
        ? ['All 4 quality gate layers passed locally; run CI workflow for T2 merge attestation.']
        : ['Address static/runtime/semantic-diff violations without editing protected governance files or weakening assertions.'],
  },
  {
    name: 'aitest_diagnose',
    category: 'verification',
    title: 'Generate Redacted Evidence-First A/B/C/D Diagnostics Report',
    description:
      'Use when analyzing why tests failed. Classifies failures into A/B/C/D (plus A-UI-Sync frontend diff correlation), extracts 32-char W3C traceIds, redacts secrets, and writes reports/ai-diagnostics.md unless dryRun=true.',
    annotations: {
      title: 'Diagnose Test Failures (Writes Redacted Report)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        results: { type: 'string', description: 'Optional custom results.json path relative to QA directory' },
        output: { type: 'string', description: 'Optional Markdown output path for ai-diagnostics.md' },
        dryRun: { type: 'boolean', description: 'Return structured failures without writing ai-diagnostics.md' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      failureCount: { type: 'integer' },
      clusterCount: { type: 'integer' },
      clusters: { type: 'array' },
      failures: { type: 'array' },
    },
    resourceSuffix: 'diagnostics',
    isReadOnly: (args) => Boolean(args.dryRun),
    execute: executeDiagnoseDryRunFastPath,
    buildCliArgs: (args, target, lang) => {
      const a = ['diagnose', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--results', args.results);
      pushOpt(a, '--output', args.output);
      pushBool(a, '--dry-run', args.dryRun);
      return a;
    },
    nextActions: () => ['Call aitest_heal(action="begin") with testId to start governed A/B/C/D handling.'],
  },
  {
    name: 'aitest_perf',
    category: 'verification',
    title: 'Run PerformanceObserver Web Vitals & Read-Only API SLO Benchmark',
    description:
      'Use when measuring Web Vitals (TTFB/FCP/LCP/CLS/INP) and GET API latency percentiles (P50/P95/P99/RPS) against perf-budget.json under full target/egress firewall protection.',
    annotations: {
      title: 'Measure Web Vitals & API SLOs',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        baseUrl: { type: 'string', description: 'Allowlisted target application base URL' },
        routes: { type: 'string', description: 'Comma-separated browser route paths to sample' },
        endpoint: { type: 'string', description: 'Read-only GET endpoint path for load sampling' },
        sseEndpoint: { type: 'string', description: 'Streaming SSE endpoint path for TTFT and stream SLO sampling' },
        concurrency: { type: 'integer', minimum: 1, maximum: 20, description: 'Concurrent API workers (1..20)' },
        iterations: { type: 'integer', minimum: 1, maximum: 200, description: 'Total GET requests across iterations (1..200)' },
        samples: { type: 'integer', minimum: 1, maximum: 7, description: 'Browser samples per route for median/P75 (1..7)' },
        mode: { type: 'string', enum: ['all', 'browser', 'api', 'sse'], description: 'Benchmark scope (all | browser | api | sse)' },
        throttle: { type: 'boolean', description: 'Apply CPU/network throttling during Chromium sampling' },
        checkRegression: { type: 'boolean', description: 'Compare current metrics against baseline snapshot' },
        enforceBudget: { type: 'boolean', description: 'Fail command when perf-budget.json thresholds are exceeded' },
        dryRun: { type: 'boolean', description: 'Compute benchmark plan without executing browser/API traffic' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      budgetPassed: { type: 'boolean' },
      violations: { type: 'array' },
      browserMetrics: { type: 'array' },
      sseBenchmark: { type: ['object', 'null'] },
    },
    resourceSuffix: 'perf-summary',
    isReadOnly: (args) => Boolean(args.dryRun),
    buildCliArgs: (args, target, lang) => {
      const a = ['perf', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--base-url', args.baseUrl);
      pushOpt(a, '--routes', args.routes);
      pushOpt(a, '--endpoint', args.endpoint);
      pushOpt(a, '--sse-endpoint', args.sseEndpoint);
      pushOpt(a, '--concurrency', args.concurrency);
      pushOpt(a, '--iterations', args.iterations);
      pushOpt(a, '--samples', args.samples);
      pushOpt(a, '--mode', args.mode);
      pushBool(a, '--throttle', args.throttle);
      pushBool(a, '--check-regression', args.checkRegression);
      pushBool(a, '--enforce-budget', args.enforceBudget);
      pushBool(a, '--dry-run', args.dryRun);
      return a;
    },
    nextActions: (ok) =>
      ok
        ? ['Read aitest://project/{target}/perf-summary for PerformanceObserver LCP/CLS/INP & API P95 metrics.']
        : ['Correlate slow routes/APIs with 32-char traceId in Loki/Prometheus MCPs.'],
  },
  {
    name: 'aitest_report',
    category: 'verification',
    title: 'Query Reports Index, Flaky Telemetry & Requirement Traceability',
    description:
      'Use when inspecting generated QA artifacts, latest run overview, historical flaky telemetry, or REQ-xxx requirement traceability coverage. Select view="summary", "artifacts" (default), "flaky", or "traceability" (read-only by default).',
    annotations: {
      title: 'Inspect Reports, Flaky Telemetry & Trace Matrix',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        view: {
          type: 'string',
          enum: ['summary', 'artifacts', 'flaky', 'traceability'],
          description: 'Report view: summary (artifacts + latest run overview), artifacts (local files), flaky (Run Ledger telemetry), or traceability (REQ-xxx matrix)',
        },
        syncQuarantine: {
          type: 'boolean',
          description: 'When view="flaky", update signed quarantine.json from Run Ledger telemetry',
        },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      view: { type: 'string' },
      qaDir: { type: 'string' },
      traces: { type: 'array' },
      runsAnalyzed: { type: 'integer' },
      flakyCandidates: { type: 'array' },
      requirements: { type: 'array' },
    },
    isReadOnly: (args) => !Boolean(args.syncQuarantine),
    execute: executeReportReadOnlyFastPath,
    buildCliArgs: (args, target, lang) => {
      const a = ['report', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--view', args.view || 'artifacts');
      pushBool(a, '--sync-quarantine', args.syncQuarantine);
      return a;
    },
    nextActions: () => ['Read available system-map, verdict-summary, diagnostics, or perf-summary resources.'],
  },
  PARITY_TOOL,
];
