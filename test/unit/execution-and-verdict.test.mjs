import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runAuditCommand } from '../../src/audit.mjs';
import { runCli } from '../../src/cli.mjs';
import { runMapCommand } from '../../src/codemap.mjs';
import { runDiagnoseCommand } from '../../src/diagnose.mjs';
import { runFlakyCommand } from '../../src/flaky.mjs';
import { beginHealSession } from '../../src/heal.mjs';
import { beginRunLedger, finalizeRunLedger } from '../../src/ledger.mjs';
import { TOOL_REGISTRY } from '../../src/mcp/registry.mjs';
import {
  buildPromptMessages,
  getMcpPromptDefinitions,
  getMcpResourceDefinitions,
  getMcpResourceTemplates,
  readMcpResource,
} from '../../src/mcp/resources.mjs';
import { buildSuitePlaywrightArgs, executeSuiteCore, runSuiteCommand } from '../../src/runner.mjs';
import {
  buildPrVerdictMarkdown,
  buildSarifReport,
  checkHealSessionConflicts,
  runVerifyChangeCommand,
} from '../../src/verdict.mjs';

test('verdict: buildSarifReport, buildPrVerdictMarkdown, checkHealSessionConflicts & CLI guard paths', async () => {
  const sampleVerdict = {
    verdict: 'fail',
    trustLevel: 'T1',
    trustTier: 'T1',
    runId: '01TESTRUNID000000000000000',
    gitSha: 'abc1234',
    base: { requested: 'auto', resolved: 'HEAD~1', strategy: 'clean-tree-parent' },
    scope: { requested: 'impact', actual: 'smoke', downgraded: false },
    acceptanceScope: 'local-workbench',
    counts: { executed: 2, passed: 1, failed: 1, flaky: 0 },
    gates: { governance: 'pass', static: 'pass', runtime: 'fail', semanticDiff: 'fail' },
    traceability: { coveredRequirements: 1, totalRequirements: 2, coveragePct: 50 },
    ai: { llmCalls: 0 },
    gateErrors: [
      '[AITEST-G103] Assertion strength downgraded from S5 to S2',
      'Generic uncategorized failure message',
    ],
    failures: [
      {
        categoryCode: 'C',
        category: 'Class C: Product / Backend Defect',
        file: 'tests/e2e/home.spec.ts',
        line: 12,
        title: 'shows course list',
        errorSnippet: 'Expected 200, received 500',
        traceId: '0123456789abcdef0123456789abcdef',
        confidence: 'high',
      },
    ],
  };

  const sarif = buildSarifReport(sampleVerdict);
  assert.equal(sarif.version, '2.1.0');
  assert.equal(sarif.runs[0].results.length, 3);
  assert.equal(sarif.runs[0].results[0].ruleId, 'AITEST-G103');
  assert.equal(sarif.runs[0].results[1].ruleId, 'AITEST-GATE-FAILURE');
  assert.equal(sarif.runs[0].results[2].ruleId, 'AITEST-TEST-CLASS-C');
  assert.equal(sarif.runs[0].properties.mergeGradeGreen, false);

  const mdZh = buildPrVerdictMarkdown(sampleVerdict, 'zh');
  const mdEn = buildPrVerdictMarkdown({ ...sampleVerdict, verdict: 'pass', trustLevel: 'T2', acceptanceScope: 'business-e2e', failures: [], gateErrors: [] }, 'en');
  assert.match(mdZh, /FAIL/);
  assert.match(mdZh, /AITEST-G103/);
  assert.match(mdEn, /PASS/);
  assert.match(mdEn, /Business E2E Verified/);

  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-verdict-unit-'));
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    // Missing target / missing QA dir
    assert.equal(await runVerifyChangeCommand({ lang: 'en', json: true }), 1);
    assert.equal(await runVerifyChangeCommand({ target: tmpRepo, lang: 'zh', json: false }), 1);

    await runCli(['init', '--name', 'verd-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Non-git workspace blocked with exit code 2
    assert.equal(await runVerifyChangeCommand({ target: tmpRepo, json: true, lang: 'en' }), 2);
    assert.equal(await runVerifyChangeCommand({ target: tmpRepo, json: false, lang: 'zh' }), 2);

    // checkHealSessionConflicts catches corrupted heal JSON and tampered heal MAC
    const healsDir = path.join(qaDir, '.aitest', 'heals');
    fs.mkdirSync(healsDir, { recursive: true });
    fs.writeFileSync(path.join(healsDir, 'corrupt.json'), '{bad json', 'utf8');
    const corruptRes = checkHealSessionConflicts(qaDir, { isGitRepo: false });
    assert.equal(corruptRes.ok, false);
    assert.ok(corruptRes.errors.some((e) => /Corrupted heal session/.test(e)));
    fs.unlinkSync(path.join(healsDir, 'corrupt.json'));

    // Tampered heal session MAC
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        suites: [
          {
            file: 'tests/e2e/home.spec.ts',
            specs: [
              {
                title: 'api 500 failure',
                file: 'tests/e2e/home.spec.ts',
                line: 8,
                tests: [{ status: 'unexpected', results: [{ error: { message: 'HTTP 500 Internal Server Error' } }] }],
              },
            ],
          },
        ],
      }),
      'utf8'
    );
    const healStart = beginHealSession(qaDir);
    assert.equal(healStart.ok, true);
    const sPath = path.join(healsDir, `${healStart.session.sessionId}.json`);
    const sObj = JSON.parse(fs.readFileSync(sPath, 'utf8'));
    sObj.categoryCode = 'A';
    fs.writeFileSync(sPath, JSON.stringify(sObj), 'utf8');
    const tamperRes = checkHealSessionConflicts(qaDir, { isGitRepo: false });
    assert.equal(tamperRes.ok, false);
    assert.ok(tamperRes.errors.some((e) => /Tampered heal session/.test(e)));
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});

test('runner: buildSuitePlaywrightArgs covers all suites & executeSuiteCore/runSuiteCommand enforce guards', async () => {
  assert.deepEqual(buildSuitePlaywrightArgs('smoke'), ['--project=smoke']);
  assert.deepEqual(buildSuitePlaywrightArgs('e2e'), ['--project=e2e']);
  assert.deepEqual(buildSuitePlaywrightArgs('api'), ['--project=api']);
  assert.deepEqual(buildSuitePlaywrightArgs('seed'), ['--project=seed']);
  assert.deepEqual(buildSuitePlaywrightArgs('a11y', { hasBaseUrl: false }), ['--project=smoke', '--grep=@a11y']);
  assert.deepEqual(buildSuitePlaywrightArgs('a11y', { hasBaseUrl: true }), ['--project=smoke', '--project=e2e', '--grep=@a11y']);
  assert.deepEqual(buildSuitePlaywrightArgs('critical', { hasBaseUrl: true }), [
    '--project=smoke',
    '--project=e2e',
    '--project=api',
    '--grep=@critical|@smoke',
  ]);
  assert.deepEqual(buildSuitePlaywrightArgs('all'), ['--project=smoke', '--project=e2e', '--project=api']);
  assert.throws(() => buildSuitePlaywrightArgs('nonexistent'), /Unknown suite/);

  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    const noTarget = await executeSuiteCore({ lang: 'en' });
    assert.equal(noTarget.ok, false);
    assert.equal(noTarget.exitCode, 1);

    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-runner-unit-'));
    try {
      const noQa = await executeSuiteCore({ target: tmpRepo, lang: 'zh' });
      assert.equal(noQa.ok, false);
      assert.equal(noQa.exitCode, 1);

      assert.equal(await runSuiteCommand({ target: tmpRepo, json: true, lang: 'en' }), 1);
      assert.equal(await runSuiteCommand({ target: tmpRepo, json: false, lang: 'zh' }), 1);
    } finally {
      fs.rmSync(tmpRepo, { recursive: true, force: true });
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
});

test('audit, flaky, diagnose, codemap CLI commands & MCP resources/prompts/tools coverage', async () => {
  const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-cmd-res-'));
  const origLog = console.log;
  const origErr = console.error;
  console.log = () => {};
  console.error = () => {};

  try {
    // Guard paths when target missing
    assert.equal(await runAuditCommand({ lang: 'en' }), 1);
    assert.equal(await runFlakyCommand({ lang: 'en' }), 1);
    assert.equal(await runDiagnoseCommand({ lang: 'en' }), 1);
    assert.equal(await runMapCommand({ lang: 'en' }), 1);

    await runCli(['init', '--name', 'cmd-res-app', '--target', tmpRepo, '--skip-install', '--loop', 'none']);
    const qaDir = path.join(tmpRepo, 'qa');

    // Create valid ledger + results so audit, flaky, diagnose, map all execute full happy paths
    const began = beginRunLedger(qaDir, { suite: 'smoke', command: 'playwright test', repoDir: tmpRepo });
    const resultsPath = path.join(qaDir, 'reports', 'results.json');
    fs.mkdirSync(path.join(qaDir, 'reports'), { recursive: true });
    fs.mkdirSync(path.join(qaDir, 'specs'), { recursive: true });
    fs.mkdirSync(path.join(qaDir, 'knowledge'), { recursive: true });
    fs.writeFileSync(
      resultsPath,
      JSON.stringify({
        config: { metadata: { runId: began.runId } },
        suites: [{ file: 'tests/smoke/workbench.spec.ts', specs: [{ title: 'ok @smoke', line: 4, tests: [{ status: 'expected', results: [] }] }] }],
      }),
      'utf8'
    );
    finalizeRunLedger(qaDir, began.runId, { exitCode: 0, resultsPath });

    assert.equal(await runAuditCommand({ target: tmpRepo, json: true, lang: 'en' }), 0);
    assert.equal(await runAuditCommand({ target: tmpRepo, json: false, lang: 'zh' }), 0);
    assert.equal(await runFlakyCommand({ target: tmpRepo, json: true, syncQuarantine: true, lang: 'en' }), 0);
    assert.equal(await runFlakyCommand({ target: tmpRepo, json: false, lang: 'zh' }), 0);
    assert.equal(await runDiagnoseCommand({ target: tmpRepo, json: true, dryRun: true, lang: 'en' }), 0);
    assert.equal(await runDiagnoseCommand({ target: tmpRepo, json: false, lang: 'zh' }), 0);
    assert.equal(await runMapCommand({ target: tmpRepo, json: true, lang: 'en' }), 0);
    assert.equal(await runMapCommand({ target: tmpRepo, json: false, force: true, lang: 'zh' }), 0);

    // Populate artifacts for MCP resources tests
    fs.writeFileSync(path.join(qaDir, 'specs', 'system-overview.md'), '# Overview\n', 'utf8');
    fs.writeFileSync(path.join(qaDir, 'reports', 'perf-summary.md'), '# Perf\n', 'utf8');
    fs.writeFileSync(path.join(qaDir, 'reports', 'verdict-summary.md'), '# Verdict\n', 'utf8');
    fs.writeFileSync(path.join(qaDir, 'reports', 'trace-matrix.md'), '# Trace\n', 'utf8');

    const resDefs = getMcpResourceDefinitions(tmpRepo);
    assert.ok(resDefs.length >= 9);
    assert.ok(getMcpResourceDefinitions(null).length === 3);
    assert.ok(getMcpResourceTemplates().length >= 5);

    const ctx = { workspaceRoots: [tmpRepo] };
    assert.ok(readMcpResource('aitest://docs/quickstart', ctx)?.contents[0].text.length > 10);
    assert.ok(readMcpResource('aitest://skill/ai-test-workbench', ctx)?.contents[0].text.length > 10);
    assert.ok(readMcpResource('aitest://mcp/presets', ctx)?.contents[0].text.includes('ai-test-workbench'));

    const enc = encodeURIComponent(tmpRepo);
    for (const suffix of ['system-overview', 'system-map', 'code-map', 'diagnostics', 'perf-summary', 'verdict-summary']) {
      const readRes = readMcpResource(`aitest://project/${enc}/${suffix}`, ctx);
      assert.ok(readRes && 'contents' in readRes && readRes.contents.length === 1, `Expected resource content for ${suffix}`);
    }
    const curRes = readMcpResource('aitest://current/system-map', { ...ctx, defaultTarget: tmpRepo });
    assert.ok(curRes && 'contents' in curRes && curRes.contents.length === 1);
    const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-res-uninit-'));
    try {
      const uninitRes = readMcpResource(`aitest://project/${encodeURIComponent(uninitDir)}/system-map`, { workspaceRoots: [uninitDir] });
      assert.ok(uninitRes && 'contents' in uninitRes && /not initialized/.test(uninitRes.contents[0].text));
    } finally {
      fs.rmSync(uninitDir, { recursive: true, force: true });
    }
    assert.equal(readMcpResource('aitest://unknown/uri', ctx), null);

    // Prompts: all 5 prompts in both zh and en + unknown
    const promptDefs = getMcpPromptDefinitions();
    assert.equal(promptDefs.length, 5);
    for (const p of promptDefs) {
      const zhP = buildPromptMessages(p.name, { target: tmpRepo, baseUrl: 'http://127.0.0.1:4173', lang: 'zh' });
      const enP = buildPromptMessages(p.name, { target: tmpRepo, baseUrl: 'http://127.0.0.1:4173', lang: 'en' });
      assert.ok(zhP && zhP.messages.length === 1);
      assert.ok(enP && enP.messages.length === 1);
    }
    assert.equal(buildPromptMessages('nonexistent-prompt'), null);

    // Exercise buildCliArgs / isReadOnly / nextActions / getTimeoutMs across all 17 registered MCP tools
    for (const entry of TOOL_REGISTRY) {
      if (entry.buildCliArgs) {
        const sampleArgs =
          entry.name === 'aitest_heal'
            ? { action: 'attempt', sessionId: 'heal_1', skipRun: true }
            : entry.name === 'aitest_mcp_hub'
              ? { action: 'add', profile: 'minimal' }
              : entry.name === 'aitest_explore'
                ? { exploreTabs: false, exploreDialogs: false, explorePortals: false, dryRun: true }
                : entry.name === 'aitest_verify_change'
                  ? { budgetMs: 30000, mode: 'impact' }
                  : {};
        const cliArgs = entry.buildCliArgs(sampleArgs, tmpRepo, 'en');
        assert.ok(Array.isArray(cliArgs) && cliArgs.length >= 1);
        if (entry.name === 'aitest_heal') {
          assert.ok(entry.buildCliArgs({ action: 'begin', testId: 't1' }, tmpRepo, 'en').includes('begin'));
          assert.ok(entry.buildCliArgs({ action: 'conclude', sessionId: 'heal_1', outcome: 'verified' }, tmpRepo, 'en').includes('conclude'));
        }
      }
      if (entry.isReadOnly) assert.equal(typeof entry.isReadOnly({}), 'boolean');
      if (entry.getTimeoutMs) assert.equal(entry.getTimeoutMs({ budgetMs: 10000 }), 40000);
      assert.ok(Array.isArray(entry.nextActions(true, { action: 'begin' })));
      assert.ok(Array.isArray(entry.nextActions(false, { action: 'attempt' })));
      assert.ok(Array.isArray(entry.nextActions(true, { action: 'conclude' })));
    }
  } finally {
    console.log = origLog;
    console.error = origErr;
    fs.rmSync(tmpRepo, { recursive: true, force: true });
  }
});
