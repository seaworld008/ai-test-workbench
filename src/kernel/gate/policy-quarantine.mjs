// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { computeFlakyStats } from '../../core/playwright-results.mjs';
import { verifyPayloadT1 } from './trust-hmac.mjs';

/**
 * Checks whether a test has genuine flaky evidence in `.aitest/runs/` ledger history (`T-06`).
 * @param {string} qaDir
 * @param {string} file
 * @param {string} title
 */
function hasLedgerFlakyEvidence(qaDir, file, title) {
  const indexPath = path.join(qaDir, '.aitest', 'runs', 'index.jsonl');
  if (!fs.existsSync(indexPath)) return false;
  const normFile = String(file || '').replace(/\\/g, '/');
  const lines = fs
    .readFileSync(indexPath, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-20);

  /** @type {Array<{ status?: string, retryPassed?: boolean }>} */
  const observations = [];

  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      const summaryPath = path.join(qaDir, '.aitest', 'runs', String(row.runId || ''), 'tests-summary.json');
      if (!fs.existsSync(summaryPath)) continue;
      const tests = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      for (const t of tests) {
        const tf = String(t.file || '').replace(/\\/g, '/');
        if ((tf === normFile || tf.endsWith(`/${normFile}`) || normFile.endsWith(`/${tf}`)) && t.title === title) {
          observations.push({ status: t.status, retryPassed: t.retryPassed });
        }
      }
    } catch {
      // skip malformed entry
    }
  }

  const stats = computeFlakyStats(observations);
  if (stats.totalRuns < 3) return false;
  return stats.flakyRate >= 0.2;
}

/**
 * Strict Quarantine Validation (`T-06`):
 * Enforces <= 7-day TTL, max 5 entries, no @critical/@smoke, T1 MAC integrity (with sticky host enforcement),
 * and Run Ledger flaky history evidence.
 * @param {string} qaDir
 * @param {number | { nowMs?: number, requireT1Mac?: boolean, trustContext?: import('./trust-context.mjs').TrustContext }} [nowOrOptions]
 */
export function loadActiveQuarantine(qaDir, nowOrOptions = Date.now()) {
  const nowMs = typeof nowOrOptions === 'number' ? nowOrOptions : nowOrOptions?.nowMs ?? Date.now();
  const requireT1Mac = typeof nowOrOptions === 'object' && Boolean(nowOrOptions?.requireT1Mac);
  const trustContext = typeof nowOrOptions === 'object' ? nowOrOptions?.trustContext : undefined;
  const qPath = path.join(qaDir, '.aitest', 'quarantine.json');
  if (!fs.existsSync(qPath)) return { ok: true, entries: [], errors: [] };

  const MAX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 5;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(qPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      blocked: true,
      entries: [],
      errors: [`Invalid JSON in .aitest/quarantine.json: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  /** @type {string[]} */
  const errors = [];
  /** @type {Array<Record<string, any>>} */
  const active = [];
  const list = Array.isArray(parsed.entries) ? parsed.entries : [];
  let blocked = false;

  // Verify T1 HMAC whenever quarantine.json exists with entries OR on a T1-sticky host (catches emptied/stripped files)
  if (list.length > 0 || trustContext?.hostT1Sticky || requireT1Mac) {
    const macCheck = verifyPayloadT1('quarantine.json', parsed, parsed.mac, {
      qaDir,
      repoDir: path.dirname(qaDir),
      requireMac: requireT1Mac,
      macs: parsed.macs || null,
      trustContext,
    });
    if (!macCheck.ok) {
      blocked = true;
      errors.push(`[Quarantine Tamper Blocked] ${macCheck.reason}`);
    }
  }

  if (list.length > MAX_ENTRIES) {
    errors.push(`[Quarantine Policy Blocked] Active quarantine count (${list.length}) exceeds maximum ${MAX_ENTRIES}.`);
  }

  for (const item of list) {
    if (!item || typeof item !== 'object' || !item.title || !item.file) {
      errors.push('[Quarantine Policy Blocked] Malformed quarantine entry (requires "file" and "title").');
      continue;
    }
    if (/@critical|@smoke/i.test(String(item.title))) {
      errors.push(`[Quarantine Policy Blocked] Critical/smoke test "${item.title}" cannot be quarantined.`);
      continue;
    }
    const exp = Date.parse(item.expiresAt || '');
    if (Number.isNaN(exp) || exp <= nowMs) {
      errors.push(`[Quarantine Expired] Quarantined flaky test "${item.title}" expired at ${item.expiresAt}; fix or escalate.`);
      continue;
    }
    const addedMs = item.addedAt ? Date.parse(item.addedAt) : nowMs;
    if (Number.isNaN(addedMs) || exp - nowMs > MAX_TTL_MS || exp - addedMs > MAX_TTL_MS) {
      errors.push(
        `[Quarantine Policy Blocked] Quarantine TTL for "${item.title}" exceeds 7-day maximum (expiresAt=${item.expiresAt}).`
      );
      continue;
    }
    if (!hasLedgerFlakyEvidence(qaDir, item.file, item.title)) {
      errors.push(
        `[Quarantine Forgery Blocked] "${item.file}::${item.title}" has no historical flaky evidence (>=3 runs, >=20% flaky rate) in Run Ledger.`
      );
      continue;
    }
    active.push(item);
  }

  return { ok: errors.length === 0, blocked, entries: active, errors };
}
