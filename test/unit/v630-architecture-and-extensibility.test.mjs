import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import * as appFacade from '../../src/app/index.mjs';
import {
  createRoutePatternMatcher,
  indexRepositorySource,
  listCodeMapAdapters,
  matchRuntimeRouteToPattern,
  mergeLivingCodeMap,
  registerCodeMapAdapter,
  unregisterCodeMapAdapter,
} from '../../src/codemap.mjs';
import { inferRuntimeConfigForRepo } from '../../src/bootstrap.mjs';
import { runCli } from '../../src/cli.mjs';
import { loadWorkbenchConfig, validateAitestConfigObject } from '../../src/core/config.mjs';
import { compileGlob } from '../../src/core/glob.mjs';
import { REPO_ROOT } from '../../src/core/version.mjs';
import {
  STACK_DESCRIPTORS,
  detectPackageManager,
  detectProjectStack,
  registerStackDescriptor,
  unregisterStackDescriptor,
} from '../../src/init.mjs';
import {
  clearGitRootCache,
  evaluateDiffRules,
  resolveDefaultDiffBase,
  resolveGitHeadAndTreeSha,
  resolveGitHeadSha,
  resolveGitRoot,
  resolveGitTreeSha,
} from '../../src/kernel/gate-kernel.mjs';
import { evaluateTargetSafety } from '../../src/kernel/target-guard.mjs';
import { readJsonlTail, readLedgerHistory } from '../../src/ledger.mjs';
import { handleMcpJsonRpcMessage } from '../../src/mcp-server.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function walkMjs(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkMjs(full, acc);
    else if (entry.isFile() && entry.name.endsWith('.mjs')) acc.push(full);
  }
  return acc;
}

test('v6.3.0 Round 2 WU-A: resolveGitRoot memoizes positives without stale negatives, batches for-each-ref, and resolves HEAD+tree in one call', () => {
  const tmpDir = makeTempDir('aitest-r2-git-');
  try {
    clearGitRootCache();
    // 1. Before git init -> null (and MUST NOT cache null!)
    assert.equal(resolveGitRoot(tmpDir), null);
    assert.equal(resolveDefaultDiffBase(tmpDir).strategy, 'no-git');
    assert.deepEqual(resolveGitHeadAndTreeSha(tmpDir), { headSha: 'nogit', treeSha: null });

    // 2. Initialize git immediately -> MUST resolve immediately with zero stale negative!
    execFileSync('git', ['init', '-b', 'main'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tmpDir, stdio: 'ignore' });

    const root1 = resolveGitRoot(tmpDir);
    assert.ok(root1, 'resolveGitRoot must immediately detect newly initialized repo without stale null cache');
    const root2 = resolveGitRoot(tmpDir);
    assert.equal(root2, root1);

    // Unborn HEAD
    assert.equal(resolveDefaultDiffBase(tmpDir).strategy, 'unborn-head');

    // Initial commit
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v1\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpDir, stdio: 'ignore' });
    assert.equal(resolveDefaultDiffBase(tmpDir).strategy, 'initial-commit-head');

    // Second commit on main -> clean tree resolves head-parent-clean-tree
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v2\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'second'], { cwd: tmpDir, stdio: 'ignore' });
    assert.equal(resolveDefaultDiffBase(tmpDir).strategy, 'head-parent-clean-tree');

    // Dirty worktree on main -> dirty-worktree-vs-head
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'v3-dirty\n', 'utf8');
    assert.equal(resolveDefaultDiffBase(tmpDir).strategy, 'dirty-worktree-vs-head');
    execFileSync('git', ['checkout', '--', 'a.txt'], { cwd: tmpDir, stdio: 'ignore' });

    // Feature branch diverged from main -> batched for-each-ref resolves merge-base(main)
    execFileSync('git', ['checkout', '-b', 'feat/test'], { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'feat.txt'), 'feat\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: tmpDir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'feat'], { cwd: tmpDir, stdio: 'ignore' });
    const branchBase = resolveDefaultDiffBase(tmpDir);
    assert.equal(branchBase.strategy, 'merge-base(main)');
    assert.ok(branchBase.sha && /^[0-9a-f]{40}$/i.test(branchBase.sha));

    // Explicit & invalid refs
    assert.equal(resolveDefaultDiffBase(tmpDir, 'HEAD~1').strategy, 'explicit');
    assert.equal(resolveDefaultDiffBase(tmpDir, 'nonexistent-ref-xyz').strategy, 'invalid-ref');

    // Single-spawn resolveGitHeadAndTreeSha matches individual helpers
    const combined = resolveGitHeadAndTreeSha(tmpDir);
    assert.equal(combined.headSha, resolveGitHeadSha(tmpDir));
    assert.equal(combined.treeSha, resolveGitTreeSha(tmpDir));
    assert.match(combined.headSha, /^[0-9a-f]{40}$/i);
    assert.match(combined.treeSha || '', /^[0-9a-f]{40}$/i);

    // Bounded glob cache returns identical RegExp instances safely
    const reA = compileGlob('support/**/*.mjs');
    const reB = compileGlob('support/**/*.mjs');
    assert.equal(reA, reB);
    assert.equal(reA.test('support/gate/git-utils.mjs'), true);
  } finally {
    clearGitRootCache();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('v6.3.0 Round 2 WU-A: readJsonlTail & readLedgerHistory handle 5000+ multi-byte UTF-8 lines across 64KB chunks in < 25ms', () => {
  const qaDir = makeTempDir('aitest-r2-jsonl-');
  try {
    const runsDir = path.join(qaDir, '.aitest', 'runs');
    fs.mkdirSync(runsDir, { recursive: true });
    const indexPath = path.join(runsDir, 'index.jsonl');

    // Edge cases: missing & zero limit
    assert.deepEqual(readJsonlTail(indexPath, 30), []);
    assert.deepEqual(readJsonlTail(indexPath, 0), []);

    // Generate 5,000 JSONL lines (~600KB+) containing multi-byte UTF-8 CJK + emoji characters across 64KB boundaries
    const lines = [];
    for (let i = 1; i <= 5000; i += 1) {
      if (i === 4985) {
        lines.push('{malformed-json-line');
        continue;
      }
      lines.push(
        JSON.stringify({
          runId: `RUN_${String(i).padStart(5, '0')}`,
          seq: i,
          note: `测试运行记录_第${i}次_🚀_padding_${'x'.repeat(60)}`,
          exitCode: i % 10 === 0 ? 1 : 0,
        })
      );
    }
    fs.writeFileSync(indexPath, lines.join('\n') + '\n', 'utf8');
    const stat = fs.statSync(indexPath);
    assert.ok(stat.size > 500_000, `Expected > 500KB index.jsonl, got ${stat.size} bytes`);

    // Measure O(limit) tail read latency
    const t0 = performance.now();
    const tail30 = readLedgerHistory(qaDir, 30);
    const elapsedMs = performance.now() - t0;

    // 1 malformed line inside the last 30 lines is skipped -> 29 valid objects ending at seq 5000
    assert.equal(tail30.length, 29);
    assert.equal(tail30[0].seq, 4971);
    assert.equal(tail30[tail30.length - 1].seq, 5000);
    for (const row of tail30) {
      assert.equal(row.note.includes('\uFFFD'), false, 'Multi-byte UTF-8 characters must never split across 64KB chunk boundaries');
      assert.match(row.note, /^测试运行记录_第\d+次_🚀_/);
    }
    assert.ok(elapsedMs < 25, `Expected O(limit) readLedgerHistory < 25ms on 5000-line JSONL, got ${elapsedMs.toFixed(2)}ms`);

    // Verify exact tail of clean last 10 lines
    const tail10 = readJsonlTail(indexPath, 10);
    assert.equal(tail10.length, 10);
    assert.equal(tail10[0].seq, 4991);
    assert.equal(tail10[9].seq, 5000);
  } finally {
    fs.rmSync(qaDir, { recursive: true, force: true });
  }
});

test('v6.3.0 Round 2 WU-B: pluggable CodeMap adapters (SvelteKit, Astro, Go, Drizzle) & linear O(N) mergeLivingCodeMap scaling', () => {
  const repoDir = makeTempDir('aitest-r2-codemap-');
  const customFeId = 'test-custom-fe';
  const customBeId = 'test-custom-be';
  try {
    // Built-in frameworks: SvelteKit, Astro, Go (Gin + net/http Go 1.22), Drizzle ORM, Hono/api.*
    fs.mkdirSync(path.join(repoDir, 'src', 'routes', '(marketing)', 'blog', '[slug]'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'src', 'routes', 'docs', '[[...rest]]'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'src', 'routes', 'api', 'posts', '[id]'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'src', 'pages', 'guides'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'src', 'db'), { recursive: true });
    fs.mkdirSync(path.join(repoDir, 'server'), { recursive: true });

    fs.writeFileSync(
      path.join(repoDir, 'src', 'routes', '(marketing)', 'blog', '[slug]', '+page.svelte'),
      '<script>fetch("/api/posts/42");</script><h1>Blog</h1>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'routes', 'docs', '[[...rest]]', '+page.svelte'),
      '<h1>Docs</h1>',
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'src', 'routes', 'api', 'posts', '[id]', '+server.ts'),
      'export function GET() { return new Response("ok"); }',
      'utf8'
    );
    fs.writeFileSync(path.join(repoDir, 'src', 'pages', 'guides', '[id].astro'), '<h1>Guide</h1>', 'utf8');
    fs.writeFileSync(
      path.join(repoDir, 'src', 'db', 'schema.ts'),
      `export const invoices = pgTable('invoices', {}); export const audits = sqliteTable('audit_logs', {});`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'server', 'routes.go'),
      `package main
       func mount() {
         r.GET("/api/orders/:id", getOrder)
         http.HandleFunc("POST /api/invoices/{invoiceId}", createInvoice)
         mux.HandleFunc("/api/health", healthCheck)
       }`,
      'utf8'
    );
    fs.writeFileSync(
      path.join(repoDir, 'server', 'hono.ts'),
      `api.post('/api/webhooks', () => {});`,
      'utf8'
    );

    // Custom pluggable frontend & backend adapters
    registerCodeMapAdapter('frontend', {
      id: customFeId,
      description: 'Custom test route extractor',
      extract({ relFile, text }) {
        if (relFile.endsWith('.astro') && text.includes('Guide')) {
          return { routes: [{ route: '/custom-guide-alias', file: relFile, kind: 'custom-fe' }] };
        }
        return null;
      },
    });
    registerCodeMapAdapter('backend', {
      id: customBeId,
      description: 'Custom test entity extractor',
      extract({ relFile, text }) {
        if (text.includes('createInvoice')) {
          return { entities: [{ table: 'custom_billing', file: relFile, source: 'custom-orm' }] };
        }
        return null;
      },
    });

    const adapterList = listCodeMapAdapters();
    assert.ok(adapterList.frontend.some((a) => a.id === customFeId));
    assert.ok(adapterList.backend.some((a) => a.id === customBeId));

    const idx = indexRepositorySource(repoDir);
    assert.ok(idx.frontendRoutes.some((r) => r.route === '/blog/:slug' && r.kind === 'sveltekit'));
    assert.ok(idx.frontendRoutes.some((r) => r.route === '/docs/:rest*' && r.kind === 'sveltekit'));
    assert.ok(idx.frontendRoutes.some((r) => r.route === '/guides/:id' && r.kind === 'astro-pages'));
    assert.ok(idx.frontendRoutes.some((r) => r.route === '/custom-guide-alias' && r.kind === 'custom-fe'));

    assert.ok(idx.backendEndpoints.some((e) => e.path === '/api/posts/:id' && e.framework === 'sveltekit-api'));
    assert.ok(idx.backendEndpoints.some((e) => e.path === '/api/orders/:id' && e.method === 'GET' && e.framework === 'go'));
    assert.ok(idx.backendEndpoints.some((e) => e.path === '/api/invoices/:invoiceId' && e.method === 'POST' && e.framework === 'go-http'));
    assert.ok(idx.backendEndpoints.some((e) => e.path === '/api/health' && e.method === 'ANY' && e.framework === 'go-http'));
    assert.ok(idx.backendEndpoints.some((e) => e.path === '/api/webhooks' && e.method === 'POST'));

    assert.ok(idx.dbEntities.some((d) => d.table === 'invoices' && d.source === 'drizzle'));
    assert.ok(idx.dbEntities.some((d) => d.table === 'audit_logs' && d.source === 'drizzle'));
    assert.ok(idx.dbEntities.some((d) => d.table === 'custom_billing' && d.source === 'custom-orm'));

    // Route pattern matcher & linear O(N) scale test: 500 routes x 200 specs x 200 endpoints
    const patterns = ['/users/:id', '/docs/:rest*', '/courses/:courseId/lessons/:lessonId'];
    const compiled = createRoutePatternMatcher(patterns);
    assert.equal(compiled('/users/42'), '/users/:id');
    assert.equal(compiled('/docs/a/b/c'), '/docs/:rest*');
    assert.equal(matchRuntimeRouteToPattern('/courses/c1/lessons/l9', patterns), '/courses/:courseId/lessons/:lessonId');

    const frontendRoutes = [];
    const frontendApiCalls = [];
    const backendEndpoints = [];
    const dbEntities = [];
    const backendFileTexts = {};
    for (let i = 0; i < 500; i += 1) {
      const file = `src/pages/mod${i}/index.tsx`;
      const route = i % 3 === 0 ? `/mod${i}/:id` : `/mod${i}`;
      frontendRoutes.push({ route, file, kind: 'nextjs-app' });
      const epIdx = i % 200;
      frontendApiCalls.push({ method: 'GET', path: `/api/res${epIdx}/123`, file });
    }
    for (let i = 0; i < 200; i += 1) {
      const bf = `server/ctrl${i}.ts`;
      backendEndpoints.push({ method: 'GET', path: `/api/res${i}/:id`, file: bf, framework: 'express/fastify' });
      backendFileTexts[bf] = `export function handle() { return db.select(entity_${i % 40}); }`;
    }
    for (let i = 0; i < 40; i += 1) {
      dbEntities.push({ table: `entity_${i}`, file: `src/db/entity_${i}.ts`, source: 'drizzle' });
    }
    const specIndex = [];
    for (let i = 0; i < 200; i += 1) {
      specIndex.push({
        specFile: `tests/e2e/mod${i}.spec.ts`,
        uiRoutes: [i % 3 === 0 ? `/mod${i}/item-99` : `/mod${i}`],
        apiPaths: [`/api/res${i}/123`],
      });
    }

    const t0 = performance.now();
    const merged = mergeLivingCodeMap(
      {},
      {
        sourceIndex: {
          fileCount: 740,
          truncated: false,
          warnings: [],
          frontendRoutes,
          brokenRouteImports: [],
          frontendApiCalls,
          backendEndpoints,
          dbEntities,
          backendFileTexts,
        },
        specIndex,
      }
    );
    const elapsedMs = performance.now() - t0;

    assert.equal(merged.coverage.totalRoutes, 500);
    assert.ok(merged.coverage.coveredRoutes >= 200);
    assert.ok(merged.routes['/mod0/:id'].coveringSpecs.includes('tests/e2e/mod0.spec.ts'));
    assert.ok(merged.routes['/mod0/:id'].linkedBackendFiles.includes('server/ctrl0.ts'));
    assert.ok(merged.routes['/mod0/:id'].linkedDbTables.includes('entity_0'));
    assert.ok(elapsedMs < 150, `Expected linear O(N) mergeLivingCodeMap < 150ms for 500x200x200, took ${elapsedMs.toFixed(1)}ms`);
  } finally {
    unregisterCodeMapAdapter('frontend', customFeId);
    unregisterCodeMapAdapter('backend', customBeId);
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('v6.3.0 Round 2 WU-C: declarative package-manager & stack descriptor registries + runtime inference', () => {
  const dirs = [];
  const mk = (name) => {
    const d = makeTempDir(`aitest-r2-stack-${name}-`);
    dirs.push(d);
    return d;
  };
  const customStackId = 'test-custom-elixir';

  try {
    // 1. Package manager detection (packageManager field + lockfiles + npm fallback)
    const pnpmDir = mk('pnpm');
    fs.writeFileSync(
      path.join(pnpmDir, 'package.json'),
      JSON.stringify({ packageManager: 'pnpm@9.12.0', dependencies: { '@sveltejs/kit': '^2.0.0' }, scripts: { dev: 'vite dev' } }),
      'utf8'
    );
    const pnpm = detectPackageManager(pnpmDir);
    assert.equal(pnpm.name, 'pnpm');
    assert.equal(pnpm.runScript('dev'), 'pnpm run dev');
    assert.equal(pnpm.runScript('start'), 'pnpm start');
    const skRuntime = inferRuntimeConfigForRepo(pnpmDir);
    assert.equal(skRuntime.stack, 'SvelteKit');
    assert.equal(skRuntime.webServer?.command, 'pnpm run dev');
    assert.equal(skRuntime.webServer?.port, 5173);

    const yarnDir = mk('yarn');
    fs.writeFileSync(path.join(yarnDir, 'yarn.lock'), '', 'utf8');
    fs.writeFileSync(
      path.join(yarnDir, 'package.json'),
      JSON.stringify({ dependencies: { astro: '^4.0.0' }, scripts: { dev: 'astro dev' } }),
      'utf8'
    );
    const yarn = detectPackageManager(yarnDir);
    assert.equal(yarn.name, 'yarn');
    assert.equal(yarn.runScript('dev'), 'yarn dev');
    assert.equal(yarn.runScript('start'), 'yarn start');
    const astroRuntime = inferRuntimeConfigForRepo(yarnDir);
    assert.equal(astroRuntime.stack, 'Astro');
    assert.equal(astroRuntime.webServer?.command, 'yarn dev');
    assert.equal(astroRuntime.webServer?.port, 4321);

    const bunDir = mk('bun');
    fs.writeFileSync(path.join(bunDir, 'bun.lock'), '', 'utf8');
    const bun = detectPackageManager(bunDir);
    assert.equal(bun.name, 'bun');
    assert.equal(bun.runScript('dev'), 'bun run dev');
    assert.equal(bun.runScript('start'), 'bun run start');

    const npmDir = mk('npm');
    const npm = detectPackageManager(npmDir);
    assert.equal(npm.name, 'npm');
    assert.equal(npm.runScript('dev'), 'npm run dev');
    assert.equal(npm.runScript('start'), 'npm start');

    // 2. Python/FastAPI & Rust built-in stack descriptors
    const pyDir = mk('fastapi');
    fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[project]\ndependencies = ["fastapi", "uvicorn"]\n', 'utf8');
    const pyRuntime = inferRuntimeConfigForRepo(pyDir);
    assert.equal(pyRuntime.stack, 'Python/FastAPI');
    assert.equal(pyRuntime.healthPath, '/health');
    assert.equal(pyRuntime.webServer?.port, 8000);

    const rustDir = mk('rust');
    fs.writeFileSync(path.join(rustDir, 'Cargo.toml'), '[package]\nname = "demo"\n', 'utf8');
    const rustRuntime = inferRuntimeConfigForRepo(rustDir);
    assert.equal(rustRuntime.stack, 'Rust');
    assert.equal(rustRuntime.webServer?.command, 'cargo run');
    assert.equal(rustRuntime.webServer?.port, 3000);

    // 3. Pluggable registerStackDescriptor / unregisterStackDescriptor
    const customDir = mk('elixir');
    fs.writeFileSync(path.join(customDir, 'mix.exs'), 'defmodule App.MixProject do end', 'utf8');
    registerStackDescriptor(
      {
        id: customStackId,
        label: 'Elixir/Phoenix',
        match: (ctx) => ctx.hasFile('mix.exs'),
        defaultPort: 4000,
        healthPath: '/health',
        defaultCommand: 'mix phx.server',
      },
      { prepend: true }
    );
    assert.ok(STACK_DESCRIPTORS.some((d) => d.id === customStackId));
    assert.deepEqual(detectProjectStack(customDir), ['Elixir/Phoenix']);
    const phxRuntime = inferRuntimeConfigForRepo(customDir);
    assert.equal(phxRuntime.webServer?.command, 'mix phx.server');
    assert.equal(phxRuntime.webServer?.port, 4000);
  } finally {
    unregisterStackDescriptor(customStackId);
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('v6.3.0 Round 2 WU-D: programmatic extraRules, AITEST-G101..G117 config validation & TEST_EGRESS_* env parity', () => {
  // 1. Programmatic extraRules in evaluateDiffRules
  const customRule = {
    code: 'CUSTOM-901',
    name: 'no-custom-ban',
    description: 'Custom programmatic diff rule',
    defaultEnabled: true,
    evaluate(ctx) {
      return [{ code: 'CUSTOM-901', severity: 'error', file: ctx.file || 'a.spec.ts', message: 'custom rule fired' }];
    },
  };
  const customOut = evaluateDiffRules({ file: 'a.spec.ts', baseSum: null, headSum: null, extraRules: [customRule] });
  assert.equal(customOut.ok, false);
  assert.ok(customOut.findings.some((f) => f.code === 'CUSTOM-901'));

  const disabledCustom = evaluateDiffRules({
    file: 'a.spec.ts',
    baseSum: null,
    headSum: null,
    rulesConfig: { 'CUSTOM-901': false },
    extraRules: [customRule],
  });
  assert.equal(disabledCustom.ok, true);

  // 2. Config validation accepts AITEST-G101..G118 and rejects G119+
  assert.equal(validateAitestConfigObject({ rules: { 'AITEST-G101': true, 'AITEST-G116': false, 'AITEST-G117': { enabled: true }, 'AITEST-G118': true } }).ok, true);
  const badRule = validateAitestConfigObject({ rules: { 'AITEST-G119': true } });
  assert.equal(badRule.ok, false);
  assert.match(badRule.errors[0], /AITEST-G101\.\.G118/);

  // 3. TEST_EGRESS_EXTRA_HOSTS & TEST_EGRESS_ALLOW_HOSTS parity
  const tmpQa = makeTempDir('aitest-r2-egress-');
  try {
    const cfgExtra = loadWorkbenchConfig({ qaDir: tmpQa, env: { TEST_EGRESS_EXTRA_HOSTS: 'cdn.example.test,assets.example.test' } });
    assert.deepEqual(cfgExtra.target.extraAllowedHosts, ['cdn.example.test', 'assets.example.test']);
    const cfgAllow = loadWorkbenchConfig({ qaDir: tmpQa, env: { TEST_EGRESS_ALLOW_HOSTS: 'legacy.example.test' } });
    assert.deepEqual(cfgAllow.target.extraAllowedHosts, ['legacy.example.test']);

    const tgExtra = evaluateTargetSafety({ TEST_ENV: 'local', TEST_EGRESS_EXTRA_HOSTS: 'cdn.example.test' });
    assert.deepEqual(tgExtra.extraEgressHosts, ['cdn.example.test']);
    const tgAllow = evaluateTargetSafety({ TEST_ENV: 'local', TEST_EGRESS_ALLOW_HOSTS: 'legacy.example.test' });
    assert.deepEqual(tgAllow.extraEgressHosts, ['legacy.example.test']);
  } finally {
    fs.rmSync(tmpQa, { recursive: true, force: true });
  }
});

test('v6.3.0 Round 2 WU-C & WU-D: MCP read-only fast paths (doctor, mcp_hub doctor, diagnose dryRun), outputSchema & ./app exports', async () => {
  const tmpRepo = makeTempDir('aitest-r2-mcp-');
  const outsideDir = makeTempDir('aitest-r2-outside-');
  try {
    await runCli(['init', '--name', 'r2-mcp', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');
    const ctx = { workspaceRoots: [tmpRepo] };

    // 1. MCP 2025-11-25 outputSchema matches wrapEnvelope fields
    const listReply = await handleMcpJsonRpcMessage({ jsonrpc: '2.0', id: 10, method: 'tools/list', params: {} }, ctx);
    const doctorDef = listReply.result.tools.find((t) => t.name === 'aitest_doctor');
    assert.ok(doctorDef.outputSchema.properties.schemaVersion);
    assert.ok(doctorDef.outputSchema.properties.outcome);
    assert.ok(doctorDef.outputSchema.properties.recoverable);
    assert.ok(doctorDef.outputSchema.properties.blockerKind);
    assert.ok(doctorDef.outputSchema.properties.recoverySteps);

    // 2. Fast-path aitest_doctor
    const docReply = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 11, method: 'tools/call', params: { name: 'aitest_doctor', arguments: { target: tmpRepo, lang: 'en' } } },
      ctx
    );
    assert.equal(docReply.result.isError, false);
    assert.equal(docReply.result.structuredContent.ok, true);
    assert.ok(Array.isArray(docReply.result.structuredContent.data.checks));

    // Workspace boundary still blocks outside targets BEFORE fast path
    const docBlocked = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'aitest_doctor', arguments: { target: outsideDir } } },
      ctx
    );
    assert.equal(docBlocked.result.isError, true);
    assert.match(docBlocked.result.structuredContent.summary, /Workspace Boundary Blocked/);

    // 3. Fast-path aitest_mcp_hub(action="doctor") — clean, malformed JSON -> exitCode 1, and boundary blocked
    const mcpOk = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 13, method: 'tools/call', params: { name: 'aitest_mcp_hub', arguments: { action: 'doctor', target: tmpRepo } } },
      ctx
    );
    assert.equal(mcpOk.result.isError, false);
    assert.equal(mcpOk.result.structuredContent.exitCode, 0);

    fs.writeFileSync(path.join(qaDir, '.mcp.json'), '{bad json', 'utf8');
    const mcpBadJson = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 14, method: 'tools/call', params: { name: 'aitest_mcp_hub', arguments: { action: 'doctor', target: tmpRepo } } },
      ctx
    );
    assert.equal(mcpBadJson.result.isError, true);
    assert.equal(mcpBadJson.result.structuredContent.exitCode, 1);
    assert.equal(mcpBadJson.result.structuredContent.outcome, 'fail');

    // 4. Fast-path aitest_diagnose(dryRun=true) — missing results -> exitCode 1; valid results -> redacts secrets & writes NO file
    const diagMissing = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 15, method: 'tools/call', params: { name: 'aitest_diagnose', arguments: { target: tmpRepo, dryRun: true } } },
      ctx
    );
    assert.equal(diagMissing.result.isError, true);
    assert.equal(diagMissing.result.structuredContent.exitCode, 1);

    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(qaDir, 'reports', 'results.json'),
      JSON.stringify({
        suites: [
          {
            file: 'tests/e2e/auth.spec.ts',
            specs: [
              {
                title: 'login check',
                file: 'tests/e2e/auth.spec.ts',
                line: 12,
                tests: [
                  {
                    projectName: 'e2e',
                    status: 'unexpected',
                    results: [{ status: 'failed', error: { message: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig1234567890 failed' } }],
                  },
                ],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    const diagDry = await handleMcpJsonRpcMessage(
      { jsonrpc: '2.0', id: 16, method: 'tools/call', params: { name: 'aitest_diagnose', arguments: { target: tmpRepo, dryRun: true } } },
      ctx
    );
    assert.equal(diagDry.result.isError, false);
    assert.equal(diagDry.result.structuredContent.data.failureCount, 1);
    assert.equal(diagDry.result.structuredContent.data.outputPath, null);
    assert.equal(fs.existsSync(path.join(qaDir, 'reports', 'ai-diagnostics.md')), false, 'dryRun must not write ai-diagnostics.md');
    assert.equal(
      JSON.stringify(diagDry.result.structuredContent).includes('eyJhbGciOiJIUzI1NiJ9'),
      false,
      'Fast-path diagnose output must be redacted'
    );

    // 5. ./app package export & public facade surface
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.exports['./app'], './src/app/index.mjs');
    for (const exportName of [
      'collectDoctorReport',
      'readJsonlTail',
      'createRoutePatternMatcher',
      'registerCodeMapAdapter',
      'unregisterCodeMapAdapter',
      'listCodeMapAdapters',
      'detectPackageManager',
      'registerStackDescriptor',
      'unregisterStackDescriptor',
      'STACK_DESCRIPTORS',
      'clearGitRootCache',
      'resolveGitHeadAndTreeSha',
    ]) {
      assert.ok(exportName in appFacade, `Missing ./app facade export: ${exportName}`);
    }
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('v6.3.0 Round 2 WU-E: Code elegance guard — every module under src/**/*.mjs stays <= 450 LOC', () => {
  const srcFiles = walkMjs(path.join(REPO_ROOT, 'src'));
  assert.ok(srcFiles.length >= 40);
  const violations = [];
  for (const file of srcFiles) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
    if (lines > 450) {
      violations.push(`${rel} (${lines} lines)`);
    }
  }
  assert.deepEqual(violations, [], `Modules exceeding 450 LOC elegance ceiling: ${violations.join(', ')}`);
});
