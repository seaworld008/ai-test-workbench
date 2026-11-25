// @ts-check
import { stripVTControlCharacters } from '../core/outcome.mjs';

/**
 * Produces a deterministic human/agent summary when a tool's raw payload lacks an explicit `summary` field.
 * @param {string} toolName
 * @param {Record<string, any>} data
 * @param {boolean} ok
 * @param {number} exitCode
 * @returns {string}
 */
export function summarizeToolResult(toolName, data, ok, exitCode) {
  if (typeof data?.error === 'string' && data.error.trim()) {
    return stripVTControlCharacters(data.error).slice(0, 300);
  }
  if (toolName === 'aitest_doctor' && Array.isArray(data?.checks)) {
    const okCount = data.checks.filter((/** @type {any} */ c) => c?.status === 'OK').length;
    return `Doctor checked ${data.checks.length} items: OK=${okCount}, WARN=${data.warnCount ?? 0}, FAIL=${data.failCount ?? 0}`;
  }
  if (data?.verdict) {
    return `Verdict=${String(data.verdict).toUpperCase()} (${data.trustTier || 'T0'}, runId=${data.runId || 'none'}, scope=${data.acceptanceScope || 'local-workbench'})`;
  }
  if (data?.outcome && Array.isArray(data?.errors)) {
    return `${toolName} outcome=${data.outcome} (${data.trustTier || 'T0'}, errors=${data.errors.length})`;
  }
  return ok ? `${toolName} succeeded (exitCode=0)` : `${toolName} failed (exitCode=${exitCode})`;
}

/**
 * Derives context-aware next actions from actual failure/blocker state when not already supplied by CommandResult.
 * @param {string} toolName
 * @param {boolean} ok
 * @param {number} exitCode
 * @param {Record<string, any>} data
 * @param {Record<string, any>} args
 * @param {any} toolEntry
 * @returns {string[]}
 */
export function deriveDynamicNextActions(toolName, ok, exitCode, data, args, toolEntry) {
  if (!ok) {
    if (Array.isArray(data?.recoverySteps) && data.recoverySteps.length > 0) {
      return data.recoverySteps.slice(0, 4);
    }
    if (Array.isArray(data?.nextActions) && data.nextActions.length > 0) {
      return data.nextActions
        .slice(0, 4)
        .map((/** @type {any} */ a) => (typeof a === 'string' ? a : a?.command || JSON.stringify(a)));
    }
    if (data?.blockerKind === 'WORKSPACE_LOCK_BUSY') {
      return ['Wait for the active workspace write operation to complete and retry.'];
    }
    if (exitCode === 2 && data?.gates?.governance === 'blocked') {
      return [
        'Have a human reviewer inspect protected files and run "governance approve --target <repo> --by <human> --reason <why>" in terminal.',
      ];
    }
  }
  return typeof toolEntry?.nextActions === 'function' ? toolEntry.nextActions(ok, args) : [];
}
