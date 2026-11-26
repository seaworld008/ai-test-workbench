// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { verifyLedgerBindingInQaDir } from '../audit.mjs';
import { SCHEMA_VERSIONS } from '../core/version.mjs';
import { generateDiagnosticsMarkdown } from '../diagnose.mjs';
import { openTrustContext } from '../kernel/gate-kernel.mjs';
import { loadKnownBlockers, matchKnownBlocker } from '../memory/blockers.mjs';
import {
  MAX_HEAL_ATTEMPTS,
  computeAppCodeTreeHash,
  readHealAttemptLedger,
  resolveSpecBaseline,
  writeHealAttemptLedger,
  writeSignedSession,
} from './store.mjs';

/**
 * Starts a stateful, T1-HMAC-signed Heal Governance Session (`R1-4`, `T-07`).
 * Only Class A failures allow repair attempts (<= 3 across ALL sessions for the same `testId`);
 * Class B/C/D are locked to reporting/escalation.
 * @param {string} qaDir
 * @param {{ testId?: string, resultsPath?: string }} [options]
 */
export function beginHealSession(qaDir, options = {}) {
  const resultsPath = options.resultsPath
    ? path.resolve(qaDir, options.resultsPath)
    : path.join(qaDir, 'reports', 'results.json');
  if (!fs.existsSync(resultsPath)) {
    return {
      ok: false,
      exitCode: 1,
      error: `Results file not found at ${resultsPath}. Run tests before starting a heal session.`,
    };
  }

  // Enforce Run Ledger binding when explicit `--results` is supplied or `.aitest/runs/latest.json` exists (`WU-04`)
  const runLedgerPath = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  const requireBinding = Boolean(options.resultsPath) || fs.existsSync(runLedgerPath);
  if (requireBinding) {
    let rawResultsObj;
    try {
      rawResultsObj = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
    } catch (err) {
      return {
        ok: false,
        exitCode: 2,
        error: `[Heal Governance Blocked] Invalid results JSON (${resultsPath}): ${err instanceof Error ? err.message : String(err)}`,
      };
    }
    const repoDir = path.dirname(qaDir);
    const bindCtx = openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });
    const binding = verifyLedgerBindingInQaDir(qaDir, resultsPath, rawResultsObj, {
      allowUnboundResults: false,
      trustContext: bindCtx,
    });
    if (!binding.ok) {
      return {
        ok: false,
        exitCode: 2,
        error: `[Heal Governance Blocked] Refusing unbound or forged results file (${resultsPath}): ${binding.errors.join('; ')}`,
      };
    }
  }

  const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
  if (diag.failures.length === 0) {
    return {
      ok: false,
      exitCode: 1,
      error: 'No failing or flaky tests found in results.json; nothing to heal.',
    };
  }

  const requestedTestId = options.testId;
  const targetFailure = requestedTestId
    ? diag.failures.find(
        (f) => f.testId === requestedTestId || f.title.includes(requestedTestId) || f.file.includes(requestedTestId)
      )
    : diag.failures[0];

  if (!targetFailure) {
    return {
      ok: false,
      exitCode: 1,
      error: `Failing test matching "${options.testId}" not found in current results.json.`,
    };
  }

  // Known Blocker Deduplication Guard (`WU-D`): refuse opening duplicate heal sessions for open architecture blockers
  const openBlockers = loadKnownBlockers(qaDir).openBlockers;
  const matchedBlocker =
    (targetFailure.linkedKnownBlockerId
      ? openBlockers.find((b) => b.id === targetFailure.linkedKnownBlockerId)
      : null) || matchKnownBlocker(targetFailure, openBlockers);
  if (matchedBlocker) {
    return {
      ok: false,
      exitCode: 2,
      blockerLinked: true,
      linkedKnownBlockerId: matchedBlocker.id,
      knownBlockerReason: matchedBlocker.reason,
      trackingIssue: matchedBlocker.trackingIssue || null,
      error: `[Heal Governance Blocked] Test "${targetFailure.testId}" matches open known blocker "${matchedBlocker.id}" (${matchedBlocker.title}: ${matchedBlocker.reason}). Refusing to open a duplicate heal session; do NOT patch with static shortcuts (track via ${matchedBlocker.trackingIssue || matchedBlocker.id}).`,
    };
  }

  // Enforce cross-session attempt accounting per `(testId, appCodeTreeHash)` (`T-07`, `WU-04`)
  const ledger = readHealAttemptLedger(qaDir);
  if (!ledger.ok) {
    return { ok: false, exitCode: 2, error: ledger.error };
  }
  const appCodeTreeHash = computeAppCodeTreeHash(path.dirname(qaDir), qaDir);
  const priorEntry = ledger.byTestId[targetFailure.testId];
  const quotaReset = Boolean(priorEntry?.appCodeTreeHash && priorEntry.appCodeTreeHash !== appCodeTreeHash);
  const priorAttemptsForTest = quotaReset ? 0 : Number(priorEntry?.attemptsUsed || 0);

  const sessionId = `heal_${crypto.randomBytes(6).toString('hex')}`;
  const relSpec = targetFailure.file.startsWith('tests/') ? targetFailure.file : `tests/${targetFailure.file}`;
  const absSpec = path.join(qaDir, relSpec);
  const baseline = resolveSpecBaseline(qaDir, absSpec);

  const repairPermitted = targetFailure.categoryCode === 'A' && priorAttemptsForTest < MAX_HEAL_ATTEMPTS;
  const remainingAttempts = targetFailure.categoryCode === 'A' ? Math.max(0, MAX_HEAL_ATTEMPTS - priorAttemptsForTest) : 0;

  const session = {
    schemaVersion: SCHEMA_VERSIONS.healSession,
    sessionId,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    state: priorAttemptsForTest >= MAX_HEAL_ATTEMPTS && targetFailure.categoryCode === 'A' ? 'escalated' : 'diagnosed',
    testId: targetFailure.testId,
    appCodeTreeHash,
    title: targetFailure.title,
    specFile: relSpec,
    line: targetFailure.line,
    categoryCode: targetFailure.categoryCode,
    subCategory: targetFailure.subCategory || null,
    category: targetFailure.category,
    confidence: targetFailure.confidence,
    candidates: targetFailure.candidates || [targetFailure.categoryCode],
    traceId: targetFailure.traceId,
    traceIds: targetFailure.traceIds || (targetFailure.traceId ? [targetFailure.traceId] : []),
    timeWindow: targetFailure.timeWindow || null,
    errorSnippet: targetFailure.errorSnippet,
    codeCorrelation: targetFailure.codeCorrelation,
    repairPermitted,
    maxAttempts: targetFailure.categoryCode === 'A' ? MAX_HEAL_ATTEMPTS : 0,
    attemptsUsed: priorAttemptsForTest,
    remainingAttempts,
    baselineSource: baseline.source,
    baselineSha: baseline.baseSha,
    allowedActions: repairPermitted ? ['attempt', 'conclude', 'discard'] : ['conclude', 'discard'],
    baselineSpecContent: baseline.content,
    attempts: [],
    conclusion: null,
  };

  const writeTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
  const nextActive = [...new Set([...(/** @type {any} */ (ledger).activeSessionIds || []), sessionId])];
  if (quotaReset) {
    ledger.byTestId[targetFailure.testId] = {
      attemptsUsed: 0,
      appCodeTreeHash,
      lastSessionId: sessionId,
      updatedAt: new Date().toISOString(),
    };
  }
  writeHealAttemptLedger(qaDir, ledger.byTestId, writeTrustCtx, nextActive);
  writeSignedSession(qaDir, session, writeTrustCtx);

  const { baselineSpecContent: _omit, ...publicSession } = session;
  return {
    ok: true,
    exitCode: 0,
    session: publicSession,
  };
}
