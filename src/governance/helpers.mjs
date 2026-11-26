// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { computeProtectedFileHashes } from '../kernel/gate-kernel.mjs';

export const AGENT_SESSION_ENV_VARS = Object.freeze([
  'AITEST_MCP_CHILD',
  'AITEST_MCP_CAPTURED_STDIO',
  'ANTIGRAVITY_CONVERSATION_ID',
  'CLAUDECODE',
  'CODEX_CI',
  'CODEX_SANDBOX',
  'CURSOR_TRACE_ID',
  'AIDER_MODEL',
]);

/**
 * Detects whether the current process environment indicates an AI coding agent session.
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function detectAgentSessionEnvVar(env) {
  for (const key of AGENT_SESSION_ENV_VARS) {
    const val = env?.[key];
    if (typeof val === 'string' && val.trim() !== '' && val.trim() !== '0' && val.trim().toLowerCase() !== 'false') {
      return key;
    }
  }
  return null;
}

/**
 * @param {string} qaDir
 * @returns {boolean}
 */
export function hasWorkspaceGovernanceTrace(qaDir) {
  const aitestDir = path.join(qaDir, '.aitest');
  if (!fs.existsSync(aitestDir)) return false;
  if (fs.existsSync(path.join(aitestDir, 'governance.lock'))) return true;
  if (fs.existsSync(path.join(aitestDir, 'governance-audit.jsonl'))) return true;
  for (const sub of ['runs', 'heals']) {
    const dir = path.join(aitestDir, sub);
    if (fs.existsSync(dir)) {
      try {
        if (fs.readdirSync(dir).length > 0) return true;
      } catch {
        return true;
      }
    }
  }
  return false;
}

/**
 * Summarizes protected file differences compared to the previous `.aitest/governance.lock`.
 * @param {string} qaDir
 * @returns {{ added: string[], modified: string[], removed: string[] }}
 */
export function summarizeProtectedLockChanges(qaDir) {
  const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
  const current = computeProtectedFileHashes(qaDir);
  /** @type {Record<string, string>} */
  let prev = {};
  if (fs.existsSync(lockPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
      if (parsed?.files && typeof parsed.files === 'object') prev = parsed.files;
    } catch {
      prev = {};
    }
  }
  const added = Object.keys(current).filter((k) => !(k in prev)).sort();
  const modified = Object.keys(current).filter((k) => k in prev && current[k] !== prev[k]).sort();
  const removed = Object.keys(prev).filter((k) => !(k in current)).sort();
  return { added, modified, removed };
}
