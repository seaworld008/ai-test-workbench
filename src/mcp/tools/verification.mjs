// @ts-check
import { ASYNC_JOB_PROPS, pushBool, pushOpt } from './shared.mjs';

/** @type {import('./shared.mjs').ToolRegistryEntry[]} */
export const VERIFICATION_TOOLS = [
  {
    name: 'aitest_verify_change',
    category: 'verification',
    title: 'One-Call Agent Change Verification & Attested Verdict',
    description:
      'Execute the complete fail-closed verification pipeline in one call: Governance Lock -> Git merge-base resolution -> Impact v2 -> Ledger-bound Playwright Run -> 4-Layer AST Anti-Fake-Green Audit -> Heal Conflict Check -> Diagnostics v2 -> in-toto Statement v1 attestation + SARIF + PR summary.',
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
        mode: { type: 'string', enum: ['impact', 'full'], description: 'Selection scope (default: impact)' },
        baseUrl: { type: 'string' },
        budgetMs: { type: 'integer', minimum: 5000, maximum: 2700000 },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
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
      pushOpt(a, '--budget-ms', args.budgetMs);
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
      'Analyze git diff + reverse static import dependency graph + Run Ledger failure history + impact-map.json to select minimal affected specs with explainable provenance (read-only).',
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
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
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
      'Run deterministic Playwright tests (smoke|e2e|api|a11y|critical|seed|impact|all) bound to a T1-signed ULID Run Ledger entry, with active W3C traceparent injection and optional 4-layer anti-fake-green audit.',
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
        baseUrl: { type: 'string' },
        allowMutation: { type: 'boolean' },
        audit: { type: 'boolean', description: 'Run 4-layer anti-fake-green gate immediately after tests (default: true)' },
        workers: { type: 'integer', minimum: 1, maximum: 16 },
        retries: { type: 'integer', minimum: 0, maximum: 2 },
        grep: { type: 'string' },
        base: { type: 'string', description: 'Base ref when suite=impact' },
        lastFailed: { type: 'boolean' },
        failOnFlaky: { type: 'boolean' },
        headed: { type: 'boolean' },
        verbosity: { type: 'string', enum: ['summary', 'full'], description: 'Default summary saves tokens' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
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
      'Verify Layer 0 fail-closed governance.lock integrity + human-approved waivers, Layer 1 mandatory Ledger-bound results.json counts (maxSkipped=0), Layer 2 static tsc/ESLint/AST checks, and Layer 3 Full-File AST Semantic Diff Guard (read-only).',
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
        checkSpecs: { type: 'boolean', description: 'Run tsc --noEmit + ESLint + AST checks' },
        requireE2e: { type: 'boolean', description: 'Fail if zero online E2E tests ran' },
        staticOnly: { type: 'boolean' },
        diffBase: { type: 'string', description: 'Git ref for AST Semantic Diff Guard' },
        maxFlaky: { type: 'integer', minimum: 0, maximum: 5 },
        maxSkipped: { type: 'integer', minimum: 0, maximum: 5 },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
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
      'Classify test failures using structured runtime-guard attachments and C-before-A matcher evidence (using first failed attempt), extract 32-char W3C traceIds, apply Redaction v2, and write reports/ai-diagnostics.md unless dryRun=true.',
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
        results: { type: 'string' },
        output: { type: 'string' },
        dryRun: { type: 'boolean', description: 'Return structured failures without writing ai-diagnostics.md' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      failureCount: { type: 'integer' },
      failures: { type: 'array' },
    },
    resourceSuffix: 'diagnostics',
    isReadOnly: (args) => Boolean(args.dryRun),
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
      'Measure buffered PerformanceObserver Web Vitals (TTFB/FCP/LCP/CLS/INP multi-sample median & P75, DOMNodes, JSHeap) and concurrent GET API P50/P95/P99/RPS against perf-budget.json with full target/egress firewall.',
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
        baseUrl: { type: 'string' },
        routes: { type: 'string', description: 'Comma-separated route paths' },
        endpoint: { type: 'string', description: 'Read-only GET endpoint path' },
        concurrency: { type: 'integer', minimum: 1, maximum: 20 },
        iterations: { type: 'integer', minimum: 1, maximum: 200 },
        samples: { type: 'integer', minimum: 1, maximum: 7 },
        mode: { type: 'string', enum: ['all', 'browser', 'api'] },
        throttle: { type: 'boolean' },
        checkRegression: { type: 'boolean' },
        enforceBudget: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      budgetPassed: { type: 'boolean' },
      violations: { type: 'array' },
      browserMetrics: { type: 'array' },
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
    name: 'aitest_trace_matrix',
    category: 'verification',
    title: 'Query Requirement <-> Spec Traceability Matrix (REQ-xxx)',
    description:
      'Inspect requirement coverage across specs/*.md (REQ-xxx), tests/**/*.spec.ts, and latest results.json outcomes (read-only by default).',
    annotations: {
      title: 'Read Requirement Traceability Matrix',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      totalRequirements: { type: 'integer' },
      coveredRequirements: { type: 'integer' },
      coveragePct: { type: 'integer' },
      requirements: { type: 'array' },
    },
    isReadOnly: () => true,
    buildCliArgs: (args, target, lang) => {
      const a = ['trace-matrix', '--dry-run', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      return a;
    },
    nextActions: () => ['Add missing REQ-xxx specs or link orphan test files to requirement IDs.'],
  },
  {
    name: 'aitest_flaky_report',
    category: 'verification',
    title: 'Query Historical Flaky Telemetry & Quarantine List',
    description:
      'Read Run Ledger history to compute per-test flaky rates, consecutive pass streaks, and active quarantine.json entries (read-only).',
    annotations: {
      title: 'Read Historical Flaky Report',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      runsAnalyzed: { type: 'integer' },
      flakyCandidates: { type: 'array' },
      quarantineEntries: { type: 'array' },
    },
    isReadOnly: () => true,
    buildCliArgs: (args, target, lang) => {
      const a = ['flaky', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      return a;
    },
    nextActions: () => ['Stabilize quarantined flaky specs before their 7-day quarantine TTL expires.'],
  },
  {
    name: 'aitest_report',
    category: 'verification',
    title: 'Index Local Reports, Attestations, SARIF & Trace Artifacts',
    description:
      'Inspect generated HTML report, JUnit XML, results.json, verdict-summary.md, verdict.sarif.json, trace-matrix.md, SYSTEM_MAP.md, and Playwright trace.zip paths (read-only).',
    annotations: {
      title: 'List Local QA Report Artifacts',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      qaDir: { type: 'string' },
      traces: { type: 'array' },
    },
    isReadOnly: () => true,
    buildCliArgs: (args, target, lang) => {
      const a = ['report', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      return a;
    },
    nextActions: () => ['Read available system-map, verdict-summary, diagnostics, or perf-summary resources.'],
  },
];
