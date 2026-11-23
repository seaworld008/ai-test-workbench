import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';

function findTraceZips(dir) {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...findTraceZips(full));
    else if (entry.isFile() && entry.name.endsWith('trace.zip')) found.push(full);
  }
  return found;
}

export async function runReportCommand(options = {}) {
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
  const systemOverview = path.join(qaDir, 'specs', 'system-overview.md');
  const systemTopology = path.join(qaDir, 'reports', 'system-topology.json');
  const systemMap = path.join(qaDir, 'knowledge', 'SYSTEM_MAP.md');
  const codeMap = path.join(qaDir, 'knowledge', 'code-map.json');
  const perfSummary = path.join(qaDir, 'reports', 'perf-summary.md');
  const perfReport = path.join(qaDir, 'reports', 'perf-report.json');
  const traces = findTraceZips(path.join(qaDir, 'test-results'));

  const payload = {
    qaDir,
    htmlReport: fs.existsSync(htmlReport) ? htmlReport : null,
    junitXml: fs.existsSync(junitXml) ? junitXml : null,
    resultsJson: fs.existsSync(resultsJson) ? resultsJson : null,
    aiDiagnostics: fs.existsSync(aiDiag) ? aiDiag : null,
    systemOverview: fs.existsSync(systemOverview) ? systemOverview : null,
    systemTopology: fs.existsSync(systemTopology) ? systemTopology : null,
    systemMap: fs.existsSync(systemMap) ? systemMap : null,
    codeMap: fs.existsSync(codeMap) ? codeMap : null,
    perfSummary: fs.existsSync(perfSummary) ? perfSummary : null,
    perfReport: fs.existsSync(perfReport) ? perfReport : null,
    traces,
  };

  const hasAny = Boolean(
    payload.resultsJson ||
      payload.htmlReport ||
      payload.systemOverview ||
      payload.systemMap ||
      payload.perfReport
  );

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return hasAny ? 0 : 1;
  }

  console.log(`\n=== ${lang === 'zh' ? '本地测试报告、知识图谱与证据索引 (report)' : 'Local Test Reports, Code Map & Artifacts'} ===`);
  console.log(`HTML Report     : ${payload.htmlReport || '(not generated yet)'}`);
  console.log(`JUnit XML       : ${payload.junitXml || '(not generated yet)'}`);
  console.log(`Results JSON    : ${payload.resultsJson || '(not generated yet)'}`);
  console.log(`AI Diagnostics  : ${payload.aiDiagnostics || '(not generated yet — run "diagnose" on failure)'}`);
  console.log(`System Atlas    : ${payload.systemOverview || '(not explored yet)'}`);
  console.log(`Living Code Map : ${payload.systemMap || '(not synced yet — run "map")'}`);
  console.log(`Perf Summary    : ${payload.perfSummary || '(not benchmarked yet — run "perf")'}`);
  console.log(`Failure Traces  : ${traces.length} trace file(s)`);
  for (const tr of traces.slice(0, 10)) {
    console.log(`  -> npx playwright show-trace "${tr}"`);
  }
  if (payload.htmlReport) {
    console.log(`\n${lang === 'zh' ? '本地查看报告命令' : 'View HTML report locally'}:`);
    console.log(`  cd "${qaDir}" && npx playwright show-report`);
  }
  console.log('');
  return hasAny ? 0 : 1;
}
