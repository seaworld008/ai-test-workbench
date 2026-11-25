// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
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
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

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

  const payload = {
    qaDir,
    htmlReport: fs.existsSync(htmlReport) ? htmlReport : null,
    junitXml: fs.existsSync(junitXml) ? junitXml : null,
    resultsJson: fs.existsSync(resultsJson) ? resultsJson : null,
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
    latestRun: fs.existsSync(latestRun) ? latestRun : null,
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

  const exitCode = hasAny ? 0 : 1;
  if (!options.json) {
    console.log(`\n=== ${lang === 'zh' ? '本地测试报告、知识图谱与证据索引 (report)' : 'Local Test Reports, Code Map & Artifacts'} ===`);
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
    console.log(`Failure Traces  : ${traces.length} trace file(s)`);
    for (const tr of traces.slice(0, 10)) {
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
        ? `Indexed QA artifacts (${traces.length} trace(s), results=${Boolean(payload.resultsJson)})`
        : 'No test reports or artifacts found yet in QA workspace.',
      data: payload,
    }),
    { asJson: Boolean(options.json) }
  );
}
