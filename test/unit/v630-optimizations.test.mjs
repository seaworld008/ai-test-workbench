import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runCli } from '../../src/cli.mjs';
import { resolvePairedBooleanFlag } from '../../src/cli/opts.mjs';
import { DEFAULT_MAX_SCAN_FILES } from '../../src/codemap/adapters.mjs';
import { validateAitestConfigObject } from '../../src/core/config.mjs';
import { redactSecrets } from '../../src/core/redact.mjs';
import { classifyFailureRegressionHistory, generateDiagnosticsMarkdown } from '../../src/diagnose.mjs';
import { runDoctor } from '../../src/doctor.mjs';
import { detectUrlQueryAnomalies, routeToSafeSlug, sanitizeUntrustedDomText } from '../../src/explore/safety.mjs';
import { buildReverseImportGraph, collectGitChangedFiles, MAX_GRAPH_FILES } from '../../src/impact/graph.mjs';
import { stripJsCommentsPreserveStrings } from '../../src/impact/scanner.mjs';
import { analyzeSourceAst, compareSpecSourcesAst } from '../../src/kernel/gate/ast-analyzer.mjs';
import { canonicalFsPath, computeWorkspaceInputHash } from '../../src/kernel/gate-kernel.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';
import { handleMcpJsonRpcMessage } from '../../src/mcp-server.mjs';
import { isPathWithinRoot } from '../../src/mcp/security.mjs';
import { collectReportArtifacts, runReportCommand } from '../../src/report.mjs';
import { buildRequirementTraceMatrix, renderTraceMatrixMarkdown } from '../../src/traceability.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makePassingAndFailingResults(testsSpec) {
  return {
    suites: [
      {
        file: testsSpec.file,
        specs: testsSpec.cases.map((c, idx) => ({
          title: c.title,
          file: testsSpec.file,
          line: idx * 10 + 5,
          tests: [
            {
              projectName: 'e2e',
              status: c.status,
              results:
                c.status === 'unexpected'
                  ? [{ status: 'failed', error: { message: c.error || 'Expected: "ok"\nReceived: "bad"' } }]
                  : c.status === 'flaky'
                    ? [
                        { status: 'failed', error: { message: 'Timeout 15000ms exceeded' } },
                        { status: 'passed', duration: 100 },
                      ]
                    : [{ status: 'passed', duration: 50 }],
            },
          ],
        })),
      },
    ],
  };
}

test('v6.3.0 WU-1: doctor parallel probes preserve deterministic check ordering', async () => {
  const origLog = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(' '));
  try {
    const code = await runDoctor({ json: true, lang: 'en' });
    assert.equal(code, 0);
    const parsed = JSON.parse(lines.join('\n'));
    assert.equal(parsed.ok, true);
    const names = parsed.data.checks.map((c) => c.name);
    assert.deepEqual(names.slice(0, 10), [
      'OS & Arch',
      'Node.js',
      'npm',
      'Git',
      'Codex CLI',
      'Claude Code',
      'Docker',
      'Proxy Env',
      'Disk & Write Access',
      'Template @playwright/test',
    ]);
  } finally {
    console.log = origLog;
  }
});

test('v6.3.0 WU-1: impact graph strips comments, resolves O(1) indexed imports (10k budget), and parallelizes git queries', async () => {
  assert.equal(MAX_GRAPH_FILES, 10000);
  assert.equal(DEFAULT_MAX_SCAN_FILES, 10000);

  const stripped = stripJsCommentsPreserveStrings(`
    // import dead from './dead';
    /* export { nope } from './nope'; */
    const url = "http://localhost:3000/api//v1";
    const re = /[/*]/g;
    import real from './real';
  `);
  assert.equal(stripped.includes('./dead'), false);
  assert.equal(stripped.includes('./nope'), false);
  assert.equal(stripped.includes('http://localhost:3000/api//v1'), true);
  assert.equal(stripped.includes('./real'), true);

  const tmpRepo = makeTempDir('aitest-v630-graph-');
  const aliasRepo = `${tmpRepo}-alias`;
  try {
    fs.mkdirSync(path.join(tmpRepo, 'src', 'lib'), { recursive: true });
    fs.mkdirSync(path.join(tmpRepo, 'src', 'pages'), { recursive: true });
    fs.writeFileSync(
      path.join(tmpRepo, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: { '#lib/*': ['src/lib/*'] },
        },
      }),
      'utf8'
    );
    fs.writeFileSync(path.join(tmpRepo, 'src', 'lib', 'active.ts'), 'export const active = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'lib', 'dead.ts'), 'export const dead = 2;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'lib', 'aliased.ts'), 'export const aliased = 3;\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpRepo, 'src', 'pages', 'Home.tsx'),
      [
        "// import { dead } from '../lib/dead';",
        "/* import { dead } from '@/lib/dead'; */",
        "import { active } from '@/lib/active';",
        "import { aliased } from '#lib/aliased.js';",
        "const api = 'http://127.0.0.1:4173/api';",
        'export const v = active + aliased + api.length;',
      ].join('\n'),
      'utf8'
    );

    const graph = buildReverseImportGraph(tmpRepo);
    assert.equal(graph.truncated, false);
    assert.equal(graph.get('src/lib/dead.ts'), undefined, 'Commented-out imports must not create reverse edges');
    assert.equal(graph.get('src/lib/active.ts')?.has('src/pages/Home.tsx'), true);
    assert.equal(graph.get('src/lib/aliased.ts')?.has('src/pages/Home.tsx'), true);

    // Parallel git query check with tracked + untracked file
    execFileSync('git', ['init'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'dev@example.com'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'Dev'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['add', '.'], { cwd: tmpRepo, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: tmpRepo, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpRepo, 'src', 'lib', 'active.ts'), 'export const active = 2;\n', 'utf8');
    fs.writeFileSync(path.join(tmpRepo, 'src', 'lib', 'untracked.ts'), 'export const u = 1;\n', 'utf8');

    const gitInfo = await collectGitChangedFiles(tmpRepo, 'HEAD');
    assert.equal(gitInfo.ok, true);
    assert.equal(gitInfo.validBaseRef, true);
    assert.equal(gitInfo.files.includes('src/lib/active.ts'), true);
    assert.equal(gitInfo.files.includes('src/lib/untracked.ts'), true);

    // Regression: Windows 8.3 short-path / directory junction / macOS symlink alias canonicalization
    fs.symlinkSync(tmpRepo, aliasRepo, process.platform === 'win32' ? 'junction' : 'dir');
    const aliasGraph = buildReverseImportGraph(aliasRepo);
    assert.equal(aliasGraph.get('src/lib/aliased.ts')?.has('src/pages/Home.tsx'), true);

    const aliasGitInfo = await collectGitChangedFiles(aliasRepo, 'HEAD');
    assert.equal(aliasGitInfo.ok, true);
    assert.equal(aliasGitInfo.validBaseRef, true);
    assert.equal(aliasGitInfo.files.includes('src/lib/active.ts'), true);
    assert.equal(aliasGitInfo.files.includes('src/lib/untracked.ts'), true);

    assert.equal(
      computeWorkspaceInputHash(aliasRepo, aliasRepo),
      computeWorkspaceInputHash(tmpRepo, tmpRepo),
      'computeWorkspaceInputHash must match identically between real path and alias/junction path'
    );
    assert.equal(isPathWithinRoot(path.join(aliasRepo, 'src', 'lib', 'active.ts'), tmpRepo), true);
    assert.equal(isPathWithinRoot(path.join(tmpRepo, 'src', 'lib', 'active.ts'), aliasRepo), true);
    assert.equal(
      canonicalFsPath(path.join(aliasRepo, 'src', 'lib', 'nonexistent-future.ts')),
      canonicalFsPath(path.join(tmpRepo, 'src', 'lib', 'nonexistent-future.ts'))
    );
  } finally {
    fs.rmSync(aliasRepo, { recursive: true, force: true });
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('v6.3.0 WU-1 & WU-3: MCP read-only fast paths (aitest_report summary & aitest_impact) honor workspaceRoots and redaction', async () => {
  const tmpRepo = makeTempDir('aitest-v630-mcp-fast-');
  const outsideDir = makeTempDir('aitest-v630-outside-');
  try {
    await runCli(['init', '--name', 'fast-mcp', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    fs.writeFileSync(
      path.join(qaDir, 'reports', 'results.json'),
      JSON.stringify(
        makePassingAndFailingResults({
          file: 'tests/smoke/workbench.spec.ts',
          cases: [{ title: 'REQ-001 health ok', status: 'expected' }],
        })
      ),
      'utf8'
    );

    const ctx = { workspaceRoots: [tmpRepo] };

    // 1. Fast-path aitest_report(view="summary") returns v2 envelope + view="summary" + resultsCounts
    const repSummary = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'aitest_report', arguments: { target: tmpRepo, view: 'summary' } },
      },
      ctx
    );
    assert.equal(repSummary.result.isError, false);
    assert.equal(repSummary.result.structuredContent.schemaVersion, 2);
    assert.equal(repSummary.result.structuredContent.data.view, 'summary');
    assert.equal(repSummary.result.structuredContent.data.resultsCounts.passed, 1);

    // 2. Fast-path aitest_impact computes impact cleanly in-process
    const impReply = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'aitest_impact', arguments: { target: tmpRepo, files: 'qa/tests/smoke/workbench.spec.ts' } },
      },
      ctx
    );
    assert.equal(impReply.result.isError, false);
    assert.equal(impReply.result.structuredContent.outcome, 'pass');
    assert.equal(impReply.result.structuredContent.data.mode, 'targeted');
    assert.deepEqual(impReply.result.structuredContent.data.specs, ['tests/smoke/workbench.spec.ts']);

    // 3. Workspace boundary still hard-blocks outside targets BEFORE fast path runs!
    const blockedImpact = await handleMcpJsonRpcMessage(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'aitest_impact', arguments: { target: outsideDir } },
      },
      ctx
    );
    assert.equal(blockedImpact.result.isError, true);
    assert.match(blockedImpact.result.structuredContent.summary, /Workspace Boundary Blocked/);

    // 4. CLI `report --view summary` succeeds and invalid view exits 64
    const cliSummaryCode = await runReportCommand({ target: tmpRepo, view: 'summary', json: true });
    assert.equal(cliSummaryCode, 0);
    const cliBadView = await runReportCommand({ target: tmpRepo, view: 'nonexistent', json: true });
    assert.equal(cliBadView, 64);

    const collected = collectReportArtifacts(qaDir, { view: 'summary' });
    assert.equal(collected.hasAny, true);
    assert.equal(collected.payload.view, 'summary');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('v6.3.0 WU-2: AITEST-G110 allows strengthening existing if-wrapped assertion while blocking move-into-if cheats', () => {
  // Benign: strengthening an existing expect() inside a pre-existing if-block with conserved unconditional count & strength
  const baseBenign = `
    test('creates api key', async ({ page }) => {
      await page.route('/api/keys', async (route) => {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toEqual({ name: 'ci' });
        }
        await route.continue();
      });
      await expect(page.getByRole('heading')).toHaveText('API Keys');
    });
  `;
  const headBenign = `
    test('creates api key', async ({ page }) => {
      await page.route('/api/keys', async (route) => {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toEqual({ name: 'ci', permissions: ['read'] });
        }
        await route.continue();
      });
      await expect(page.getByRole('heading')).toHaveText('API Keys');
    });
  `;
  const benignRes = compareSpecSourcesAst('tests/e2e/keys.spec.ts', baseBenign, headBenign);
  assert.equal(benignRes.ok, true, `Expected benign existing if-wrap edit to pass, got: ${benignRes.violations.join('; ')}`);

  // Cheat 1: Moving unconditional expect into pre-existing if-block and deleting old conditional expect
  const headMoveCheat = `
    test('creates api key', async ({ page }) => {
      await page.route('/api/keys', async (route) => {
        if (route.request().method() === 'POST') {
          await expect(page.getByRole('heading')).toHaveText('API Keys');
        }
        await route.continue();
      });
    });
  `;
  const moveRes = compareSpecSourcesAst('tests/e2e/keys.spec.ts', baseBenign, headMoveCheat);
  assert.equal(moveRes.ok, false);
  assert.ok(moveRes.findings.some((f) => f.code === 'AITEST-G110'), 'Moving unconditional expect into existing if must trigger G110');

  // Cheat 2: Adding a brand-new expect inside the existing if-block
  const headAddInsideIf = `
    test('creates api key', async ({ page }) => {
      await page.route('/api/keys', async (route) => {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toEqual({ name: 'ci' });
          expect(route.request().headers()['x-role']).toBe('admin');
        }
        await route.continue();
      });
      await expect(page.getByRole('heading')).toHaveText('API Keys');
    });
  `;
  const addRes = compareSpecSourcesAst('tests/e2e/keys.spec.ts', baseBenign, headAddInsideIf);
  assert.equal(addRes.ok, false);
  assert.ok(addRes.findings.some((f) => f.code === 'AITEST-G110'), 'Adding extra conditional expect must trigger G110');

  // Cheat 3: Weakening pre-existing if-wrapped S5 expect to S1 toBeTruthy()
  const headWeakenInsideIf = `
    test('creates api key', async ({ page }) => {
      await page.route('/api/keys', async (route) => {
        if (route.request().method() === 'POST') {
          expect(route.request().postDataJSON()).toBeTruthy();
        }
        await route.continue();
      });
      await expect(page.getByRole('heading')).toHaveText('API Keys');
    });
  `;
  const weakRes = compareSpecSourcesAst('tests/e2e/keys.spec.ts', baseBenign, headWeakenInsideIf);
  assert.equal(weakRes.ok, false);
  assert.ok(weakRes.findings.some((f) => f.code === 'AITEST-G110'), 'Weakening if-wrapped assertion to S1 must trigger G110');
});

test('v6.3.0 WU-2: customMatchers config validation & structured domain matcher consolidation (benign + adversarial)', () => {
  // 1. Config schema validation
  const okCfg = validateAitestConfigObject({ customMatchers: { toHaveResponse: 4, toMatchReceipt: 5 } });
  assert.equal(okCfg.ok, true);
  assert.deepEqual(okCfg.config.customMatchers, { toHaveResponse: 4, toMatchReceipt: 5 });

  const badWeakOverride = validateAitestConfigObject({ customMatchers: { toBeVisible: 5 } });
  assert.equal(badWeakOverride.ok, false);
  const badWeakOverride2 = validateAitestConfigObject({ customMatchers: { toBeDefined: 5, toBeTruthy: 4 } });
  assert.equal(badWeakOverride2.ok, false);
  const badTier = validateAitestConfigObject({ customMatchers: { toHaveResponse: 6 } });
  assert.equal(badTier.ok, false);
  const badKey = validateAitestConfigObject({ customMatchers: { 'bad-name': 4 } });
  assert.equal(badKey.ok, false);

  // 2. Benign consolidation: replacing 3 granular S3 assertions with 1 structured S4 domain matcher in same test block
  const baseConsolidate = `
    test('click tool returns code and snapshot', async () => {
      expect(res).toHaveTextContent('Ran Playwright code');
      expect(res).toHaveTextContent('Page URL: http://127.0.0.1');
      expect(res).toHaveTextContent('heading "Hello"');
    });
  `;
  const headConsolidate = `
    test('click tool returns code and snapshot', async () => {
      expect(res).toHaveResponse({
        code: 'await page.click("button");',
        pageState: \`- Page URL: http://127.0.0.1
- Page Snapshot:
  - heading "Hello"\`,
      });
    });
  `;
  const okConsolidate = compareSpecSourcesAst('tests/e2e/click.spec.ts', baseConsolidate, headConsolidate);
  assert.equal(okConsolidate.ok, true, `Expected structured matcher consolidation to pass, got: ${okConsolidate.violations.join('; ')}`);

  // 3. Governance-locked customMatchers config upgrades tier to S5
  const astCustom5 = analyzeSourceAst(
    'tests/e2e/receipt.spec.ts',
    `test('receipt', async () => { expect(res).toMatchReceipt({ id: 'R1', total: 100 }); });`,
    { customMatchers: { toMatchReceipt: 5 } }
  );
  assert.equal(astCustom5.assertions[0].tier, 5);

  // 4. Adversarial: empty `{}` or 0-arg custom matcher MUST NOT replace stronger assertions!
  const headEmptyObj = `
    test('click tool returns code and snapshot', async () => {
      expect(res).toHaveResponse({});
    });
  `;
  const emptyObjRes = compareSpecSourcesAst('tests/e2e/click.spec.ts', baseConsolidate, headEmptyObj);
  assert.equal(emptyObjRes.ok, false);
  assert.ok(emptyObjRes.findings.some((f) => f.code === 'AITEST-G103'));

  const headZeroArg = `
    test('click tool returns code and snapshot', async () => {
      expect(res).toHaveResponse();
    });
  `;
  const zeroArgRes = compareSpecSourcesAst('tests/e2e/click.spec.ts', baseConsolidate, headZeroArg);
  assert.equal(zeroArgRes.ok, false);
  assert.ok(zeroArgRes.findings.some((f) => f.code === 'AITEST-G103'));

  // 5. Adversarial: S5 exact assertion CANNOT be downgraded to S4 structured custom matcher
  const baseS5 = `test('exact price', async () => { await expect(page.getByTestId('price')).toHaveText('49/50'); });`;
  const headS4 = `test('exact price', async () => { expect(res).toHaveResponse({ a: '1', b: '2' }); });`;
  const downgradeS5 = compareSpecSourcesAst('tests/e2e/price.spec.ts', baseS5, headS4);
  assert.equal(downgradeS5.ok, false);
  assert.ok(downgradeS5.findings.some((f) => f.code === 'AITEST-G103'));

  // 6. Adversarial: structured consolidation in test block 1 CANNOT subsidize deleting assertions in test block 2
  const baseTwoBlocks = `
    test('block 1', async () => {
      expect(res).toHaveTextContent('a');
      expect(res).toHaveTextContent('b');
    });
    test('block 2', async () => {
      expect(res).toHaveTextContent('c');
      expect(res).toHaveTextContent('d');
    });
  `;
  const headCrossBlockCheat = `
    test('block 1', async () => {
      expect(res).toHaveResponse({ a: '1', b: '2', c: '3' });
    });
    test('block 2', async () => {
      expect(res).toHaveTextContent('c');
    });
  `;
  const crossBlockRes = compareSpecSourcesAst('tests/e2e/cross.spec.ts', baseTwoBlocks, headCrossBlockCheat);
  assert.equal(crossBlockRes.ok, false);
  assert.ok(crossBlockRes.findings.some((f) => f.code === 'AITEST-G102'));
});

test('v6.3.0 WU-3: explore paired boolean flags, case-level ledger-bound traceability & regression history diagnostics', () => {
  // 1. Paired boolean flags resolution
  assert.equal(resolvePairedBooleanFlag({}, 'explore-tabs', 'no-explore-tabs', true), true);
  assert.equal(resolvePairedBooleanFlag({ 'explore-tabs': true }, 'explore-tabs', 'no-explore-tabs', true), true);
  assert.equal(resolvePairedBooleanFlag({ 'no-explore-tabs': true }, 'explore-tabs', 'no-explore-tabs', true), false);
  assert.equal(
    resolvePairedBooleanFlag({ 'explore-tabs': true, 'no-explore-tabs': true }, 'explore-tabs', 'no-explore-tabs', true, [
      { kind: 'option', name: 'no-explore-tabs' },
      { kind: 'option', name: 'explore-tabs' },
    ]),
    true
  );
  assert.equal(
    resolvePairedBooleanFlag({ 'explore-tabs': true, 'no-explore-tabs': true }, 'explore-tabs', 'no-explore-tabs', true, [
      { kind: 'option', name: 'explore-tabs' },
      { kind: 'option', name: 'no-explore-tabs' },
    ]),
    false
  );

  // 2. Pure regression history classifier unit cases
  assert.equal(classifyFailureRegressionHistory([]), 'first-observed');
  assert.equal(classifyFailureRegressionHistory(['expected']), 'new-regression');
  assert.equal(classifyFailureRegressionHistory(['expected', 'expected']), 'new-regression');
  assert.equal(classifyFailureRegressionHistory(['unexpected']), 'persistent-failure');
  assert.equal(classifyFailureRegressionHistory(['expected', 'unexpected']), 'persistent-failure');
  assert.equal(classifyFailureRegressionHistory(['unexpected', 'expected']), 'intermittent-flaky');
  assert.equal(classifyFailureRegressionHistory(['expected', 'flaky']), 'intermittent-flaky');
  assert.equal(classifyFailureRegressionHistory(['expected'], 'flaky'), 'intermittent-flaky');

  // 3. End-to-end case-level ledger-bound traceability + Run Ledger differential diagnostics
  const tmpRepo = makeTempDir('aitest-v630-trace-diag-');
  const qaDir = path.join(tmpRepo, 'qa');
  try {
    fs.mkdirSync(path.join(qaDir, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(qaDir, 'tests', 'e2e'), { recursive: true });
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });

    fs.writeFileSync(
      path.join(qaDir, 'specs', 'auth.md'),
      ['# Auth Spec', '- **REQ-001**: Login succeeds', '- **REQ-002**: Invalid password rejected', '- **REQ-003**: Legacy cookie'].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'auth.spec.ts'),
      [
        "test('REQ-001 login succeeds', async () => {});",
        "test('REQ-002 invalid password rejected', async () => {});",
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(qaDir, 'tests', 'e2e', 'legacy.spec.ts'),
      "// Covers REQ-003\ntest('legacy cookie flow', async () => {});\n",
      'utf8'
    );

    const resultsPath = path.join(qaDir, 'reports', 'results.json');

    // Run 1 (clean passing run recorded in Run Ledger)
    const run1 = beginRunLedger(qaDir, { suite: 'e2e', command: 'test', repoDir: tmpRepo });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        suites: [
          ...makePassingAndFailingResults({
            file: 'tests/e2e/auth.spec.ts',
            cases: [
              { title: 'REQ-001 login succeeds', status: 'expected' },
              { title: 'REQ-002 invalid password rejected', status: 'expected' },
            ],
          }).suites,
          ...makePassingAndFailingResults({
            file: 'tests/e2e/legacy.spec.ts',
            cases: [{ title: 'legacy cookie flow', status: 'expected' }],
          }).suites,
        ],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, run1.runId, { exitCode: 0, resultsPath });

    // Write an unbound results.json where REQ-001 passes and REQ-002 fails in the SAME spec file
    const mixedResults = {
      suites: [
        ...makePassingAndFailingResults({
          file: 'tests/e2e/auth.spec.ts',
          cases: [
            { title: 'REQ-001 login succeeds', status: 'expected' },
            { title: 'REQ-002 invalid password rejected', status: 'unexpected' },
          ],
        }).suites,
        ...makePassingAndFailingResults({
          file: 'tests/e2e/legacy.spec.ts',
          cases: [{ title: 'legacy cookie flow', status: 'expected' }],
        }).suites,
      ],
    };
    fs.writeFileSync(resultsPath, JSON.stringify(mixedResults), 'utf8');

    const unboundMatrix = buildRequirementTraceMatrix(qaDir);
    assert.equal(unboundMatrix.ledgerBound, false);
    assert.equal(unboundMatrix.runId, null);
    const req1 = unboundMatrix.requirements.find((r) => r.reqId === 'REQ-001');
    const req2 = unboundMatrix.requirements.find((r) => r.reqId === 'REQ-002');
    const req3 = unboundMatrix.requirements.find((r) => r.reqId === 'REQ-003');
    assert.equal(req1?.status, 'passed', 'REQ-001 must remain passed even though REQ-002 failed in the same spec file');
    assert.equal(req2?.status, 'failed');
    assert.equal(req3?.status, 'passed', 'REQ-003 file-comment fallback must still resolve passed');

    // Now bind Run 2 in Run Ledger -> traceability becomes ledgerBound=true AND diagnose detects new-regression!
    const run2 = beginRunLedger(qaDir, { suite: 'e2e', command: 'test', repoDir: tmpRepo });
    fs.writeFileSync(resultsPath, JSON.stringify(mixedResults), 'utf8');
    finalizeRunLedger(qaDir, run2.runId, { exitCode: 1, resultsPath });

    const boundMatrix = buildRequirementTraceMatrix(qaDir);
    assert.equal(boundMatrix.ledgerBound, true);
    assert.equal(boundMatrix.runId, run2.runId);
    assert.match(renderTraceMatrixMarkdown(boundMatrix, 'en'), new RegExp(`runId=${run2.runId}`));

    const diag2 = generateDiagnosticsMarkdown(qaDir, resultsPath);
    assert.equal(diag2.failureCount, 1);
    assert.equal(diag2.failures[0].regressionHistory, 'new-regression');
    assert.match(diag2.markdown, /\*\*Regression History\*\*: `new-regression`/);

    // Run 3 fails the same test again -> persistent-failure
    const run3 = beginRunLedger(qaDir, { suite: 'e2e', command: 'test', repoDir: tmpRepo });
    fs.writeFileSync(resultsPath, JSON.stringify(mixedResults), 'utf8');
    finalizeRunLedger(qaDir, run3.runId, { exitCode: 1, resultsPath });

    const diag3 = generateDiagnosticsMarkdown(qaDir, resultsPath);
    assert.equal(diag3.failures[0].regressionHistory, 'persistent-failure');
  } finally {
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('v6.3.0 WU-4: ReDoS linear-time hardening keeps 100KB pathological inputs < 100ms with 100% redaction recall', () => {
  const N = 100_000;
  const payloads = [
    `-----BEGIN RSA PRIVATE KEY-----\n${'A'.repeat(N)}`,
    '-----BEGIN '.repeat(10_000),
    `"password":"${'x'.repeat(N)}`,
    `"${'a'.repeat(N)}`,
    'a-'.repeat(50_000),
    'a'.repeat(N),
    ' '.repeat(N) + 'token',
    `setItem("auth_token","${'z'.repeat(N)}`,
    '?'.repeat(N),
    'a.'.repeat(50_000),
    `${'/'.repeat(N)}b`,
  ];

  for (const [idx, input] of payloads.entries()) {
    const t0 = performance.now();
    redactSecrets(input);
    sanitizeUntrustedDomText(input);
    detectUrlQueryAnomalies(input);
    routeToSafeSlug(input);
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 100, `Pathological payload #${idx} took ${elapsed.toFixed(1)}ms (>= 100ms ReDoS budget)`);
  }

  // Verify recall on real secrets and PII stays 100%
  const pem = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC\n-----END PRIVATE KEY-----';
  assert.equal(redactSecrets(pem), '[REDACTED_PRIVATE_KEY]');
  assert.equal(redactSecrets('https://admin:supersecret@db.internal:5432/app'), 'https://admin:[REDACTED]@db.internal:5432/app');
  assert.equal(redactSecrets("localStorage.setItem('access_token', 'tok_secret_123')"), "localStorage.setItem('access_token', '[REDACTED]')");
  assert.equal(sanitizeUntrustedDomText('Contact alice@example.com or 13812345678'), 'Contact [REDACTED_EMAIL] or [REDACTED_PHONE]');
  assert.deepEqual(detectUrlQueryAnomalies('/api/list?page=1&sort=undefined&x=2'), [
    'Literal "undefined" passed as URL query parameter',
  ]);
  assert.equal(routeToSafeSlug('///users/profile///'), 'users-profile');
});
