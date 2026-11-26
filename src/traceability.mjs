// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { flattenPlaywrightResults, groupOutcomesBySpecFile } from './core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';
import { sha256Hex } from './kernel/gate-kernel.mjs';

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
 * Verifies whether `reports/results.json` matches `.aitest/runs/latest.json` and the corresponding
 * Run Ledger `manifest.json#resultsSha256` digest without throwing on missing/corrupt ledger files.
 * @param {string} qaDir
 * @param {string} rawResultsText
 * @returns {{ runId: string | null, ledgerBound: boolean }}
 */
function checkResultsLedgerBinding(qaDir, rawResultsText) {
  const latestPath = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  if (!fs.existsSync(latestPath)) {
    return { runId: null, ledgerBound: false };
  }
  try {
    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
    const candidateRunId = typeof latest?.runId === 'string' && latest.runId.trim() ? latest.runId.trim() : null;
    if (!candidateRunId) return { runId: null, ledgerBound: false };
    const manifestPath = path.join(qaDir, '.aitest', 'runs', candidateRunId, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return { runId: null, ledgerBound: false };
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const actualSha = `sha256:${sha256Hex(rawResultsText)}`;
    const manifestMatches = typeof manifest?.resultsSha256 === 'string' && manifest.resultsSha256 === actualSha;
    const latestMatches = !latest.resultsSha256 || latest.resultsSha256 === actualSha;
    if (manifestMatches && latestMatches) {
      return { runId: candidateRunId, ledgerBound: true };
    }
    return { runId: null, ledgerBound: false };
  } catch {
    return { runId: null, ledgerBound: false };
  }
}

/**
 * Extracts `REQ-xxx` IDs from a Playwright test case, preferring individual test title (`specTitle`)
 * over ancestor `describe` titles so two tests in the same file never cross-contaminate status.
 * @param {{ specTitle?: string, title?: string }} testRecord
 * @returns {string[]}
 */
function extractTestCaseReqIds(testRecord) {
  const specIds = [...new Set([...String(testRecord.specTitle || '').matchAll(REQ_ID_RE)].map((m) => m[1]))];
  if (specIds.length > 0) return specIds;
  return [...new Set([...String(testRecord.title || '').matchAll(REQ_ID_RE)].map((m) => m[1]))];
}

/**
 * Builds the Requirement <-> Spec <-> Runtime Outcome Traceability Matrix (`R2-3`, `v6.3`).
 * Prefers test-case-level `REQ-xxx` outcome mapping over whole-file aggregation and verifies
 * `results.json` binding against the latest Run Ledger manifest (`runId`, `ledgerBound`).
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

  /** @type {string | null} */
  let runId = null;
  let ledgerBound = false;

  // Overlay latest results.json outcomes if present (test-case REQ-xxx first, file-level fallback)
  if (fs.existsSync(resultsPath)) {
    try {
      const rawResultsText = fs.readFileSync(resultsPath, 'utf8');
      const binding = checkResultsLedgerBinding(qaDir, rawResultsText);
      runId = binding.runId;
      ledgerBound = binding.ledgerBound;

      const resultsObj = JSON.parse(rawResultsText);
      const flatTests = flattenPlaywrightResults(resultsObj);
      const fileStatus = groupOutcomesBySpecFile(resultsObj);

      /** @type {Map<string, { passed: number, failed: number, flaky: number, skipped: number }>} */
      const reqCaseStatus = new Map();
      for (const t of flatTests) {
        const reqIds = extractTestCaseReqIds(t);
        for (const reqId of reqIds) {
          const cur = reqCaseStatus.get(reqId) || { passed: 0, failed: 0, flaky: 0, skipped: 0 };
          if (t.status === 'expected') cur.passed += 1;
          else if (t.status === 'unexpected') cur.failed += 1;
          else if (t.status === 'flaky') cur.flaky += 1;
          else if (t.status === 'skipped') cur.skipped += 1;
          reqCaseStatus.set(reqId, cur);
        }
      }

      for (const rec of requirements.values()) {
        if (rec.linkedTests.length === 0) continue;
        const caseSt = reqCaseStatus.get(rec.reqId);
        if (caseSt && caseSt.passed + caseSt.failed + caseSt.flaky > 0) {
          if (caseSt.failed > 0 || caseSt.flaky > 0) rec.status = 'failed';
          else if (caseSt.passed > 0) rec.status = 'passed';
          continue;
        }
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
    runId,
    ledgerBound,
    totalRequirements: allReqs.length,
    coveredRequirements: coveredReqs.length,
    uncoveredRequirements: uncoveredReqs,
    coveragePct: allReqs.length > 0 ? Math.round((coveredReqs.length / allReqs.length) * 100) : 100,
    orphanSpecFiles: orphanTests,
    requirements: allReqs,
  };
}

/**
 * @param {{ generatedAt: string, runId?: string | null, ledgerBound?: boolean, coveredRequirements: number, totalRequirements: number, coveragePct: number, requirements: Array<{ reqId: string, specDoc: string, title: string, linkedTests: string[], status: string }> }} matrix
 * @param {string} [lang]
 * @returns {string}
 */
export function renderTraceMatrixMarkdown(matrix, lang = 'zh') {
  const isZh = lang === 'zh';
  const ledgerBadge = matrix.ledgerBound
    ? `bound (\`runId=${matrix.runId}\`)`
    : isZh
      ? 'unbound（未绑定最新 Run Ledger 摘要）'
      : 'unbound (results.json not bound to latest Run Ledger)';
  const lines = [
    isZh ? '# 需求 ↔ 用例 ↔ 结果追溯矩阵 (`REQ-xxx`)' : '# Requirement ↔ Spec ↔ Outcome Traceability Matrix (`REQ-xxx`)',
    '',
    `- **Generated At**: \`${matrix.generatedAt}\` · **Coverage**: \`${matrix.coveredRequirements}/${matrix.totalRequirements}\` (**${matrix.coveragePct}%**) · **Run Ledger**: ${ledgerBadge}`,
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
  const asJson = Boolean(options.json);
  /** @param {string} msg */
  const failTrace = (msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'trace-matrix', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) {
    return failTrace(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }
  const qaDir = resolveQaDirectory(path.resolve(options.target), options.qaDir);
  if (!qaDir) {
    return failTrace(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  const matrix = buildRequirementTraceMatrix(qaDir);
  if (!options.dryRun) {
    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    fs.writeFileSync(path.join(reportsDir, 'trace-matrix.json'), JSON.stringify(matrix, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(reportsDir, 'trace-matrix.md'), renderTraceMatrixMarkdown(matrix, lang), 'utf8');
  }

  if (!options.json) {
    console.log(
      `[Trace Matrix] ${matrix.coveredRequirements}/${matrix.totalRequirements} requirements covered (${matrix.coveragePct}%), orphanSpecs=${matrix.orphanSpecFiles.length}, ledgerBound=${matrix.ledgerBound}`
    );
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'trace-matrix',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary: `${matrix.coveredRequirements}/${matrix.totalRequirements} requirements covered (${matrix.coveragePct}%, ledgerBound=${matrix.ledgerBound})`,
      data: matrix,
    }),
    { asJson: Boolean(options.json) }
  );
}
