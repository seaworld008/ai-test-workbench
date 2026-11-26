// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from '../../agents.mjs';
import { redactSecrets, redactStructuredValue } from '../../core/redact.mjs';
import { generateDiagnosticsMarkdown } from '../../diagnose.mjs';
import { collectDoctorReport } from '../../doctor.mjs';
import { computeFlakyReport } from '../../flaky.mjs';
import { computeImpact } from '../../impact.mjs';
import { collectLessonsReport } from '../../learn.mjs';
import { runMcpDoctorReadOnly } from '../../mcp-hub/auditor.mjs';
import { getMcpPresetsSummary } from '../../mcp-hub/catalog.mjs';
import { collectReportArtifacts } from '../../report.mjs';
import { buildRequirementTraceMatrix } from '../../traceability.mjs';

/**
 * Pure read-only in-process MCP fast path for `aitest_doctor`.
 * Runs strictly AFTER `validateToolArguments` and `validateToolPathArgs` workspace boundary checks,
 * avoiding child-process cold start while scrubbing output via `redactStructuredValue`.
 * @param {Record<string, any>} _args
 * @param {import('./shared.mjs').ToolExecContext} ctx
 * @returns {Promise<import('./shared.mjs').InMemoryToolOutcome | null>}
 */
export async function executeDoctorReadOnlyFastPath(_args, ctx) {
  try {
    ctx.onProgress?.({ progress: 10, message: 'Probing Node.js, npm, Git, browser cache & Gate Kernel readiness...' });
    const report = await collectDoctorReport({
      target: ctx.target || undefined,
      lang: ctx.lang,
    });
    ctx.onProgress?.({ progress: 100, message: redactSecrets(report.summary) });
    const safeData = redactStructuredValue({
      ok: report.ok,
      failCount: report.failCount,
      warnCount: report.warnCount,
      checks: report.checks,
    });
    return {
      ok: report.ok,
      exitCode: report.exitCode,
      outcome: report.ok ? 'pass' : 'fail',
      summary: redactSecrets(report.summary),
      data: safeData,
      nextActions: report.nextRecommendedActions.map((s) => redactSecrets(s)),
    };
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
}

/**
 * Pure read-only in-process MCP fast path for `aitest_mcp_hub` when `action === 'presets'`
 * or read-only `action === 'doctor' && !args.lock`.
 * Mutating calls (`action === 'add'` or `args.lock === true`) return `null` so they run under `McpJobManager`.
 * @param {Record<string, any>} args
 * @param {import('./shared.mjs').ToolExecContext} ctx
 * @returns {Promise<import('./shared.mjs').InMemoryToolOutcome | null>}
 */
export async function executeMcpHubReadOnlyFastPath(args, ctx) {
  const action = String(args.action || 'presets').toLowerCase();
  if (action === 'presets') {
    return {
      ok: true,
      exitCode: 0,
      outcome: 'pass',
      summary: 'Listed 7-pillar pinned MCP presets',
      data: redactStructuredValue(getMcpPresetsSummary()),
    };
  }
  if (action !== 'doctor' || Boolean(args.lock)) {
    return null;
  }
  if (!ctx.target) {
    const msg = ctx.lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option';
    return { ok: false, exitCode: 64, outcome: 'usage', blockerKind: 'USAGE_ERROR', summary: msg, data: { action: 'doctor', error: msg } };
  }
  const qaDir = resolveQaDirectory(path.resolve(ctx.target), args.qaDir);
  if (!qaDir) {
    const msg = redactSecrets(ctx.lang === 'zh' ? `未找到 QA 目录: ${ctx.target}` : `QA directory not found: ${ctx.target}`);
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { action: 'doctor', error: msg } };
  }

  const res = runMcpDoctorReadOnly(qaDir, { ignoreLock: false });
  ctx.onProgress?.({ progress: 100, message: 'MCP Hub supply-chain audit completed' });
  if (res.error || !res.audit) {
    const msg = redactSecrets(res.error || 'Malformed .mcp.json');
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { action: 'doctor', error: msg } };
  }
  const audit = res.audit;
  const summary = audit.ok
    ? `MCP doctor audited ${audit.checkedServers.length} server(s): OK`
    : audit.issues[0] || `MCP doctor blocked (${audit.issues.length} issue(s))`;
  return {
    ok: res.ok,
    exitCode: res.exitCode,
    outcome: res.outcome,
    summary: redactSecrets(summary),
    data: redactStructuredValue({ ...audit, mcpLockPath: res.mcpLockPath }),
  };
}

/**
 * Pure read-only in-process MCP fast path for `aitest_diagnose` strictly when `args.dryRun === true`.
 * Non-dry-run calls return `null` so writing `reports/ai-diagnostics.md` stays isolated under workspace lock.
 * @param {Record<string, any>} args
 * @param {import('./shared.mjs').ToolExecContext} ctx
 * @returns {Promise<import('./shared.mjs').InMemoryToolOutcome | null>}
 */
export async function executeDiagnoseDryRunFastPath(args, ctx) {
  if (args.dryRun !== true) {
    return null;
  }
  if (!ctx.target) {
    const msg = ctx.lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option';
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
  const qaDir = resolveQaDirectory(path.resolve(ctx.target), args.qaDir);
  if (!qaDir) {
    const msg = redactSecrets(ctx.lang === 'zh' ? `未在 ${ctx.target} 找到 QA 目录` : `QA directory not found under ${ctx.target}`);
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
  const resultsPath = args.results
    ? path.resolve(qaDir, args.results)
    : path.join(qaDir, 'reports', 'results.json');
  if (!fs.existsSync(resultsPath)) {
    const msg = redactSecrets(ctx.lang === 'zh' ? `未找到测试结果文件: ${resultsPath}` : `Results JSON not found: ${resultsPath}`);
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
  try {
    ctx.onProgress?.({ progress: 10, message: 'Analyzing failure diagnostics (dry-run)...' });
    const { failureCount, failures, clusters } = generateDiagnosticsMarkdown(qaDir, resultsPath);
    ctx.onProgress?.({ progress: 100, message: `Diagnosed ${failureCount} failing/flaky test(s)` });
    const safeData = redactStructuredValue({
      failureCount,
      clusterCount: clusters.length,
      clusters,
      failures,
      resultsPath,
      outputPath: null,
    });
    return {
      ok: true,
      exitCode: 0,
      outcome: 'pass',
      summary: redactSecrets(`Diagnosed ${failureCount} failing/flaky test(s) from results.json`),
      data: safeData,
    };
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
}

/**
 * Pure read-only in-process MCP fast path for `aitest_impact`.
 * Runs strictly AFTER `validateToolArguments` and `validateToolPathArgs` workspace boundary checks,
 * avoiding ~150ms child-process cold start while scrubbing output via `redactStructuredValue`.
 * @param {Record<string, any>} args
 * @param {import('./shared.mjs').ToolExecContext} ctx
 * @returns {Promise<import('./shared.mjs').InMemoryToolOutcome | null>}
 */
export async function executeImpactReadOnlyFastPath(args, ctx) {
  if (!ctx.target) {
    const msg = ctx.lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option';
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
  try {
    ctx.onProgress?.({ progress: 10, message: 'Computing dependency-graph impact scope...' });
    const explicitFiles = args.files
      ? String(args.files)
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
    const impact = await computeImpact(ctx.target, {
      qaDir: args.qaDir,
      base: args.base,
      files: explicitFiles,
      repos: Array.isArray(args.repos) ? args.repos : undefined,
    });
    const safeData = redactStructuredValue(impact);
    ctx.onProgress?.({ progress: 100, message: `Impact mode=${safeData.mode}` });
    return {
      ok: true,
      exitCode: 0,
      outcome: 'pass',
      summary: redactSecrets(
        `Impact mode=${safeData.mode} (${safeData.specs.length} targeted spec(s), ${safeData.changedFiles.length} changed file(s))`
      ),
      data: safeData,
    };
  } catch (err) {
    const msg = redactSecrets(err instanceof Error ? err.message : String(err));
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
}

/**
 * Pure read-only in-process MCP fast path for `aitest_report` when `!args.syncQuarantine`.
 * Mutating `syncQuarantine=true` calls return `null` so they remain isolated in `McpJobManager`.
 * @param {Record<string, any>} args
 * @param {import('./shared.mjs').ToolExecContext} ctx
 * @returns {Promise<import('./shared.mjs').InMemoryToolOutcome | null>}
 */
export async function executeReportReadOnlyFastPath(args, ctx) {
  if (args.syncQuarantine) {
    return null;
  }
  if (!ctx.target) {
    const msg = ctx.lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option';
    return { ok: false, exitCode: 1, outcome: 'fail', summary: msg, data: { error: msg } };
  }
  const view = String(args.view || 'artifacts').toLowerCase();
  const qaDir = resolveQaDirectory(path.resolve(ctx.target), args.qaDir);
  if (!qaDir) {
    const msg = ctx.lang === 'zh' ? `未找到 QA 目录: ${ctx.target}` : `QA directory not found: ${ctx.target}`;
    return { ok: false, exitCode: 1, outcome: 'fail', summary: redactSecrets(msg), data: { error: redactSecrets(msg) } };
  }

  if (view === 'flaky') {
    const report = computeFlakyReport(qaDir);
    const data = redactStructuredValue({ view: 'flaky', ...report, syncResult: null });
    return {
      ok: true,
      exitCode: 0,
      outcome: 'pass',
      summary: redactSecrets(
        `Runs analyzed=${report.runsAnalyzed}, flakyCandidates=${report.flakyCandidates.length}, quarantined=${report.quarantineEntries.length}`
      ),
      data,
    };
  }

  if (view === 'traceability' || view === 'trace-matrix') {
    const matrix = buildRequirementTraceMatrix(qaDir);
    const data = redactStructuredValue({ view: 'traceability', ...matrix });
    return {
      ok: true,
      exitCode: 0,
      outcome: 'pass',
      summary: redactSecrets(
        `${matrix.coveredRequirements}/${matrix.totalRequirements} requirements covered (${matrix.coveragePct}%, ledgerBound=${matrix.ledgerBound})`
      ),
      data,
    };
  }

  if (view === 'lessons') {
    const lessons = collectLessonsReport(qaDir);
    const data = redactStructuredValue(lessons);
    return {
      ok: true,
      exitCode: 0,
      outcome: 'pass',
      summary: redactSecrets(
        `Lessons view: ${lessons.clusters.length} cluster(s), ${lessons.openBlockerCount} open blocker(s), ${lessons.sealedProjectRules.length} sealed rule(s)`
      ),
      data,
    };
  }

  if (view === 'summary' || view === 'artifacts') {
    const { payload, hasAny } = collectReportArtifacts(qaDir, { view });
    const safeData = redactStructuredValue(payload);
    return {
      ok: hasAny,
      exitCode: hasAny ? 0 : 1,
      outcome: hasAny ? 'pass' : 'fail',
      summary: hasAny
        ? redactSecrets(`Indexed QA ${safeData.view} (${safeData.traces.length} trace(s), results=${Boolean(safeData.resultsJson)})`)
        : 'No test reports or artifacts found yet in QA workspace.',
      data: safeData,
    };
  }

  const msg = `Invalid --view "${view}". Use: summary | artifacts | flaky | traceability | lessons`;
  return { ok: false, exitCode: 64, outcome: 'usage', blockerKind: 'USAGE_ERROR', summary: msg, data: { error: msg } };
}
