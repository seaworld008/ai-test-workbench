// @ts-check
import { MAX_EXPLORE_PAGES } from '../../explore/safety.mjs';
import { getMcpPresetsSummary } from '../../mcp-hub/catalog.mjs';
import { ASYNC_JOB_PROPS, pushBool, pushOpt } from './shared.mjs';

/** @type {import('./shared.mjs').ToolRegistryEntry[]} */
export const DISCOVERY_TOOLS = [
  {
    name: 'aitest_doctor',
    category: 'discovery',
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
    category: 'discovery',
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
    dataProps: {
      qaDir: { type: 'string' },
      dryRun: { type: 'boolean' },
      created: { type: 'array' },
      updated: { type: 'array' },
      skipped: { type: 'array' },
    },
    isReadOnly: (args) => Boolean(args.dryRun),
    buildCliArgs: (args, target, lang) => {
      const a = ['init', '--json', `--lang=${lang}`];
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
    category: 'discovery',
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
    category: 'discovery',
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
    name: 'aitest_mcp_hub',
    category: 'discovery',
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
    skipWorkspaceBoundary: (args) => args.action === 'presets',
    execute: (args) => {
      if (args.action !== 'presets') return null;
      return {
        ok: true,
        exitCode: 0,
        summary: 'Listed 7-pillar pinned MCP presets',
        data: getMcpPresetsSummary(),
      };
    },
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
    name: 'aitest_skill_install',
    category: 'discovery',
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
];
