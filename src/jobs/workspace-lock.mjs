// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { acquireDiskLock } from '../core/disk-lock.mjs';
import { buildCommandResult } from '../core/outcome.mjs';
import { redactSecrets } from '../core/redact.mjs';

export const DEFAULT_SYNC_BUDGET_MS = 45_000;
export const MAX_JOB_OUTPUT_BYTES = 1024 * 1024; // 1MB bounded ring buffer per stream (`M-09`)
export const DEFAULT_MAX_CONCURRENT_JOBS = 4;

/**
 * Strict safe allowlist of environment variables permitted to pass from the MCP host into
 * isolated child CLI processes (`M-12`, hardened v6.2.1).
 * Note: `AITEST_HMAC_KEY_FILE` is preserved so CLI and MCP children share the host T1 key store;
 * Playwright/target-app child envs strip `AITEST_HMAC_KEY*` separately in `runner.mjs`.
 */
const SAFE_CHILD_ENV_ALLOWLIST_EXACT = new Set([
  'PATH',
  'Path',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'LOCALAPPDATA',
  'APPDATA',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'XDG_DATA_HOME',
  'TMP',
  'TEMP',
  'TMPDIR',
  'SYSTEMROOT',
  'SystemRoot',
  'COMSPEC',
  'ComSpec',
  'PATHEXT',
  'SystemDrive',
  'WINDIR',
  'windir',
  'SHELL',
  'TERM',
  'LANG',
  'LC_ALL',
  'LC_MESSAGES',
  'TZ',
  'OS',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'CommonProgramFiles',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'NODE_ENV',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NPM_CONFIG_CACHE',
  'npm_config_cache',
  'UV_CACHE_DIR',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_WORKSPACE',
  'GITHUB_SHA',
  'GITHUB_REF',
  'GITHUB_BASE_REF',
  'GITHUB_REPOSITORY',
  'GITHUB_STEP_SUMMARY',
  'GITLAB_CI',
  'BUILDKITE',
  'CIRCLECI',
  'TF_BUILD',
  'REQUIRE_TEST_TARGET',
  'DEBUG',
  'NO_COLOR',
  'FORCE_COLOR',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'DISPLAY',
  'WAYLAND_DISPLAY',
  'XAUTHORITY',
  'DBUS_SESSION_BUS_ADDRESS',
  'AITEST_HMAC_KEY_FILE',
  'AITEST_LANG',
  'AITEST_DEFAULT_BRANCH',
  'AITEST_DISABLE_WEBSERVER',
  'AITEST_ACTIVE_SUITE',
  'AITEST_RUN_ID',
  'AITEST_HYGIENE_BLOCKLIST_FILE',
  'AITEST_DATA_DIR',
  'AITEST_CBM_BIN_DIR',
  'AITEST_CBM_RUNTIME_DIR',
  'AITEST_CBM_CACHE_DIR',
  'AITEST_CBM_BIN',
  'AITEST_DISABLE_EXTERNAL_GRAPH',
]);

const SAFE_CHILD_ENV_ALLOWLIST_PREFIXES = ['PLAYWRIGHT_', 'PW_', 'TEST_', 'E2E_', 'FAIL_ON_'];
const SENSITIVE_ENV_KEY_RE =
  /^(?:AITEST_HMAC_KEY$|AITEST_MCP_|AITEST_APPROVE_NON_INTERACTIVE$|ACTIONS_ID_TOKEN_|ACTIONS_RUNTIME_TOKEN$|DATABASE_URL$)|(?:^|_)(?:SECRET|TOKEN|API_KEY|PASSWORD|PASSWD|PRIVATE_KEY)(?:$|_)/i;
const PROXY_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']);

/**
 * Strips embedded `user:pass@` credentials from proxy URLs before forwarding to child processes.
 * @param {string} rawVal
 * @returns {string}
 */
export function sanitizeProxyUrlEnvValue(rawVal) {
  const s = String(rawVal || '').trim();
  if (!s) return s;
  try {
    const parsed = new URL(s);
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return s;
  } catch {
    return s.replace(/(\/\/)[^/@\s]+@/, '$1');
  }
}

/**
 * Builds a strictly allowlisted child process environment stripping host MCP / OIDC / DB / cloud credentials (`M-12`).
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @param {string} [resultFilePath]
 */
export function buildSafeChildEnv(baseEnv = process.env, resultFilePath = undefined) {
  /** @type {Record<string, string>} */
  const clean = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (!k.startsWith('E2E_') && SENSITIVE_ENV_KEY_RE.test(k)) continue;
    const allowed =
      SAFE_CHILD_ENV_ALLOWLIST_EXACT.has(k) ||
      SAFE_CHILD_ENV_ALLOWLIST_PREFIXES.some((p) => k.startsWith(p));
    if (!allowed) continue;
    clean[k] = PROXY_ENV_KEYS.has(k) ? sanitizeProxyUrlEnvValue(String(v)) : String(v);
  }
  clean.AITEST_MCP_CHILD = '1';
  if (resultFilePath) {
    clean.AITEST_RESULT_FILE = resultFilePath;
  } else {
    delete clean.AITEST_RESULT_FILE;
  }
  return clean;
}

/** @type {Map<string, { tail: Promise<void>, holder: { toolName: string, jobId: string | null, acquiredAt: string } | null }>} */
const workspaceLocks = new Map();

export const BARE_JSON_LINE_RE = /^[{}\[\],]+$/;

/** @param {string} workspaceKey */
function normalizeLockKey(workspaceKey) {
  const resolved = path.resolve(workspaceKey);
  let real = resolved;
  try {
    if (fs.existsSync(resolved)) {
      real = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(resolved) : fs.realpathSync(resolved);
    }
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
 * Per-workspace async mutex + atomic cross-process lockfile (`M-13` / `WU-02` / `WB-P0-12`).
 * Enforces bounded timeout on BOTH the in-memory queue wait and the cross-process disk lock,
 * failing closed with `{ code: 'WORKSPACE_LOCK_BUSY' }` naming the active holder.
 * @template T
 * @param {string | null} workspaceKey
 * @param {() => Promise<T>} fn
 * @param {number} [diskTimeoutMs]
 * @param {{ toolName?: string, jobId?: string | null }} [holderMeta]
 * @returns {Promise<T>}
 */
export async function withWorkspaceWriteLock(workspaceKey, fn, diskTimeoutMs = 15_000, holderMeta = undefined) {
  if (!workspaceKey) return fn();
  const normKey = normalizeLockKey(workspaceKey);
  const timeoutMs = Math.max(1, Number(diskTimeoutMs || 15_000));
  const deadline = Date.now() + timeoutMs;

  let entry = workspaceLocks.get(normKey);
  if (!entry) {
    entry = { tail: Promise.resolve(), holder: null };
    workspaceLocks.set(normKey, entry);
  }
  const prevTail = entry.tail;
  /** @type {() => void} */
  let releaseTurn = () => {};
  const myTail = /** @type {Promise<void>} */ (
    new Promise((resolve) => {
      releaseTurn = () => resolve();
    })
  );
  entry.tail = myTail;

  let settled = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let waitTimer = null;
  const acquiredTurn = await new Promise((resolve) => {
    waitTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);

    prevTail.then(
      () => {
        if (settled) return;
        settled = true;
        if (waitTimer) clearTimeout(waitTimer);
        resolve(true);
      },
      () => {
        if (settled) return;
        settled = true;
        if (waitTimer) clearTimeout(waitTimer);
        resolve(true);
      }
    );
  });

  if (!acquiredTurn) {
    const holder = entry.holder;
    const holderDesc = holder
      ? `tool=${holder.toolName}${holder.jobId ? `, jobId=${holder.jobId}` : ''}, acquiredAt=${holder.acquiredAt}`
      : 'active holder in queue';
    prevTail.then(
      () => {
        if (entry && entry.tail === myTail && !entry.holder) workspaceLocks.delete(normKey);
        releaseTurn();
      },
      () => {
        if (entry && entry.tail === myTail && !entry.holder) workspaceLocks.delete(normKey);
        releaseTurn();
      }
    );
    const err = /** @type {Error & { code?: string, holder?: any }} */ (
      new Error(`[Workspace Lock Busy] Timed out after ${timeoutMs}ms waiting for workspace lock (${holderDesc}).`)
    );
    err.code = 'WORKSPACE_LOCK_BUSY';
    err.holder = holder;
    throw err;
  }

  entry.holder = {
    toolName: holderMeta?.toolName || 'unknown',
    jobId: holderMeta?.jobId || null,
    acquiredAt: new Date().toISOString(),
  };

  try {
    const remainingDiskMs = Math.max(100, deadline - Date.now());
    const lockRes = await acquireDiskLock(normKey, remainingDiskMs);
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
  } finally {
    if (entry) {
      entry.holder = null;
      if (entry.tail === myTail) workspaceLocks.delete(normKey);
    }
    releaseTurn();
  }
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

/**
 * Formats an error record when workspace lock acquisition or child invocation fails before exit.
 * @param {string} toolName
 * @param {unknown} err
 */
export function buildJobFailureEnvelope(toolName, err) {
  const isLockBusy = Boolean(err && typeof err === 'object' && 'code' in err && err.code === 'WORKSPACE_LOCK_BUSY');
  const msg = err instanceof Error ? err.message : String(err);
  const exitCode = isLockBusy ? 2 : 1;
  return {
    exitCode,
    lastMessage: redactSecrets(msg).slice(0, 180),
    parsedData: buildCommandResult({
      tool: toolName,
      outcome: isLockBusy ? 'blocked' : 'fail',
      ok: false,
      exitCode,
      summary: msg,
      blockerKind: isLockBusy ? 'WORKSPACE_LOCK_BUSY' : 'EXECUTION_ERROR',
      recoverySteps: isLockBusy ? ['Wait for concurrent workspace operation to finish and retry.'] : [],
      data: { error: msg, reason: isLockBusy ? 'WORKSPACE_LOCK_BUSY' : 'EXECUTION_ERROR' },
    }),
  };
}

/**
 * Emits job progress to active foreground callback and any late `aitest_job(action="result")` listeners.
 * @param {Record<string, any>} jobRecord
 * @param {((info: { progress: number, message: string }) => void) | null | undefined} primaryOnProgress
 * @param {{ progress: number, message: string }} info
 */
export function emitJobProgressNotification(jobRecord, primaryOnProgress, info) {
  if (jobRecord.progressActive && typeof primaryOnProgress === 'function') {
    try {
      primaryOnProgress(info);
    } catch {
      // ignore callback failures
    }
  }
  for (const listener of jobRecord.progressListeners || []) {
    try {
      listener(info);
    } catch {
      // ignore late listener failures
    }
  }
}

/**
 * Unwraps structured `aitest_job(action="result")` response payloads cleanly.
 * @param {Record<string, any>} jobRecord
 * @param {Record<string, any> | null} publicStatus
 */
export function formatJobWaitResult(jobRecord, publicStatus) {
  const rawData = jobRecord.parsedData;
  const unwrappedData =
    rawData && typeof rawData === 'object' && rawData.schemaVersion === 2 && rawData.data && typeof rawData.data === 'object'
      ? rawData.data
      : rawData || (jobRecord.stdout ? { output: jobRecord.stdout.slice(0, 4000) } : {});
  const summary =
    rawData && typeof rawData === 'object' && typeof rawData.summary === 'string'
      ? rawData.summary
      : undefined;
  return {
    ...publicStatus,
    ...(summary ? { summary } : {}),
    data: unwrappedData,
    stderr: jobRecord.exitCode !== 0 && jobRecord.stderr ? jobRecord.stderr.slice(0, 2000) : undefined,
  };
}
