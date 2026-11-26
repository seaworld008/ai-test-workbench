// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { summarizePlaywrightResults } from './core/playwright-results.mjs';
import { runFlakyCommand } from './flaky.mjs';
import { runTraceMatrixCommand } from './traceability.mjs';

/**
 * @param {string} dir
 * @returns {string[]}
 */
function findTraceZips(dir) {
  /** @type {string[]} */
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTraceZips(full));
    else if (entry.isFile() && entry.name.endsWith('trace.zip')) found.push(full);
  }
  return found;
}

/**
 * Reads lightweight latest Run Ledger metadata and test result counts without mutating disk.
 * @param {string} qaDir
 * @param {string | null} latestRunPath
 * @param {string | null} resultsJsonPath
 */
function readLatestRunAndCounts(qaDir, latestRunPath, resultsJsonPath) {
  /** @type {{ runId: string, suite: string | null, gitSha: string | null, finishedAt: string | null, exitCode: number | null } | null} */
  let latestRunSummary = null;
  /** @type {{ total: number, executed: number, passed: number, failed: number, flaky: number, skipped: number } | null} */
  let resultsCounts = null;

  if (latestRunPath && fs.existsSync(latestRunPath)) {
    try {
      const latest = JSON.parse(fs.readFileSync(latestRunPath, 'utf8'));
      if (latest && typeof latest.runId === 'string') {
        latestRunSummary = {
          runId: latest.runId,
          suite: typeof latest.suite === 'string' ? latest.suite : null,
          gitSha: typeof latest.gitSha === 'string' ? latest.gitSha : null,
          finishedAt: typeof latest.finishedAt === 'string' ? latest.finishedAt : null,
          exitCode: typeof latest.exitCode === 'number' ? latest.exitCode : null,
        };
        const manifestPath = path.join(qaDir, '.aitest', 'runs', latest.runId, 'manifest.json');
        if (fs.existsSync(manifestPath)) {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest?.counts && typeof manifest.counts.total === 'number') {
            resultsCounts = manifest.counts;
          }
        }
      }
    } catch {
      // ignore malformed latest.json
    }
  }

  if (!resultsCounts && resultsJsonPath && fs.existsSync(resultsJsonPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(resultsJsonPath, 'utf8'));
      resultsCounts = summarizePlaywrightResults(parsed).counts;
    } catch {
      // ignore malformed results.json
    }
  }

  return { latestRunSummary, resultsCounts };
}

/**
 * Pure read-only QA artifact & latest run summary collector (shared by CLI `report` and MCP fast path).
 * @param {string} qaDir
 * @param {{ view?: 'summary' | 'artifacts' }} [options]
 */
export function collectReportArtifacts(qaDir, options = {}) {
  const view = options.view === 'summary' ? 'summary' : 'artifacts';
  const htmlReport = path.join(qaDir, 'playwright-report', 'index.html');
  const junitXml = path.join(qaDir, 'reports', 'junit.xml');
  const resultsJson = path.join(qaDir, 'reports', 'results.json');
  const aiDiag = path.join(qaDir, 'reports', 'ai-diagnostics.md');
  const verdictSummary = path.join(qaDir, 'reports', 'verdict-summary.md');
  const verdictSarif = path.join(qaDir, 'reports', 'verdict.sarif.json');
  const traceMatrix = path.join(qaDir, 'reports', 'trace-matrix.md');
  const systemOverview = path.join(qaDir, 'specs', 'system-overview.md');
  const systemTopology = path.join(qaDir, 'reports', 'system-topology.json');
  const systemMap = path.join(qaDir, 'knowledge', 'SYSTEM_MAP.md');
  const codeMap = path.join(qaDir, 'knowledge', 'code-map.json');
  const perfSummary = path.join(qaDir, 'reports', 'perf-summary.md');
  const perfReport = path.join(qaDir, 'reports', 'perf-report.json');
  const latestRun = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  const traces = findTraceZips(path.join(qaDir, 'test-results'));

  const resultsJsonPresent = fs.existsSync(resultsJson) ? resultsJson : null;
  const latestRunPresent = fs.existsSync(latestRun) ? latestRun : null;
  const { latestRunSummary, resultsCounts } = readLatestRunAndCounts(qaDir, latestRunPresent, resultsJsonPresent);

  const payload = {
    view,
    qaDir,
    htmlReport: fs.existsSync(htmlReport) ? htmlReport : null,
    junitXml: fs.existsSync(junitXml) ? junitXml : null,
    resultsJson: resultsJsonPresent,
    aiDiagnostics: fs.existsSync(aiDiag) ? aiDiag : null,
    verdictSummary: fs.existsSync(verdictSummary) ? verdictSummary : null,
    verdictSarif: fs.existsSync(verdictSarif) ? verdictSarif : null,
    traceMatrix: fs.existsSync(traceMatrix) ? traceMatrix : null,
    systemOverview: fs.existsSync(systemOverview) ? systemOverview : null,
    systemTopology: fs.existsSync(systemTopology) ? systemTopology : null,
    systemMap: fs.existsSync(systemMap) ? systemMap : null,
    codeMap: fs.existsSync(codeMap) ? codeMap : null,
    perfSummary: fs.existsSync(perfSummary) ? perfSummary : null,
    perfReport: fs.existsSync(perfReport) ? perfReport : null,
    latestRun: latestRunPresent,
    latestRunSummary,
    resultsCounts,
    traces,
  };

  const hasAny = Boolean(
    payload.resultsJson ||
      payload.htmlReport ||
      payload.systemOverview ||
      payload.systemMap ||
      payload.perfReport ||
      payload.verdictSummary
  );

  return { payload, hasAny };
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, view?: string, syncQuarantine?: boolean, dryRun?: boolean, force?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runReportCommand(options = {}) {
  const view = String(options.view || 'artifacts').toLowerCase();
  if (view === 'flaky') {
    return runFlakyCommand({
      lang: options.lang,
      target: options.target,
      qaDir: options.qaDir,
      syncQuarantine: Boolean(options.syncQuarantine),
      json: Boolean(options.json),
    });
  }
  if (view === 'traceability' || view === 'trace-matrix') {
    return runTraceMatrixCommand({
      lang: options.lang,
      target: options.target,
      qaDir: options.qaDir,
      dryRun: Boolean(options.dryRun),
      json: Boolean(options.json),
    });
  }
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {number} exitCode @param {string} msg @param {'fail' | 'usage'} [outcome] */
  const failReport = (exitCode, msg, outcome = exitCode === 64 ? 'usage' : 'fail') => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'report', outcome, ok: false, exitCode, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  };
  if (view !== 'artifacts' && view !== 'summary') {
    return failReport(64, `Invalid --view "${view}". Use: summary | artifacts | flaky | traceability`, 'usage');
  }
  if (!options.target) {
    return failReport(1, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    return failReport(1, lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  const { payload, hasAny } = collectReportArtifacts(qaDir, { view });
  const exitCode = hasAny ? 0 : 1;

  if (!options.json) {
    console.log(`\n=== ${lang === 'zh' ? '本地测试报告、知识图谱与证据索引 (report)' : 'Local Test Reports, Code Map & Artifacts'} ===`);
    console.log(`View            : ${payload.view}`);
    if (payload.latestRunSummary) {
      console.log(
        `Latest Run      : ${payload.latestRunSummary.runId} (suite=${payload.latestRunSummary.suite || 'unknown'}, exit=${payload.latestRunSummary.exitCode})`
      );
    }
    if (payload.resultsCounts) {
      console.log(
        `Results Counts  : passed=${payload.resultsCounts.passed}, failed=${payload.resultsCounts.failed}, flaky=${payload.resultsCounts.flaky}, skipped=${payload.resultsCounts.skipped}`
      );
    }
    console.log(`HTML Report     : ${payload.htmlReport || '(not generated yet)'}`);
    console.log(`JUnit XML       : ${payload.junitXml || '(not generated yet)'}`);
    console.log(`Results JSON    : ${payload.resultsJson || '(not generated yet)'}`);
    console.log(`Verdict Summary : ${payload.verdictSummary || '(not generated yet — run "verify-change")'}`);
    console.log(`SARIF Report    : ${payload.verdictSarif || '(not generated yet)'}`);
    console.log(`AI Diagnostics  : ${payload.aiDiagnostics || '(not generated yet — run "diagnose" on failure)'}`);
    console.log(`Trace Matrix    : ${payload.traceMatrix || '(not generated yet — run "trace-matrix")'}`);
    console.log(`System Atlas    : ${payload.systemOverview || '(not explored yet)'}`);
    console.log(`Living Code Map : ${payload.systemMap || '(not synced yet — run "map")'}`);
    console.log(`Perf Summary    : ${payload.perfSummary || '(not benchmarked yet — run "perf")'}`);
    console.log(`Failure Traces  : ${payload.traces.length} trace file(s)`);
    for (const tr of payload.traces.slice(0, 10)) {
      console.log(`  -> npx playwright show-trace "${tr}"`);
    }
    console.log('');
  }

  return emitCommandResult(
    buildCommandResult({
      tool: 'report',
      outcome: hasAny ? 'pass' : 'fail',
      ok: hasAny,
      exitCode,
      summary: hasAny
        ? `Indexed QA ${payload.view} (${payload.traces.length} trace(s), results=${Boolean(payload.resultsJson)})`
        : 'No test reports or artifacts found yet in QA workspace.',
      data: payload,
    }),
    { asJson: Boolean(options.json) }
  );
}
