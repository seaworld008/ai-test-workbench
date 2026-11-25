// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { acquireDiskLock } from '../core/disk-lock.mjs';

export const DEFAULT_SYNC_BUDGET_MS = 45_000;
export const MAX_JOB_OUTPUT_BYTES = 1024 * 1024; // 1MB bounded ring buffer per stream (`M-09`)
export const DEFAULT_MAX_CONCURRENT_JOBS = 4;

/**
 * Environment variables that belong strictly to the MCP server host and MUST NEVER leak
 * into child CLI processes (`M-12`). Note: `AITEST_HMAC_KEY_FILE` is preserved so CLI and
 * MCP children share the same host T1 key store; Playwright/app child envs are stripped in `runner.mjs`.
 */
const STRIPPED_CHILD_ENV_KEYS = new Set([
  'AITEST_MCP_TOKEN',
  'AITEST_MCP_ALLOWED_ORIGINS',
  'AITEST_MCP_WORKSPACE_ROOTS',
  'AITEST_HMAC_KEY',
  'NPM_TOKEN',
  'NODE_AUTH_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
]);

/**
 * Builds a sanitized child process environment stripping host MCP / cloud credentials (`M-12`).
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {string} [resultFilePath]
 */
export function buildSafeChildEnv(baseEnv = process.env, resultFilePath = undefined) {
  /** @type {Record<string, string>} */
  const clean = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (STRIPPED_CHILD_ENV_KEYS.has(k)) continue;
    clean[k] = String(v);
  }
  clean.AITEST_MCP_CHILD = '1';
  if (resultFilePath) {
    clean.AITEST_RESULT_FILE = resultFilePath;
  } else {
    delete clean.AITEST_RESULT_FILE;
  }
  return clean;
}

/** @type {Map<string, Promise<any>>} */
const workspaceLocks = new Map();

/** @param {string} workspaceKey */
function normalizeLockKey(workspaceKey) {
  const resolved = path.resolve(workspaceKey);
  let real = resolved;
  try {
    if (fs.existsSync(resolved)) real = fs.realpathSync(resolved);
  } catch {
    // keep resolved
  }
  const qaChild = path.join(real, 'qa');
  const canonical =
    path.basename(real) !== 'qa' && fs.existsSync(path.join(qaChild, 'playwright.config.ts'))
      ? qaChild
      : real;
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/**
 * Per-workspace async mutex + atomic cross-process lockfile (`M-13` / `WU-02`).
 * Fails closed with `{ ok: false, reason: 'WORKSPACE_LOCK_BUSY' }` on lock contention timeout.
 * @template T
 * @param {string | null} workspaceKey
 * @param {() => Promise<T>} fn
 * @param {number} [diskTimeoutMs]
 * @returns {Promise<T>}
 */
export function withWorkspaceWriteLock(workspaceKey, fn, diskTimeoutMs = 15_000) {
  if (!workspaceKey) return fn();
  const normKey = normalizeLockKey(workspaceKey);
  const prev = workspaceLocks.get(normKey) || Promise.resolve();
  const wrapped = async () => {
    const lockRes = await acquireDiskLock(normKey, diskTimeoutMs);
    if (!lockRes.ok) {
      const err = /** @type {Error & { code?: string }} */ (new Error(lockRes.error));
      err.code = lockRes.reason;
      throw err;
    }
    try {
      return await fn();
    } finally {
      lockRes.release();
    }
  };
  const next = prev.then(wrapped, wrapped);
  const tracked = next.finally(() => {
    if (workspaceLocks.get(normKey) === tracked) {
      workspaceLocks.delete(normKey);
    }
  });
  workspaceLocks.set(normKey, tracked);
  return next;
}

/**
 * Appends text into a bounded tail buffer (`maxBytes`) to prevent unbounded memory DoS (`M-09`).
 * @param {string} current
 * @param {string} addition
 * @param {number} [maxBytes]
 */
export function appendBoundedBuffer(current, addition, maxBytes = MAX_JOB_OUTPUT_BYTES) {
  const combined = current + addition;
  if (combined.length <= maxBytes) return combined;
  return combined.slice(combined.length - maxBytes);
}

/**
 * Reads framed JSON IPC result from `AITEST_RESULT_FILE` strictly when present (eliminating stdout scraping).
 * Falls back to whole-payload or final-line JSON ONLY for raw `customCommand` processes without an IPC file.
 * @param {string | null} resultFilePath
 * @param {string} stdoutText
 */
export function readFramedSubprocessResult(resultFilePath, stdoutText) {
  if (resultFilePath) {
    if (!fs.existsSync(resultFilePath)) return null;
    try {
      const text = fs.readFileSync(resultFilePath, 'utf8').trim();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }
  const raw = String(stdoutText || '').trim();
  if (!raw) return null;
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {
      // fall through to final-line JSON check for synthetic custom commands
    }
  }
  const lastBraceIdx = raw.lastIndexOf('\n{');
  if (lastBraceIdx !== -1) {
    try {
      return JSON.parse(raw.slice(lastBraceIdx + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
