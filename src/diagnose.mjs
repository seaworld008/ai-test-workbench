// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { flattenPlaywrightResults } from './core/playwright-results.mjs';
import { redactSecrets } from './core/redact.mjs';
import {
  extractQueryableTraceId,
  parsePlaywrightErrorEvidence,
  selectFirstFailedAttempt,
  suggestFailureCategory,
} from './diagnose/classifier.mjs';
import { correlateFailureWithFrontendDiff } from './diagnose/diff-correlator.mjs';
import { classifyFailureRegressionHistory, createRegressionHistoryClassifier } from './diagnose/history.mjs';

export {
  classifyFailureRegressionHistory,
  correlateFailureWithFrontendDiff,
  extractQueryableTraceId,
  parsePlaywrightErrorEvidence,
  selectFirstFailedAttempt,
  suggestFailureCategory,
};

/**
 * @typedef {{
 *   testId: string,
 *   title: string,
 *   file: string,
 *   line: number,
 *   projectName: string,
 *   status: string,
 *   regressionHistory: import('./diagnose/history.mjs').RegressionHistoryKind,
 *   categoryCode: string,
 *   subCategory?: string | null,
 *   category: string,
 *   confidence: string,
 *   candidates: string[],
 *   repairPermitted?: boolean,
 *   diffEvidence?: { matchedTokens: string[], changedFiles: string[] } | null,
 *   evidence: string[],
 *   guidance: string,
 *   traceId: string | null,
 *   traceIds: string[],
 *   traceZipPath: string | null,
 *   timeWindow: { startedAt?: string, finishedAt?: string } | null,
 *   errorSnippet: string,
 *   codeCorrelation: {
 *     routes: string[],
 *     frontendFiles: string[],
 *     backendFiles: string[],
 *     dbTables: string[],
 *     apis: string[],
 *   } | null,
 * }} DiagnosedFailure
 */

/**
 * @param {Record<string, any>} resultObj
 * @param {string} qaDir
 */
function extractAttachmentsAndErrorContext(resultObj, qaDir) {
  /** @type {string | null} */
  let tracePath = null;
  /** @type {string | null} */
  let errorContextText = null;
  /** @type {string[]} */
  let traceIds = [];
  /** @type {string | null} */
  let injectedTraceId = null;
  /** @type {{ startedAt?: string, finishedAt?: string } | null} */
  let timeWindow = null;
  /** @type {{ serverErrors: string[], blockedRequests: string[], pageErrors: string[] } | null} */
  let guardSignals = null;

  for (const att of resultObj.attachments || []) {
    let parsedGuard = null;
    if (att.name === 'workbench-runtime-guard.json' || att.name === 'workbench-trace-context.json') {
      try {
        if (att.body) {
          parsedGuard = JSON.parse(Buffer.from(att.body, 'base64').toString('utf8'));
        } else if (att.path) {
          const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
          if (fs.existsSync(resolved)) parsedGuard = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        }
      } catch {
        parsedGuard = null;
      }
      if (parsedGuard) {
        if (Array.isArray(parsedGuard.traceIds)) traceIds.push(...parsedGuard.traceIds);
        if (parsedGuard.injectedTraceId) injectedTraceId = parsedGuard.injectedTraceId;
        if (parsedGuard.timeWindow) timeWindow = parsedGuard.timeWindow;
        if (att.name === 'workbench-runtime-guard.json') {
          guardSignals = {
            serverErrors: parsedGuard.serverErrors || [],
            blockedRequests: parsedGuard.blockedRequests || [],
            pageErrors: parsedGuard.pageErrors || [],
          };
        }
      }
    }

    if (!att.path) continue;
    const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
    if (att.name === 'trace' || resolved.endsWith('trace.zip')) {
      tracePath = resolved;
    }
    if ((att.name === 'error-context' || resolved.endsWith('error-context.md')) && fs.existsSync(resolved)) {
      errorContextText = fs.readFileSync(resolved, 'utf8');
    }
  }

  if (!errorContextText && tracePath) {
    const candidate = path.join(path.dirname(tracePath), 'error-context.md');
    if (fs.existsSync(candidate)) {
      errorContextText = fs.readFileSync(candidate, 'utf8');
    }
  }

  return {
    tracePath,
    errorContextText,
    traceIds: [...new Set(traceIds)],
    injectedTraceId,
    timeWindow,
    guardSignals,
  };
}

/**
 * @param {string} qaDir
 * @param {string} specFile
 */
function loadCodeMapCorrelations(qaDir, specFile) {
  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (!fs.existsSync(cmPath)) return null;
  try {
    const cm = JSON.parse(fs.readFileSync(cmPath, 'utf8'));
    const normalizedSpec = String(specFile || '').replace(/\\/g, '/');
    const matchedRoutes = Object.values(cm.routes || {}).filter((r) =>
      (r.coveringSpecs || []).some((/** @type {string} */ s) => normalizedSpec.endsWith(s) || s.endsWith(normalizedSpec))
    );
    if (matchedRoutes.length === 0) return null;
    return {
      routes: /** @type {string[]} */ (matchedRoutes.map((r) => r.route)),
      frontendFiles: /** @type {string[]} */ ([...new Set(matchedRoutes.map((r) => r.frontendFile).filter(Boolean))]),
      backendFiles: /** @type {string[]} */ ([...new Set(matchedRoutes.flatMap((r) => r.linkedBackendFiles || []))]),
      dbTables: /** @type {string[]} */ ([...new Set(matchedRoutes.flatMap((r) => r.linkedDbTables || []))]),
      apis: /** @type {string[]} */ ([...new Set(matchedRoutes.flatMap((r) => r.linkedApis || []))]),
    };
  } catch {
    return null;
  }
}

/**
 * Structured failure diagnosis returning both Markdown report and typed `diagnosedFailures` array (`D-01..D-03`).
 * @param {string} qaDir
 * @param {string} resultsPath
 * @returns {{ failureCount: number, failures: DiagnosedFailure[], markdown: string }}
 */
export function generateDiagnosticsMarkdown(qaDir, resultsPath) {
  if (!fs.existsSync(resultsPath)) {
    throw new Error(`Results file not found: ${resultsPath}`);
  }
  const rawResultsText = fs.readFileSync(resultsPath, 'utf8');
  const resultsJson = JSON.parse(rawResultsText);
  const classifyRegressionHistory = createRegressionHistoryClassifier(qaDir, rawResultsText, resultsJson);
  const failures = flattenPlaywrightResults(resultsJson)
    .filter((t) => t.status === 'unexpected' || t.status === 'flaky' || t.retryPassed)
    .map((t) => ({
      testId: t.testId,
      title: t.title,
      file: t.file || 'unknown',
      line: t.line,
      projectName: t.projectName,
      status: t.status,
      results: t.results,
    }));

  const lines = [
    '# AI Test Workbench — Failure Diagnostics Summary (Redacted)',
    '',
    `> Generated at: ${new Date().toISOString()}`,
    '> **Security & Governance Notice**: Credentials in text snippets are automatically redacted, but raw `trace.zip` and video files may still contain rendered session data — treat report directories as sensitive artifacts.',
    '> **Triage Notice**: Categories below follow evidence-first runtime-guard + matcher triage (Class C value regressions always take precedence over locator Call log). Use `aitest_heal(action="begin")` to enforce A/B/C/D governance; NEVER use `test.skip`, `test.fixme`, or assertion weakening.',
    '',
  ];

  if (failures.length === 0) {
    lines.push('No unexpected or flaky test failures found in `results.json`.');
    return { failureCount: 0, failures: /** @type {DiagnosedFailure[]} */ ([]), markdown: lines.join('\n') + '\n' };
  }

  lines.push(`Total Failing / Flaky Specs: **${failures.length}**`, '');
  /** @type {DiagnosedFailure[]} */
  const diagnosedFailures = [];

  failures.forEach((f, idx) => {
    // Pick FIRST failed attempt so flaky tests that pass on retry retain their original failure evidence (`D-03`)!
    const failedResult = selectFirstFailedAttempt(f.results);
    const primaryErrObj = failedResult.error || (failedResult.errors || [])[0] || null;
    const rawErr =
      failedResult.error?.stack ||
      failedResult.error?.message ||
      (failedResult.errors || []).map((/** @type {any} */ e) => e.stack || e.message).join('\n') ||
      'No error message recorded';
    const cleanErr = redactSecrets(rawErr);
    const { tracePath, errorContextText, traceIds, injectedTraceId, timeWindow, guardSignals } =
      extractAttachmentsAndErrorContext(failedResult, qaDir);
    let triage = suggestFailureCategory(cleanErr, guardSignals, primaryErrObj);
    const diffCorr = correlateFailureWithFrontendDiff(path.dirname(qaDir), triage, cleanErr, guardSignals);
    let subCategory = null;
    let diffEvidence = null;
    if (diffCorr.matched) {
      subCategory = 'A-UI-Sync';
      diffEvidence = {
        matchedTokens: diffCorr.matchedTokens || [],
        changedFiles: diffCorr.changedFiles || [],
      };
      triage = {
        ...triage,
        categoryCode: 'A',
        category: 'A (A-UI-Sync: Frontend Diff Matched Locator / Copy Update)',
        confidence: 'high',
        guidance: `Matched frontend source diff (${diffEvidence.changedFiles.join(', ')} -> [${diffEvidence.matchedTokens.join(', ')}]); Class A-UI-Sync permits updating selector/copy via aitest_heal(action="begin").`,
      };
    }
    const codeCorr = loadCodeMapCorrelations(qaDir, f.file);
    const queryTraceId = injectedTraceId || (traceIds[0] ? extractQueryableTraceId(traceIds[0]) : '<trace-id>');
    const normFile = String(f.file || '').replace(/\\/g, '/');
    const testId = f.testId || `${normFile}::${String(f.title || '').replace(/\\/g, '/')}`;
    const regressionHistory = classifyRegressionHistory(testId, f.status);

    diagnosedFailures.push({
      testId,
      title: redactSecrets(f.title),
      file: normFile,
      line: f.line,
      projectName: f.projectName,
      status: f.status,
      regressionHistory,
      categoryCode: triage.categoryCode,
      subCategory,
      category: triage.category,
      confidence: triage.confidence,
      candidates: triage.candidates,
      repairPermitted: triage.categoryCode === 'A',
      diffEvidence,
      evidence: triage.evidence || [],
      guidance: triage.guidance,
      traceId: queryTraceId === '<trace-id>' ? null : queryTraceId,
      traceIds: traceIds.map((id) => extractQueryableTraceId(id)),
      traceZipPath: tracePath,
      timeWindow,
      errorSnippet: cleanErr.slice(0, 800),
      codeCorrelation: codeCorr,
    });

    lines.push(`## ${idx + 1}. ${redactSecrets(f.title)}`);
    lines.push(`- **Test ID**: \`${redactSecrets(testId)}\``);
    lines.push(`- **Location**: \`${normFile}:${f.line}\` (project: \`${f.projectName}\`, status: \`${f.status}\`)`);
    lines.push(
      `- **Suggested Category**: **${triage.category}** *(confidence: ${triage.confidence}, candidates: ${triage.candidates.join('/')})*`
    );
    lines.push(`- **Regression History**: \`${regressionHistory}\``);
    lines.push(`- **Action Guidance**: ${triage.guidance}`);
    if (timeWindow) {
      lines.push(`- **Test Time Window**: \`${timeWindow.startedAt}\` → \`${timeWindow.finishedAt}\``);
    }
    if (traceIds.length > 0 || injectedTraceId) {
      lines.push(`- **Queryable 32-char Trace ID**: \`${queryTraceId}\``);
      lines.push(
        `- **Captured Trace Headers**: ${traceIds
          .slice(0, 6)
          .map((id) => `\`${redactSecrets(id)}\``)
          .join(', ')}`
      );
    }
    if (tracePath) {
      lines.push(`- **Trace Replay**: \`npx playwright show-trace "${tracePath}"\``);
    }

    if (codeCorr || traceIds.length > 0 || injectedTraceId || timeWindow) {
      lines.push('', '### Full-Link Code Map & Multi-MCP Root-Cause Playbook');
      if (codeCorr) {
        if (codeCorr.routes.length > 0) lines.push(`- **CodeMap Routes**: ${codeCorr.routes.map((r) => `\`${r}\``).join(', ')}`);
        if (codeCorr.frontendFiles.length > 0)
          lines.push(`- **Frontend Source**: ${codeCorr.frontendFiles.map((s) => `\`${s}\``).join(', ')}`);
        if (codeCorr.backendFiles.length > 0)
          lines.push(`- **Backend Controllers**: ${codeCorr.backendFiles.map((s) => `\`${s}\``).join(', ')}`);
        if (codeCorr.dbTables.length > 0)
          lines.push(`- **Linked DB Entities**: ${codeCorr.dbTables.map((t) => `\`${t}\``).join(', ')}`);
      }
      lines.push(
        `- **Loki / Tempo MCP Query**: \`{env=~"staging|test"} |= "${queryTraceId}"\``,
        `- **Prometheus MCP Query**: \`sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))\``,
        `- **Sentry MCP**: filter unresolved issues within \`${timeWindow?.startedAt || 'last 15m'}\` to \`${timeWindow?.finishedAt || 'now'}\``
      );
      if (codeCorr?.dbTables && codeCorr.dbTables.length > 0 && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(codeCorr.dbTables[0])) {
        lines.push(`- **Read-Only DB MCP Check**: \`SELECT COUNT(*) FROM ${codeCorr.dbTables[0]} LIMIT 1;\``);
      }
    }

    lines.push('', '### Error Snippet (Redacted)', '```text', cleanErr.slice(0, 2500), '```', '');

    if (errorContextText) {
      lines.push(
        '### Official Playwright `error-context.md` (Redacted ARIA Snapshot)',
        '```markdown',
        redactSecrets(errorContextText).slice(0, 3500),
        '```',
        ''
      );
    }
  });

  return { failureCount: failures.length, failures: diagnosedFailures, markdown: lines.join('\n') + '\n' };
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, results?: string, output?: string, dryRun?: boolean, force?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runDiagnoseCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {string} msg */
  const failDiag = (msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'diagnose', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) {
    return failDiag(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    return failDiag(lang === 'zh' ? `未在 ${options.target} 找到 QA 目录` : `QA directory not found under ${options.target}`);
  }

  const resultsPath = options.results
    ? path.resolve(qaDir, options.results)
    : path.join(qaDir, 'reports', 'results.json');
  const outPath = options.output
    ? path.resolve(qaDir, options.output)
    : path.join(qaDir, 'reports', 'ai-diagnostics.md');

  if (!fs.existsSync(resultsPath)) {
    return failDiag(lang === 'zh' ? `未找到测试结果文件: ${resultsPath}` : `Results JSON not found: ${resultsPath}`);
  }

  const { failureCount, failures, markdown } = generateDiagnosticsMarkdown(qaDir, resultsPath);
  if (!options.dryRun) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, markdown, 'utf8');
  }

  const payload = {
    failureCount,
    failures,
    resultsPath,
    outputPath: options.dryRun ? null : outPath,
  };
  if (!options.json) {
    console.log(
      lang === 'zh'
        ? `[Diagnose] 已生成脱敏诊断简报 (${failureCount} 条异常/波动): ${outPath}`
        : `[Diagnose] Wrote redacted diagnostics report (${failureCount} failing/flaky): ${outPath}`
    );
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'diagnose',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary: `Diagnosed ${failureCount} failing/flaky test(s) from results.json`,
      data: payload,
    }),
    { asJson: Boolean(options.json) }
  );
}
