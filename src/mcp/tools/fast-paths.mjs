// @ts-check
import path from 'node:path';
import { resolveQaDirectory } from '../../agents.mjs';
import { redactSecrets, redactStructuredValue } from '../../core/redact.mjs';
import { computeFlakyReport } from '../../flaky.mjs';
import { computeImpact } from '../../impact.mjs';
import { collectReportArtifacts } from '../../report.mjs';
import { buildRequirementTraceMatrix } from '../../traceability.mjs';

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
    });
    const safeData = redactStructuredValue(impact);
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

  const msg = `Invalid --view "${view}". Use: summary | artifacts | flaky | traceability`;
  return { ok: false, exitCode: 64, outcome: 'usage', blockerKind: 'USAGE_ERROR', summary: msg, data: { error: msg } };
}
