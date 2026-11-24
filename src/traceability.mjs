// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { groupOutcomesBySpecFile } from './core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';

const REQ_ID_RE = /\b(REQ-[A-Z0-9]+(?:-[A-Z0-9]+)*)\b/g;

/**
 * @param {string} dir
 * @param {(name: string) => boolean} extPredicate
 * @param {string[]} [out]
 * @returns {string[]}
 */
function walkFilesByExt(dir, extPredicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFilesByExt(full, extPredicate, out);
    else if (entry.isFile() && extPredicate(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Builds the Requirement <-> Spec <-> Runtime Outcome Traceability Matrix (`R2-3`).
 * @param {string} qaDir
 */
export function buildRequirementTraceMatrix(qaDir) {
  const specsDir = path.join(qaDir, 'specs');
  const testsDir = path.join(qaDir, 'tests');
  const resultsPath = path.join(qaDir, 'reports', 'results.json');

  /** @type {Map<string, { reqId: string, title: string, specDoc: string, linkedTests: string[], status: string }>} */
  const requirements = new Map();

  const mdFiles = walkFilesByExt(
    specsDir,
    (n) => n.endsWith('.md') && !n.endsWith('.en.md') && n !== 'README.md'
  );
  for (const fullMd of mdFiles) {
    const relDoc = path.relative(qaDir, fullMd).replace(/\\/g, '/');
    const lines = fs.readFileSync(fullMd, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      for (const m of line.matchAll(REQ_ID_RE)) {
        const reqId = m[1];
        if (!requirements.has(reqId)) {
          const cleanTitle = line
            .replace(/^#+\s*/, '')
            .replace(/^[-*]\s*/, '')
            .replace(/\*\*/g, '')
            .trim()
            .slice(0, 140);
          requirements.set(reqId, {
            reqId,
            title: cleanTitle,
            specDoc: relDoc,
            linkedTests: [],
            status: 'uncovered',
          });
        }
      }
    }
  }

  const testFiles = walkFilesByExt(
    testsDir,
    (n) => /\.spec\.[jt]s$/.test(n) && n !== 'seed.spec.ts' && !n.endsWith('.official.example.ts')
  );
  const orphanTests = [];

  for (const fullSpec of testFiles) {
    const relSpec = path.relative(qaDir, fullSpec).replace(/\\/g, '/');
    const content = fs.readFileSync(fullSpec, 'utf8');
    const idsInSpec = [...new Set([...content.matchAll(REQ_ID_RE)].map((m) => m[1]))];
    if (idsInSpec.length === 0) {
      orphanTests.push(relSpec);
      continue;
    }
    for (const reqId of idsInSpec) {
      let rec = requirements.get(reqId);
      if (!rec) {
        rec = {
          reqId,
          title: '(Referenced in test without spec doc entry)',
          specDoc: 'undeclared',
          linkedTests: [],
          status: 'covered',
        };
        requirements.set(reqId, rec);
      }
      if (!rec.linkedTests.includes(relSpec)) {
        rec.linkedTests.push(relSpec);
      }
      rec.status = 'covered-unrun';
    }
  }

  // Overlay latest results.json outcomes if present
  if (fs.existsSync(resultsPath)) {
    try {
      const resultsObj = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
      const fileStatus = groupOutcomesBySpecFile(resultsObj);

      for (const rec of requirements.values()) {
        if (rec.linkedTests.length === 0) continue;
        let anyFail = false;
        let anyPass = false;
        for (const tf of rec.linkedTests) {
          const st = fileStatus.get(tf);
          if (!st) continue;
          if (st.failed > 0 || st.flaky > 0) anyFail = true;
          else if (st.passed > 0) anyPass = true;
        }
        if (anyFail) rec.status = 'failed';
        else if (anyPass) rec.status = 'passed';
      }
    } catch {
      // ignore malformed results
    }
  }

  const allReqs = [...requirements.values()].sort((a, b) => a.reqId.localeCompare(b.reqId));
  const coveredReqs = allReqs.filter((r) => r.linkedTests.length > 0);
  const uncoveredReqs = allReqs.filter((r) => r.linkedTests.length === 0).map((r) => r.reqId);

  return {
    schemaVersion: SCHEMA_VERSIONS.traceMatrix,
    generatedAt: new Date().toISOString(),
    totalRequirements: allReqs.length,
    coveredRequirements: coveredReqs.length,
    uncoveredRequirements: uncoveredReqs,
    coveragePct: allReqs.length > 0 ? Math.round((coveredReqs.length / allReqs.length) * 100) : 100,
    orphanSpecFiles: orphanTests,
    requirements: allReqs,
  };
}

/**
 * @param {{ generatedAt: string, coveredRequirements: number, totalRequirements: number, coveragePct: number, requirements: Array<{ reqId: string, specDoc: string, title: string, linkedTests: string[], status: string }> }} matrix
 * @param {string} [lang]
 * @returns {string}
 */
export function renderTraceMatrixMarkdown(matrix, lang = 'zh') {
  const isZh = lang === 'zh';
  const lines = [
    isZh ? '# 需求 ↔ 用例 ↔ 结果追溯矩阵 (`REQ-xxx`)' : '# Requirement ↔ Spec ↔ Outcome Traceability Matrix (`REQ-xxx`)',
    '',
    `- **Generated At**: \`${matrix.generatedAt}\` · **Coverage**: \`${matrix.coveredRequirements}/${matrix.totalRequirements}\` (**${matrix.coveragePct}%**)`,
    '',
    isZh
      ? '| 需求编号 | 规格来源 | 需求摘要 | 关联用例 | 状态 |'
      : '| Requirement ID | Spec Doc | Summary | Linked Specs | Status |',
    '|---|---|---|---|---|',
  ];
  for (const r of matrix.requirements) {
    lines.push(
      `| \`${r.reqId}\` | \`${r.specDoc}\` | ${r.title.replace(/\|/g, '\\|')} | ${r.linkedTests.map((t) => `\`${t}\``).join(', ') || '-'} | \`${r.status}\` |`
    );
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, dryRun?: boolean, force?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runTraceMatrixCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }
  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

  const matrix = buildRequirementTraceMatrix(qaDir);
  if (!options.dryRun) {
    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, 'trace-matrix.json'), JSON.stringify(matrix, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(reportsDir, 'trace-matrix.md'), renderTraceMatrixMarkdown(matrix, lang), 'utf8');
  }

  if (options.json) {
    console.log(JSON.stringify(matrix, null, 2));
    return 0;
  }
  console.log(
    `[Trace Matrix] ${matrix.coveredRequirements}/${matrix.totalRequirements} requirements covered (${matrix.coveragePct}%), orphanSpecs=${matrix.orphanSpecFiles.length}`
  );
  return 0;
}
