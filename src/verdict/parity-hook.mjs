// @ts-check
import { runParityCore } from '../parity.mjs';

/**
 * Optional differential parity oracle hook executed inside `verifyChangeCore` when
 * `mode === 'parity'` or `--baseline-url` is supplied (`WU-A`, `ADR-0006`).
 * Catches `S5 -> S5` literal-catering spec tampering against a live Baseline server.
 *
 * @param {{
 *   target: string;
 *   qaDir?: string;
 *   lang: 'zh' | 'en';
 *   requestedMode: string;
 *   effectiveBaseUrl: string | null;
 *   options: Record<string, any>;
 * }} params
 */
export async function runVerdictParityHook(params) {
  const { target, qaDir, lang, requestedMode, effectiveBaseUrl, options } = params;
  const baselineUrl = options.baselineUrl ? String(options.baselineUrl).trim() : '';
  const enabled = requestedMode === 'parity' || Boolean(baselineUrl);
  if (!enabled) return null;

  if (!baselineUrl) {
    return {
      ok: false,
      blocked: true,
      gateStatus: /** @type {const} */ ('blocked'),
      errors: [
        '[Verify Change Blocked] Differential parity mode requires --baseline-url <url> alongside candidate --base-url.',
      ],
      paritySummary: null,
    };
  }
  if (!effectiveBaseUrl) {
    return {
      ok: false,
      blocked: true,
      gateStatus: /** @type {const} */ ('blocked'),
      errors: [
        '[Verify Change Blocked] Differential parity mode requires a live candidate --base-url (or TEST_BASE_URL).',
      ],
      paritySummary: null,
    };
  }

  const res = /** @type {Record<string, any>} */ (
    await runParityCore({
      lang,
      target,
      qaDir,
      baselineUrl,
      candidateUrl: effectiveBaseUrl,
      corpus: options.corpus,
      routes: options.routes,
      privacyMode: options.privacyMode,
      strictByteEscape: options.strictByteEscape,
      allowMutation: options.allowMutation,
      checkAria: Boolean(options.checkAria),
      concurrency: options.concurrency,
      dryRun: false,
    })
  );

  if (res.outcome === 'blocked' || res.exitCode === 2) {
    return {
      ok: false,
      blocked: true,
      gateStatus: /** @type {const} */ ('blocked'),
      errors: Array.isArray(res.errors) && res.errors.length > 0 ? res.errors : [String(res.error || 'Parity blocked')],
      paritySummary: null,
    };
  }

  if (!res.ok) {
    const clusterLines = (res.clusters || [])
      .slice(0, 5)
      .map(
        (/** @type {any} */ c) =>
          `[Differential Parity Oracle][${c.checkpoint}] ${c.routePattern} @ ${c.pieceOrJsonPath} (${c.diffKind}, fp=${c.fingerprintId}, count=${c.count})`
      );
    const errors =
      clusterLines.length > 0
        ? clusterLines
        : [`[Differential Parity Oracle] Candidate diverged from Baseline (${res.error || `parityPct=${res.parityPct}%`}).`];
    return {
      ok: false,
      blocked: false,
      gateStatus: /** @type {const} */ ('fail'),
      errors,
      paritySummary: {
        baselineUrl,
        candidateUrl: effectiveBaseUrl,
        parityPct: res.parityPct ?? 0,
        totalSamples: res.totalSamples ?? 0,
        matchedSamples: res.matchedSamples ?? 0,
        mismatchedSamples: res.mismatchedSamples ?? 0,
        clusterCount: Array.isArray(res.clusters) ? res.clusters.length : 0,
        clusters: res.clusters || [],
        cohortStats: res.cohortStats || {},
        privacyMode: res.privacyMode || 'redacted',
        elapsedMs: res.elapsedMs ?? 0,
        reportJsonPath: res.reportJsonPath || null,
        summaryMdPath: res.summaryMdPath || null,
      },
    };
  }

  return {
    ok: true,
    blocked: false,
    gateStatus: /** @type {const} */ ('pass'),
    errors: /** @type {string[]} */ ([]),
    paritySummary: {
      baselineUrl,
      candidateUrl: effectiveBaseUrl,
      parityPct: res.parityPct ?? 100,
      totalSamples: res.totalSamples ?? 0,
      matchedSamples: res.matchedSamples ?? 0,
      mismatchedSamples: res.mismatchedSamples ?? 0,
      clusterCount: 0,
      clusters: [],
      cohortStats: res.cohortStats || {},
      privacyMode: res.privacyMode || 'redacted',
      elapsedMs: res.elapsedMs ?? 0,
      reportJsonPath: res.reportJsonPath || null,
      summaryMdPath: res.summaryMdPath || null,
    },
  };
}
