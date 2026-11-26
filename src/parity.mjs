// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { loadRuntimeConfig } from './core/runtime-config.mjs';
import { loadMergedQaEnv } from './origin-guard.mjs';
import { buildParityMarkdown, loadParityRequests, resolveParityPolicy } from './parity/normalizer.mjs';
import { executeParitySuite, validateDualTargetSafety } from './parity/runner.mjs';

export { buildParityMarkdown, loadParityRequests, resolveParityPolicy, validateDualTargetSafety };

/**
 * Programmatic dual-target differential parity runner (`WU-A`, `ADR-0006`).
 * @param {{
 *   lang?: string;
 *   target?: string;
 *   qaDir?: string;
 *   baselineUrl?: string;
 *   candidateUrl?: string;
 *   corpus?: string;
 *   routes?: string | string[];
 *   privacyMode?: string;
 *   strictByteEscape?: boolean;
 *   checkAria?: boolean;
 *   concurrency?: number;
 *   maxLatencyRatio?: number;
 *   maxTtftRatio?: number;
 *   allowMutation?: boolean;
 *   dryRun?: boolean;
 *   json?: boolean;
 * }} [options]
 */
export async function runParityCore(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    return { ok: false, outcome: /** @type {const} */ ('usage'), exitCode: 64, error: 'Missing --target option' };
  }
  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    return { ok: false, outcome: /** @type {const} */ ('fail'), exitCode: 1, error: `QA directory not found under ${options.target}` };
  }

  const wbCfg = loadWorkbenchConfig({ qaDir });
  if (!wbCfg.ok) {
    return {
      ok: false,
      outcome: /** @type {const} */ ('blocked'),
      exitCode: 2,
      blockerKind: 'CONFIG_BLOCKED',
      error: `[Config Blocked] ${wbCfg.errors.join('; ')}`,
      errors: wbCfg.errors,
    };
  }

  const runtimeCfgRes = loadRuntimeConfig(qaDir);
  const mergedEnv = loadMergedQaEnv(qaDir, process.env);
  const baselineUrl = String(options.baselineUrl || '').trim();
  const candidateUrl = String(
    options.candidateUrl || mergedEnv.TEST_BASE_URL || (runtimeCfgRes.ok ? runtimeCfgRes.config?.baseURL || '' : '')
  ).trim();

  if (!baselineUrl) {
    return { ok: false, outcome: /** @type {const} */ ('usage'), exitCode: 64, error: 'Missing required --baseline-url <url>' };
  }
  if (!candidateUrl) {
    return {
      ok: false,
      outcome: /** @type {const} */ ('blocked'),
      exitCode: 2,
      blockerKind: 'TARGET_GUARD_BLOCKED',
      error: 'Missing --candidate-url (or TEST_BASE_URL / aitest.runtime.json baseURL)',
    };
  }

  const safety = validateDualTargetSafety(qaDir, baselineUrl, candidateUrl, {
    ...(options.allowMutation !== undefined ? { allowMutation: options.allowMutation } : {}),
  });
  if (!safety.ok || !safety.baseGuard || !safety.candGuard) {
    return {
      ok: false,
      outcome: /** @type {const} */ ('blocked'),
      exitCode: 2,
      blockerKind: 'TARGET_GUARD_BLOCKED',
      error: `[Target Guard Blocked] ${safety.errors[0]}`,
      errors: safety.errors,
    };
  }

  const policy = resolveParityPolicy(qaDir, {
    strictByteEscape: options.strictByteEscape,
    maxLatencyRatio: options.maxLatencyRatio,
    maxTtftRatio: options.maxTtftRatio,
    privacyMode: options.privacyMode,
  });

  let reqSource;
  try {
    reqSource = loadParityRequests(qaDir, { corpus: options.corpus, routes: options.routes });
  } catch (err) {
    return {
      ok: false,
      outcome: /** @type {const} */ ('fail'),
      exitCode: 1,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  if (options.dryRun) {
    return {
      ok: true,
      outcome: /** @type {const} */ ('pass'),
      exitCode: 0,
      dryRun: true,
      baselineUrl,
      candidateUrl,
      inputSource: reqSource.source,
      plannedSamples: reqSource.requests.length,
      privacyMode: policy.privacyMode,
      strictByteEscape: policy.strictByteEscape,
      totalSamples: 0,
      matchedSamples: 0,
      mismatchedSamples: 0,
      parityPct: 100,
      cohortStats: {},
      clusters: [],
      perfWarnings: [],
      elapsedMs: 0,
    };
  }

  const suite = await executeParitySuite({
    qaDir,
    baselineUrl,
    candidateUrl,
    requests: reqSource.requests,
    baseGuard: safety.baseGuard,
    candGuard: safety.candGuard,
    policy,
    concurrency: options.concurrency,
    checkAria: Boolean(options.checkAria),
  });

  if (suite.blocked) {
    return {
      ok: false,
      outcome: /** @type {const} */ ('blocked'),
      exitCode: 2,
      blockerKind: 'TARGET_GUARD_BLOCKED',
      error: suite.errors[0] || 'Parity execution blocked by egress guard',
      errors: suite.errors,
    };
  }

  const report = {
    schemaVersion: 1,
    measuredAt: new Date().toISOString(),
    baselineUrl,
    candidateUrl,
    inputSource: reqSource.source,
    privacyMode: policy.privacyMode,
    strictByteEscape: policy.strictByteEscape,
    totalSamples: suite.totalSamples,
    matchedSamples: suite.matchedSamples,
    mismatchedSamples: suite.mismatchedSamples,
    parityPct: suite.parityPct,
    cohortStats: suite.cohortStats,
    clusters: suite.clusters,
    perfWarnings: suite.perfWarnings,
    elapsedMs: suite.elapsedMs,
  };

  const reportsDir = path.join(qaDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const reportJsonPath = path.join(reportsDir, 'parity-report.json');
  const summaryMdPath = path.join(reportsDir, 'parity-summary.md');
  fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.writeFileSync(summaryMdPath, buildParityMarkdown(report, lang), 'utf8');

  return {
    ok: suite.ok,
    outcome: /** @type {'pass' | 'fail'} */ (suite.ok ? 'pass' : 'fail'),
    exitCode: suite.ok ? 0 : 1,
    ...report,
    reportJsonPath,
    summaryMdPath,
  };
}

/**
 * CLI handler for `parity`.
 * @param {Record<string, any>} [options]
 * @returns {Promise<number>}
 */
export async function runParityCommand(options = {}) {
  const asJson = Boolean(options.json);
  const res = /** @type {Record<string, any>} */ (await runParityCore(options));
  const summary = res.error
    ? String(res.error)
    : res.dryRun
      ? `Parity dry-run planned ${res.plannedSamples} sample(s) (privacyMode=${res.privacyMode})`
      : `Parity ${res.parityPct}% (${res.matchedSamples}/${res.totalSamples}, clusters=${res.clusters?.length ?? 0}, ${res.elapsedMs}ms)`;

  if (!asJson) {
    if (res.error) console.error(res.error);
    else {
      console.log(`[Parity] ${summary}`);
      if (res.reportJsonPath) console.log(`  Parity JSON    : ${res.reportJsonPath}`);
      if (res.summaryMdPath) console.log(`  Parity Summary : ${res.summaryMdPath}`);
    }
  }

  return emitCommandResult(
    buildCommandResult({
      tool: 'parity',
      outcome: res.outcome,
      ok: Boolean(res.ok),
      exitCode: res.exitCode,
      summary,
      blockerKind: res.blockerKind || (res.exitCode === 64 ? 'USAGE_ERROR' : null),
      data: res,
    }),
    { asJson, compatSpreadData: !res.error }
  );
}
