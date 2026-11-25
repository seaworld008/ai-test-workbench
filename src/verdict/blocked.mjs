// @ts-check
import { SCHEMA_VERSIONS } from '../core/version.mjs';

/**
 * Factory producing schema-complete `blocked` verdicts across all pre-flight failure paths in `verifyChangeCore`.
 * Replaces duplicated partial blocked objects (`WU-02`).
 * @param {{
 *   reasonCode: string;
 *   gitSha: string | null;
 *   base: Record<string, any>;
 *   requestedMode: string;
 *   gates: { governance: string; static: string; runtime: string; semanticDiff: string };
 *   gateErrors: string[];
 *   error?: string;
 *   recoverable?: boolean;
 *   blockerKind?: string | null;
 *   recoverySteps?: string[];
 *   nextActions?: Array<Record<string, any>>;
 * }} params
 */
export function buildBlockedVerdict(params) {
  return {
    schemaVersion: SCHEMA_VERSIONS.verdict,
    ok: false,
    exitCode: /** @type {const} */ (2),
    verdict: /** @type {const} */ ('blocked'),
    trustTier: /** @type {const} */ ('T0'),
    trustLevel: /** @type {const} */ ('T0'),
    mergeGradeGreen: false,
    recoverable: Boolean(params.recoverable),
    blockerKind: params.blockerKind || params.reasonCode,
    recoverySteps: params.recoverySteps || [],
    confidence: { level: 'high', reasons: [params.reasonCode] },
    runId: null,
    gitSha: params.gitSha,
    base: params.base,
    acceptanceScope: 'local-workbench',
    counts: { executed: 0, passed: 0, failed: 0, flaky: 0, skipped: 0 },
    scope: {
      requested: params.requestedMode,
      actual: 'none',
      downgraded: true,
      mode: params.requestedMode,
      selected: 0,
      total: 0,
      why: [],
    },
    gates: params.gates,
    gateErrors: params.gateErrors,
    ...(params.error ? { error: params.error } : {}),
    failures: [],
    traceability: { coveredRequirements: 0, totalRequirements: 0, coveragePct: 0 },
    ai: { llmCalls: 0, models: [], promptHashes: [] },
    nextActions: params.nextActions || [],
  };
}
