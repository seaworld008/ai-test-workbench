// @ts-check
import { MAX_EXPLORE_PAGES } from '../../explore/safety.mjs';
import { executeDoctorReadOnlyFastPath, executeMcpHubReadOnlyFastPath } from './fast-paths.mjs';
import { ASYNC_JOB_PROPS, pushBool, pushOpt } from './shared.mjs';

/** @type {import('./shared.mjs').ToolRegistryEntry[]} */
export const DISCOVERY_TOOLS = [
  {
    name: 'aitest_doctor',
    category: 'discovery',
    title: 'Environment, Browser & Gate Kernel Readiness Check',
    description:
      'Use when verifying local toolchain readiness. Inspects Node.js (>=22.12), npm, Git, Codex/Claude CLIs, Docker, proxy hygiene, Chromium cache, and host Gate Kernel version drift (strictly read-only).',
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
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
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
    execute: executeDoctorReadOnlyFastPath,
    buildCliArgs: (_args, target, lang) => {
      const a = ['doctor', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      return a;
    },
    nextActions: () => ['Call aitest_bootstrap(target) or aitest_init(target, dryRun=true) to prepare isolated QA scaffolding.'],
  },
  {
    name: 'aitest_init',
    category: 'discovery',
    title: 'Initialize Isolated QA Workspace & Governance Lock',
    description:
      'Use when scaffolding an isolated <repo>/qa Playwright workbench for the first time without probing runtime dev servers. Generates 5 projects, guarded fixtures, and T1-signed .aitest/governance.lock.',
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
        preset: { type: 'string', enum: ['generic', 'demo-campus'], description: 'Template preset name (generic or demo-campus)' },
        loop: { type: 'string', description: 'Agent loops CSV: codex,claude,vscode,opencode,copilot,none' },
        dryRun: { type: 'boolean', description: 'Preview planned writes without mutating disk' },
        skipInstall: { type: 'boolean', description: 'Skip npm install during init' },
        skipBrowser: { type: 'boolean', description: 'Skip Playwright Chromium install check' },
        bridgeRoot: { type: 'boolean', description: 'Write root .mcp.json bridge to <repo>/qa' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
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
        : ['Call aitest_verify_change(mode="impact") to verify the 4-layer anti-fake-green baseline.'],
  },
  {
    name: 'aitest_bootstrap',
    category: 'discovery',
    title: 'Zero-to-One Autonomous Loopback Bootstrapper',
    description:
      'Use when onboarding a new or cold repository end-to-end before running tests. Idempotently initializes <repo>/qa, infers loopback aitest.runtime.json, installs dependencies, probes health endpoints, and records baseline-ref.',
    annotations: {
      title: 'Bootstrap Autonomous Local QA Runtime',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: 'Target repository root path' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path (default: qa)' },
        baseUrl: { type: 'string', description: 'Optional loopback HTTP base URL override (e.g. http://127.0.0.1:5173)' },
        healthPath: { type: 'string', description: 'Health check route path to probe (default: /)' },
        port: { type: 'integer', minimum: 1, maximum: 65535, description: 'Optional local dev server port override' },
        preset: { type: 'string', enum: ['generic', 'demo-campus'], description: 'Template preset name (generic or demo-campus)' },
        loop: { type: 'string', description: 'Agent loops CSV: codex,claude,vscode,opencode,copilot,none' },
        skipInstall: { type: 'boolean', description: 'Skip npm install during bootstrap' },
        skipBrowser: { type: 'boolean', description: 'Skip Playwright Chromium install check' },
        dryRun: { type: 'boolean', description: 'Preview inferred runtime configuration without mutating disk' },
        force: { type: 'boolean', description: 'Overwrite existing aitest.runtime.json when regenerating config' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
        ...ASYNC_JOB_PROPS,
      },
      required: ['target'],
      additionalProperties: false,
    },
    dataProps: {
      qaDir: { type: 'string' },
      runtimeConfigPath: { type: 'string' },
      baseURL: { type: ['string', 'null'] },
      serverReachable: { type: 'boolean' },
    },
    isReadOnly: (args) => Boolean(args.dryRun),
    buildCliArgs: (args, target, lang) => {
      const a = ['bootstrap', '--json', `--lang=${lang}`];
      pushOpt(a, '--target', target);
      pushOpt(a, '--qa-dir', args.qaDir);
      pushOpt(a, '--base-url', args.baseUrl);
      pushOpt(a, '--health-path', args.healthPath);
      pushOpt(a, '--port', args.port);
      pushOpt(a, '--preset', args.preset);
      pushOpt(a, '--loop', args.loop);
      pushBool(a, '--skip-install', args.skipInstall);
      pushBool(a, '--skip-browser', args.skipBrowser);
      pushBool(a, '--dry-run', args.dryRun);
      pushBool(a, '--force', args.force);
      return a;
    },
    nextActions: () => [
      'Call aitest_explore(target) to map live ARIA trees and infer API schemas in knowledge/api-schemas.json.',
      'Call aitest_verify_change(target, mode="impact") to run verification.',
    ],
  },
  {
    name: 'aitest_explore',
    category: 'discovery',
    title: 'Zero-to-One Default-Deny Read-Only Explorer',
    description:
      'Use when exploring a running web application from zero knowledge to discover pages, ARIA locators, and API JSON schemas. Default-denies non-GET/HEAD requests and writes redacted specs/pages/*.md & knowledge/api-schemas.json unless dryRun=true.',
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
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        baseUrl: { type: 'string', description: 'Allowlisted staging or local base URL' },
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
        noSyncImpact: { type: 'boolean', description: 'Skip synchronizing inferred route impact mappings' },
        dryRun: { type: 'boolean', description: 'Explore in memory without writing local files' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
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
      'Read aitest://project/{target}/system-overview, specs/pages/*.md, and knowledge/api-schemas.json.',
      'Author REQ-xxx specs and Playwright tests extending fixtures/base.ts.',
    ],
  },
  {
    name: 'aitest_map_sync',
    category: 'discovery',
    title: 'Sync Convergent Living Code Map v4',
    description:
      'Use when synchronizing the codebase topology and auto-generated impact map after routes, controllers, or specs change. Writes knowledge/code-map.json, SYSTEM_MAP.md, and knowledge/impact-map.auto.json.',
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
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        force: { type: 'boolean', description: 'Force rewrite of code-map.json and SYSTEM_MAP.md even if unchanged' },
        noSyncImpact: { type: 'boolean', description: 'Skip auto-updating impact-map.auto.json suggestions' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
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
      pushBool(a, '--force', args.force);
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
      'Use when configuring or auditing external pinned MCP integrations. Lists 7-pillar presets, writes .mcp.json/.codex/config.toml, or verifies descriptor hashes against .aitest/mcp.lock.',
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
        action: { type: 'string', enum: ['presets', 'add', 'doctor'], description: 'MCP Hub sub-action (presets | add | doctor)' },
        target: { type: 'string', description: 'Target repository path (required for add and doctor)' },
        profile: {
          type: 'string',
          enum: ['minimal', 'observability', 'data-verify', 'perf', 'full-link'],
          description: 'Preset MCP bundle profile to configure',
        },
        servers: { type: 'string', description: 'Comma-separated preset server names' },
        lock: { type: 'boolean', description: 'Write .aitest/mcp.lock descriptor hashes during doctor' },
        dryRun: { type: 'boolean', description: 'Preview MCP config changes without writing files' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    dataProps: {},
    skipWorkspaceBoundary: (args) => args.action === 'presets',
    execute: executeMcpHubReadOnlyFastPath,
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
      'Use when installing portable ai-test-workbench Agent Skill documentation into qa/skills/, .codex/skills/, .claude/skills/, .agents/skills/, .gemini/skills/, or .github/skills/.',
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
        client: {
          type: 'string',
          enum: ['qa', 'codex', 'claude', 'agents', 'gemini', 'copilot'],
          description: 'Target agent client skill directory (default: qa)',
        },
        force: { type: 'boolean', description: 'Overwrite existing installed SKILL files cleanly' },
        dryRun: { type: 'boolean', description: 'Preview skill copy plan without modifying disk' },
        qaDir: { type: 'string', description: 'Optional QA subdirectory name or path' },
        lang: { type: 'string', enum: ['zh', 'en'], description: 'Output language code (zh or en)' },
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
