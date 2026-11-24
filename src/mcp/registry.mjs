// @ts-check
import { MAX_EXPLORE_PAGES } from '../explore.mjs';
import { validateJsonSchema } from '../kernel/schema-validator.mjs';

/**
 * Single Declarative MCP Tool Registry (`M-08`, `M-14`, `M-15`).
 *
 * Eliminates the 3 parallel 21-branch tables that drifted in v5.0:
 * each tool's metadata, annotations, inputSchema, outputSchema, CLI argument mapping,
 * readOnly semantics, resource link suffix, and nextActions live in ONE record.
 */

const ASYNC_JOB_PROPS = {
  async: { type: 'boolean', description: 'Run asynchronously in Job Runner and return jobId immediately' },
  syncBudgetMs: {
    type: 'integer',
    minimum: 25,
    maximum: 600000,
    description: 'Milliseconds to wait before auto-backgrounding into a pollable jobId',
  },
};

function makeOutputSchema(dataProperties = {}) {
  return {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      exitCode: { type: 'integer' },
      tool: { type: 'string' },
      summary: { type: 'string' },
      data: {
        type: 'object',
        properties: dataProperties,
        additionalProperties: true,
      },
      nextRecommendedActions: { type: 'array', items: { type: 'string' } },
    },
    required: ['ok', 'exitCode', 'tool', 'summary', 'data', 'nextRecommendedActions'],
    additionalProperties: true,
  };
}

/**
 * Safely appends `--flag=value` so values beginning with `-` (e.g. `grep: "-foo"`) are never
 * misinterpreted by `parseArgs({ strict: true })` as unknown CLI flags (`M-08`).
 */
function pushOpt(arr, flag, val) {
  if (val !== undefined && val !== null && val !== '') {
    arr.push(`${flag}=${String(val)}`);
  }
}

function pushBool(arr, flag, val) {
  if (val) arr.push(flag);
}

/**
 * @typedef {{
 *   name: string,
 *   title: string,
 *   description: string,
 *   annotations: { title: string, readOnlyHint: boolean, destructiveHint: boolean, idempotentHint: boolean, openWorldHint: boolean },
 *   inputSchema: Record<string, any>,
 *   dataProps: Record<string, any>,
 *   inMemory?: boolean,
 *   resourceSuffix?: string,
 *   isReadOnly?: (args: Record<string, any>) => boolean,
 *   buildCliArgs?: (args: Record<string, any>, target: string | null, lang: string) => string[],
 *   getTimeoutMs?: (args: Record<string, any>) => number | undefined,
 *   nextActions: (ok: boolean, args: Record<string, any>) => string[],
 * }} ToolRegistryEntry
 */

/** @type {ToolRegistryEntry[]} */
export const TOOL_REGISTRY = [
  {
    name: 'aitest_doctor',
    title: 'Environment, Browser & Gate Kernel Readiness Check',
    description:
      'Inspect local Node.js (>=22.12), npm, Git, Codex/Claude CLIs, Docker, proxy hygiene, Chromium cache, and host Gate Kernel version drift (strictly read-only).',
    annotations: {
      title: 'Check Test Workbench Environment',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Optional target repository or QA directory to verify' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      additionalProperties: false,
    },
    dataProps: {
      ok: { type: 'boolean' },
      failCount: { type: 'integer' },
      warnCount: { type: 'integer' },
      checks: { type: 'array' },
    },
    isReadOnly: () => true,
    buildCliArgs: (_args, target, lang) => {
      const a = ['doctor', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      return a;
    },
    nextActions: () => ['Call aitest_init with dryRun=true to preview isolated QA scaffolding.'],
  },
  {
    name: 'aitest_init',
    title: 'Initialize Isolated QA Workspace & Governance Lock',
    description:
      'Idempotently scaffold an isolated <repo>/qa Playwright Test Workbench (5 projects, guarded fixtures, T1-signed .aitest/governance.lock). May install npm dependencies & Chromium unless skipInstall=true.',
    annotations: {
      title: 'Initialize <repo>/qa Subproject',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository root path' },
        name: { type: 'string', description: 'Project slug for QA package.json' },
        qaDir: { type: 'string', description: 'QA subdirectory name (default: qa)' },
        preset: { type: 'string', enum: ['generic', 'demo-campus'], description: 'Template preset' },
        loop: { type: 'string', description: 'Agent loops CSV: codex,claude,vscode,opencode,copilot,none' },
        dryRun: { type: 'boolean', description: 'Preview planned writes without mutating disk' },
        skipInstall: { type: 'boolean', description: 'Skip npm install during init' },
        skipBrowser: { type: 'boolean', description: 'Skip Playwright Chromium install check' },
        bridgeRoot: { type: 'boolean', description: 'Write root .mcp.json bridge to <repo>/qa' },
        lang: { type: 'string', enum: ['zh', 'en'] },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: { output: { type: 'string' } },
    isReadOnly: (args) => Boolean(args.dryRun),
    buildCliArgs: (args, target, lang) => {
      const a = ['init', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--name', args.name);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--preset', args.preset);
      pushOpt(a, '--loop', args.loop);
      pushBool(a, '--dry-run', args.dryRun);
      pushBool(a, '--skip-install', args.skipInstall);
      pushBool(a, '--skip-browser', args.skipBrowser);
      pushBool(a, '--bridge-root', args.bridgeRoot);
      return a;
    },
    nextActions: (_ok, args) =>
      args.dryRun
        ? ['Call aitest_init with dryRun=false to apply files and generate .aitest/governance.lock.']
        : ['Call aitest_verify_change(mode="full") to verify the 4-layer anti-fake-green baseline.'],
  },
  {
    name: 'aitest_explore',
    title: 'Zero-to-One Default-Deny Read-Only Explorer',
    description:
      'Explore an allowlisted staging/local web app with default-deny on ALL non-GET/HEAD requests (GraphQL mutations, WebSockets & sendBeacon blocked). Writes PII-redacted specs/system-overview.md & specs/pages/*.md ARIA trees unless dryRun=true.',
    annotations: {
      title: 'Explore Target App (Remote Read-Only, Writes Local Specs)',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        qaDir: { type: 'string' },
        baseUrl: { type: 'string', description: 'Allowlisted staging/local base URL' },
        entryPath: { type: 'string', description: 'Starting route path (default: /)' },
        maxPages: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_EXPLORE_PAGES,
          description: `Maximum routes to crawl across portals (1..${MAX_EXPLORE_PAGES})`,
        },
        explorePortals: {
          type: 'boolean',
          description: 'Discover & traverse multi-portal / tenant switcher drawers (default: true)',
        },
        exploreTabs: {
          type: 'boolean',
          description: 'Click read-only intra-page tabs to inspect sub-views (default: true)',
        },
        exploreDialogs: {
          type: 'boolean',
          description: 'Open & close strictly read-only detail/preview dialogs & drawers (default: true)',
        },
        maxPortals: {
          type: 'integer',
          minimum: 1,
          maximum: 5,
          description: 'Maximum portal/tenant contexts to explore (1..5, default: 3)',
        },
        noSyncImpact: { type: 'boolean' },
        dryRun: { type: 'boolean', description: 'Explore in memory without writing local files' },
        lang: { type: 'string', enum: ['zh', 'en'] },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      snapshotId: { type: 'string' },
      pagesCount: { type: 'integer' },
      endpointsCount: { type: 'integer' },
      blockedWritesCount: { type: 'integer' },
    },
    resourceSuffix: 'system-overview',
    isReadOnly: (args) => Boolean(args.dryRun),
    buildCliArgs: (args, target, lang) => {
      const a = ['explore', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--base-url', args.baseUrl);
      pushOpt(a, '--entry-path', args.entryPath);
      pushOpt(a, '--max-pages', args.maxPages);
      pushOpt(a, '--max-portals', args.maxPortals);
      if (args.explorePortals === false) a.push('--no-explore-portals');
      if (args.exploreTabs === false) a.push('--no-explore-tabs');
      if (args.exploreDialogs === false) a.push('--no-explore-dialogs');
      pushBool(a, '--no-sync-impact', args.noSyncImpact);
      pushBool(a, '--dry-run', args.dryRun);
      return a;
    },
    nextActions: () => [
      'Read aitest://project/{target}/system-overview and specs/pages/*.md ARIA trees.',
      'Author REQ-xxx specs and Playwright tests extending fixtures/base.ts.',
    ],
  },
  {
    name: 'aitest_map_sync',
    title: 'Sync Convergent Living Code Map v4',
    description:
      'Index host source repository routes (including :id / [id] dynamic routes), controllers & DB entities, prune deleted routes/specs, and converge defects into knowledge/code-map.json & SYSTEM_MAP.md.',
    annotations: {
      title: 'Synchronize Living Code Map v4',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository or QA directory' },
        repo: { type: 'string', description: 'Optional host source directory path' },
        qaDir: { type: 'string' },
        noSyncImpact: { type: 'boolean', description: 'Skip auto-updating impact-map suggestions' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      revision: { type: 'integer' },
      openDefects: { type: 'integer' },
      coverage: { type: 'object' },
    },
    resourceSuffix: 'system-map',
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const a = ['map', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--repo', args.repo);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushBool(a, '--no-sync-impact', args.noSyncImpact);
      return a;
    },
    nextActions: () => ['Read aitest://project/{target}/system-map for uncovered routes, dynamic routes, and convergent defects.'],
  },
  {
    name: 'aitest_impact',
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
        : ['Call aitest_heal_begin to triage failures under stateful A/B/C/D governance.'],
  },
  {
    name: 'aitest_audit',
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
    nextActions: () => ['Call aitest_heal_begin with testId to start governed A/B/C/D handling.'],
  },
  {
    name: 'aitest_perf',
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
    name: 'aitest_mcp_hub',
    title: 'Manage Pinned 7-Pillar MCP Presets & Supply-Chain Doctor',
    description:
      'List version-pinned, risk-graded MCP presets, merge configs into .mcp.json & .codex/config.toml, or audit supply-chain pins, prompt-poisoning & .aitest/mcp.lock via doctor.',
    annotations: {
      title: 'Configure & Audit System MCP Hub',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['presets', 'add', 'doctor'], description: 'MCP Hub sub-action' },
        target: { type: 'string', description: 'Required for add and doctor' },
        profile: { type: 'string', enum: ['minimal', 'observability', 'data-verify', 'perf', 'full-link'] },
        servers: { type: 'string', description: 'Comma-separated preset names' },
        lock: { type: 'boolean', description: 'Write .aitest/mcp.lock hashes during doctor' },
        dryRun: { type: 'boolean' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['action'],
      additionalProperties: false,
    },
    dataProps: {},
    isReadOnly: (args) => args.action === 'presets' || (args.action === 'doctor' && !args.lock),
    buildCliArgs: (args, target, lang) => {
      const a = ['mcp', args.action || 'presets', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--profile', args.profile);
      pushOpt(a, '--servers', args.servers);
      pushBool(a, '--lock', args.lock);
      pushBool(a, '--dry-run', args.dryRun);
      return a;
    },
    nextActions: () => ['Call aitest_mcp_hub(action="doctor", lock=true) to lock MCP descriptor hashes into .aitest/mcp.lock.'],
  },
  {
    name: 'aitest_report',
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
  {
    name: 'aitest_skill_install',
    title: 'Install Portable Agent Skill into Project',
    description:
      'Install the standard ai-test-workbench Agent Skill into qa/skills/, .codex/skills/, .claude/skills/, .agents/skills/, .gemini/skills/, or .github/skills/ cleanly (force=true overwrites existing skill files).',
    annotations: {
      title: 'Install AI Test Workbench Skill',
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository path' },
        client: { type: 'string', enum: ['qa', 'codex', 'claude', 'agents', 'gemini', 'copilot'] },
        force: { type: 'boolean' },
        dryRun: { type: 'boolean' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {},
    isReadOnly: (args) => Boolean(args.dryRun),
    buildCliArgs: (args, target, lang) => {
      const a = ['skill-install', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--client', args.client || 'qa');
      pushBool(a, '--force', args.force);
      pushBool(a, '--dry-run', args.dryRun);
      return a;
    },
    nextActions: () => ['Ensure target agent client reloads SKILL.md from the installed directory.'],
  },
  {
    name: 'aitest_verify_change',
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
        : ['Follow nextActions in data to invoke aitest_heal_begin per failing spec.'],
  },
  {
    name: 'aitest_heal_begin',
    title: 'Begin Stateful A/B/C/D Heal Session',
    description:
      'Start a T1-signed governed Heal Session for a failing test. Only Class A locator drift allows repair attempts (<= 3 across sessions per testId); Class B/C/D lock out test edits.',
    annotations: {
      title: 'Begin Governed Heal Session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        testId: { type: 'string', description: 'Optional testId or title substring from diagnostics' },
        results: { type: 'string' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: { session: { type: 'object' } },
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const a = ['heal', 'begin', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--test-id', args.testId);
      pushOpt(a, '--results', args.results);
      return a;
    },
    nextActions: () => ['If categoryCode=="A", edit only the semantic locator and call aitest_heal_attempt; otherwise call aitest_heal_conclude.'],
  },
  {
    name: 'aitest_heal_attempt',
    title: 'Validate & Run Class-A Repair Attempt (<= 3)',
    description:
      'Verify a Class-A test repair against Governance Lock + Full-File AST Semantic Diff Guard (blocking assertion weakening, S0 tautologies, soft assertions, catch suppression, backend mocking) and re-run the target spec.',
    annotations: {
      title: 'Execute Guarded Heal Repair Attempt',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        sessionId: { type: 'string' },
        skipRun: { type: 'boolean', description: 'Validate semantic gates only without running Playwright' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target', 'sessionId'],
      additionalProperties: false,
    },
    dataProps: {
      sessionId: { type: 'string' },
      state: { type: 'string' },
      attemptsUsed: { type: 'integer' },
    },
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const a = ['heal', 'attempt', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--session-id', args.sessionId);
      pushBool(a, '--skip-run', args.skipRun);
      return a;
    },
    nextActions: (ok) =>
      ok
        ? ['Call aitest_heal_conclude(outcome="verified") to close the repair session.']
        : ['Inspect semantic gate violations or remainingAttempts; escalate via aitest_heal_conclude if exhausted.'],
  },
  {
    name: 'aitest_heal_conclude',
    title: 'Conclude Heal Session & Emit Class-C Defect Ticket',
    description:
      'Finalize a Heal Session as verified, escalated, or reported; automatically writes a structured Defect Ticket (Markdown + JSON with 32-char traceId) for Class-C product bugs.',
    annotations: {
      title: 'Conclude Governed Heal Session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        sessionId: { type: 'string' },
        outcome: { type: 'string', enum: ['verified', 'reported', 'escalated', 'clarification-needed'] },
        summary: { type: 'string' },
        qaDir: { type: 'string' },
        lang: { type: 'string', enum: ['zh', 'en'] },
      },
      required: ['target', 'sessionId'],
      additionalProperties: false,
    },
    dataProps: {
      sessionId: { type: 'string' },
      outcome: { type: 'string' },
      defectTicketPath: { type: ['string', 'null'] },
    },
    isReadOnly: () => false,
    buildCliArgs: (args, target, lang) => {
      const a = ['heal', 'conclude', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--session-id', args.sessionId);
      pushOpt(a, '--outcome', args.outcome);
      pushOpt(a, '--summary', args.summary);
      return a;
    },
    nextActions: () => ['Attach any generated reports/defects/*.md ticket to your issue tracker.'],
  },
  {
    name: 'aitest_flaky_report',
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
    name: 'aitest_trace_matrix',
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
    name: 'aitest_job_status',
    title: 'Poll Async Background Job Status',
    description: 'Check live status, progress line count, and latest message of an async MCP job owned by this session (read-only).',
    annotations: {
      title: 'Check Async Job Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    dataProps: {
      jobId: { type: 'string' },
      status: { type: 'string' },
    },
    inMemory: true,
    isReadOnly: () => true,
    nextActions: () => [],
  },
  {
    name: 'aitest_job_result',
    title: 'Await or Retrieve Async Background Job Result',
    description:
      'Retrieve final structured result of a backgrounded MCP job owned by this session, optionally waiting up to waitMs milliseconds before returning (read-only).',
    annotations: {
      title: 'Retrieve Async Job Result',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
        waitMs: { type: 'integer', minimum: 0, maximum: 60000 },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    dataProps: {
      jobId: { type: 'string' },
      status: { type: 'string' },
      data: { type: 'object' },
    },
    inMemory: true,
    isReadOnly: () => true,
    nextActions: () => [],
  },
  {
    name: 'aitest_job_cancel',
    title: 'Cancel Running Background Job & Process Tree',
    description: 'Terminate a running async MCP job owned by this session and its entire OS child-process tree cleanly.',
    annotations: {
      title: 'Cancel Running Job',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: {
      type: 'object',
      properties: {
        jobId: { type: 'string' },
      },
      required: ['jobId'],
      additionalProperties: false,
    },
    dataProps: {
      cancelled: { type: 'boolean' },
    },
    inMemory: true,
    isReadOnly: () => false,
    nextActions: () => [],
  },
];

/** @type {Map<string, ToolRegistryEntry>} */
export const TOOL_BY_NAME = new Map(TOOL_REGISTRY.map((entry) => [entry.name, entry]));

/**
 * Generates MCP `tools/list` definitions directly from the single declarative registry.
 * Omits `outputSchema` when explicitly negotiating legacy `2024-11-05` (`M-10`).
 * @param {string} [protocolVersion]
 */
export function getMcpToolDefinitions(protocolVersion = '2025-11-25') {
  const includeOutputSchema = protocolVersion !== '2024-11-05';
  return TOOL_REGISTRY.map((entry) => {
    /** @type {Record<string, any>} */
    const def = {
      name: entry.name,
      title: entry.title,
      description: entry.description,
      annotations: entry.annotations,
      inputSchema: entry.inputSchema,
    };
    if (includeOutputSchema) {
      def.outputSchema = makeOutputSchema(entry.dataProps || {});
    }
    return def;
  });
}

/**
 * Validates tool arguments against the tool's declared JSON Schema before execution (`M-08`).
 * Allows `target` to be supplied via `ctx.defaultTarget` before checking required fields.
 * @param {ToolRegistryEntry} toolEntry
 * @param {Record<string, any>} args
 * @param {string | null} defaultTarget
 */
export function validateToolArguments(toolEntry, args, defaultTarget) {
  const effectiveArgs = { ...args };
  if (!effectiveArgs.target && defaultTarget && toolEntry.inputSchema?.properties?.target) {
    effectiveArgs.target = defaultTarget;
  }
  return validateJsonSchema(effectiveArgs, toolEntry.inputSchema);
}
