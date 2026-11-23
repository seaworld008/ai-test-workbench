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
  const traces = findTraceZips(path.join(qaDir, 'test-results'));

  const payload = {
    qaDir,
    htmlReport: fs.existsSync(htmlReport) ? htmlReport : null,
    junitXml: fs.existsSync(junitXml) ? junitXml : null,
    resultsJson: fs.existsSync(resultsJson) ? resultsJson : null,
    aiDiagnostics: fs.existsSync(aiDiag) ? aiDiag : null,
    traces,
  };

  if (options.json) {
    console.log(JSON.stringify(payload, null, 2));
    return payload.resultsJson || payload.htmlReport ? 0 : 1;
  }

  console.log(`\n=== ${lang === 'zh' ? '本地测试报告与证据索引 (report)' : 'Local Test Reports & Artifacts'} ===`);
  console.log(`HTML Report     : ${payload.htmlReport || '(not generated yet)'}`);
  console.log(`JUnit XML       : ${payload.junitXml || '(not generated yet)'}`);
  console.log(`Results JSON    : ${payload.resultsJson || '(not generated yet)'}`);
  console.log(`AI Diagnostics  : ${payload.aiDiagnostics || '(not generated yet — run "diagnose" on failure)'}`);
  console.log(`Failure Traces  : ${traces.length} trace file(s)`);
  for (const tr of traces.slice(0, 10)) {
    console.log(`  -> npx playwright show-trace "${tr}"`);
  }
  if (payload.htmlReport) {
    console.log(`\n${lang === 'zh' ? '本地查看报告命令' : 'View HTML report locally'}:`);
    console.log(`  cd "${qaDir}" && npx playwright show-report`);
  }
  console.log('');
  return payload.resultsJson || payload.htmlReport ? 0 : 1;
}
