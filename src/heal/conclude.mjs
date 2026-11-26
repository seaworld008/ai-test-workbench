// @ts-check
import path from 'node:path';
import { redactSecrets } from '../core/redact.mjs';
import { openTrustContext } from '../kernel/gate-kernel.mjs';
import {
  readAndVerifySession,
  readHealAttemptLedger,
  writeDefectTicketFiles,
  writeHealAttemptLedger,
  writeSignedSession,
} from './store.mjs';

export const VALID_HEAL_OUTCOMES = new Set([
  'verified',
  'reported',
  'defect',
  'escalated',
  'clarification-needed',
  'healed',
  'defect_filed',
  'blocked',
]);

/**
 * Concludes a Heal Session (`aitest_heal(action="conclude")`), generating a structured Defect Ticket for Class C bugs.
 * @param {string} qaDir
 * @param {{ sessionId?: string, outcome?: string, summary?: string }} [options]
 */
export function concludeHealSession(qaDir, options = {}) {
  const loaded = readAndVerifySession(qaDir, options.sessionId);
  if (!loaded.ok) return loaded;
  const session = loaded.session;
  const outcome = String(options.outcome || (session.state === 'verified' ? 'verified' : 'reported')).toLowerCase();

  if (!VALID_HEAL_OUTCOMES.has(outcome)) {
    return {
      ok: false,
      exitCode: 64,
      error: `Invalid heal conclusion outcome "${outcome}". Expected one of: ${[...VALID_HEAL_OUTCOMES].join(', ')}`,
    };
  }

  if (outcome === 'verified' && session.state !== 'verified') {
    return {
      ok: false,
      exitCode: 2,
      error: `[Heal Governance Blocked] Cannot conclude session as "verified" when state is "${session.state}".`,
    };
  }

  const writeTrustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
  const ledger = readHealAttemptLedger(qaDir, writeTrustCtx);
  if (!ledger.ok) {
    return { ok: false, exitCode: 2, error: ledger.error };
  }

  const summaryNote = redactSecrets(String(options.summary || 'Product/backend regression detected; test intentionally kept red.'));
  let defectTicketPath = null;
  if (session.categoryCode === 'C' || outcome === 'reported' || outcome === 'defect' || outcome === 'defect_filed') {
    defectTicketPath = writeDefectTicketFiles(qaDir, session, summaryNote);
  }

  session.state = 'concluded';
  session.allowedActions = [];
  session.updatedAt = new Date().toISOString();
  session.conclusion = {
    outcome,
    summary: redactSecrets(String(options.summary || '')),
    defectTicketPath,
    concludedAt: session.updatedAt,
  };
  writeSignedSession(qaDir, session, writeTrustCtx);
  const nextActive = (ledger.activeSessionIds || []).filter((id) => id !== session.sessionId);
  writeHealAttemptLedger(qaDir, ledger.byTestId, writeTrustCtx, nextActive);

  return {
    ok: true,
    exitCode: 0,
    sessionId: session.sessionId,
    outcome,
    defectTicketPath,
  };
}

/**
 * Discards an abandoned/stale heal session (`aitest_heal(action="discard")`) so `activeSessionIds`
 * no longer blocks commits, while retaining `byTestId` attempt counters (`WU-04`).
 * @param {string} qaDir
 * @param {{ sessionId?: string, summary?: string }} [options]
 */
export function discardHealSession(qaDir, options = {}) {
  const loaded = readAndVerifySession(qaDir, options.sessionId);
  if (!loaded.ok) return loaded;
  const session = loaded.session;
  const trustCtx = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: true });
  const ledger = readHealAttemptLedger(qaDir, trustCtx);
  if (!ledger.ok) {
    return { ok: false, exitCode: 2, error: ledger.error };
  }

  session.state = 'discarded';
  session.repairPermitted = false;
  session.allowedActions = [];
  session.updatedAt = new Date().toISOString();
  session.conclusion = {
    outcome: 'discarded',
    summary: redactSecrets(String(options.summary || 'Heal session explicitly discarded; attempt quota retained.')),
    defectTicketPath: null,
    concludedAt: session.updatedAt,
  };
  writeSignedSession(qaDir, session, trustCtx);
  const nextActive = (ledger.activeSessionIds || []).filter((id) => id !== session.sessionId);
  writeHealAttemptLedger(qaDir, ledger.byTestId, trustCtx, nextActive);

  return {
    ok: true,
    exitCode: 0,
    sessionId: session.sessionId,
    state: 'discarded',
  };
}
