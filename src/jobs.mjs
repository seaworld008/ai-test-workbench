// @ts-check
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, redactSecrets, redactStructuredValue } from './proc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AITEST_BIN = path.resolve(__dirname, '..', 'tools', 'aitest.mjs');

export const DEFAULT_SYNC_BUDGET_MS = 45_000;
export const MAX_JOB_OUTPUT_BYTES = 1024 * 1024; // 1MB bounded ring buffer per stream (`M-09`)
export const DEFAULT_MAX_CONCURRENT_JOBS = 4;

/**
 * Environment variables that belong strictly to the MCP server host and MUST NEVER leak
 * into child CLI / Playwright / target repository test processes (`M-12`).
 */
const STRIPPED_CHILD_ENV_KEYS = new Set([
  'AITEST_MCP_TOKEN',
  'AITEST_MCP_ALLOWED_ORIGINS',
  'AITEST_MCP_WORKSPACE_ROOTS',
  'AITEST_HMAC_KEY',
  'AITEST_HMAC_KEY_FILE',
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
 */
export function buildSafeChildEnv(baseEnv = process.env) {
  /** @type {Record<string, string>} */
  const clean = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (v === undefined) continue;
    if (STRIPPED_CHILD_ENV_KEYS.has(k)) continue;
    clean[k] = String(v);
  }
  clean.AITEST_MCP_CHILD = '1';
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
  // Normalize <repo> and <repo>/qa to the same lock scope (`M-13`)
  const qaChild = path.join(real, 'qa');
  const canonical =
    path.basename(real) !== 'qa' && fs.existsSync(path.join(qaChild, 'playwright.config.ts'))
      ? qaChild
      : real;
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

/** @param {number} pid */
function isProcessAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Acquires a best-effort cross-process lockfile inside `<qaDir>/.aitest/.write.lock` (`M-13`)
 * so multiple IDE stdio MCP servers targeting the same QA directory serialize writes cleanly.
 * @param {string} lockDir
 * @param {number} [timeoutMs]
 */
async function acquireDiskLock(lockDir, timeoutMs = 15_000) {
  if (!lockDir || !fs.existsSync(lockDir)) return () => {};
  const aitestDir = path.join(lockDir, '.aitest');
  if (!fs.existsSync(aitestDir)) return () => {};

  const lockFile = path.join(aitestDir, '.write.lock');
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }), 'utf8');
      fs.closeSync(fd);
      return () => {
        try {
          if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
        } catch {
          // ignore cleanup
        }
      };
    } catch (err) {
      const errCode = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
      if (err && errCode !== 'EEXIST') return () => {};
      // Recover stale lock from dead PID or >15 min old
      try {
        const raw = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
        const ageMs = Date.now() - Date.parse(raw.acquiredAt || '');
        if ((raw.pid && !isProcessAlive(Number(raw.pid))) || ageMs > 15 * 60_000) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch {
        try {
          fs.unlinkSync(lockFile);
          continue;
        } catch {
          // wait and retry
        }
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  return () => {};
}

/**
 * Per-workspace async mutex + cross-process lockfile (`M-13`): serializes write operations
 * ONLY for the same canonical workspace while allowing read-only tools and different workspaces concurrently.
 * @template T
 * @param {string | null} workspaceKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWorkspaceWriteLock(workspaceKey, fn) {
  if (!workspaceKey) return fn();
  const normKey = normalizeLockKey(workspaceKey);
  const prev = workspaceLocks.get(normKey) || Promise.resolve();
  const wrapped = async () => {
    const releaseDisk = await acquireDiskLock(normKey);
    try {
      return await fn();
    } finally {
      releaseDisk();
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
 * Parses structured JSON output from a `--json` CLI subprocess cleanly without failing if Playwright
 * or Node emitted diagnostic banners before the final JSON payload.
 * @param {string} stdoutText
 */
export function parseSubprocessJsonOutput(stdoutText) {
  const raw = String(stdoutText || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    const idx = raw.lastIndexOf('\n{');
    if (idx >= 0) {
      try {
        return JSON.parse(raw.slice(idx + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Hardened child-process MCP Job Manager (`M-01`, `M-05`, `M-07`, `M-09`, `M-12`, `M-13`).
 *
 * Architectural guarantees:
 * - Parse-before-redact: parses raw stdout JSON BEFORE redacting values so workbench `sessionId`
 *   (`heal_*`), `jobId`, `runId`, and `traceId` remain intact while credentials are scrubbed.
 * - Session isolation: request cancellation and status/result queries are scoped to `ownerSessionId`.
 * - Bounded memory & concurrency: 1MB ring buffer per stream + configurable concurrency semaphore.
 * - Clean shutdown: `killAll()` terminates every running child process tree.
 */
export class McpJobManager {
  /**
   * @param {{ maxConcurrentJobs?: number, maxOutputBytes?: number }} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string, string>} */
    this.requestToJob = new Map();
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_JOB_OUTPUT_BYTES;
    this.activeChildren = 0;
    /** @type {Array<() => void>} */
    this.waitQueue = [];
  }

  /** @param {string | number} requestId @param {string | null} [sessionId] */
  _makeRequestKey(requestId, sessionId = 'default') {
    return `${sessionId || 'default'}:${String(requestId)}`;
  }

  async _acquireSlot() {
    if (this.activeChildren < this.maxConcurrentJobs) {
      this.activeChildren += 1;
      return;
    }
    await new Promise((resolve) => this.waitQueue.push(() => resolve(null)));
    this.activeChildren += 1;
  }

  _releaseSlot() {
    this.activeChildren = Math.max(0, this.activeChildren - 1);
    const next = this.waitQueue.shift();
    if (next) next();
  }

  pruneOldJobs(maxJobs = 64) {
    if (this.jobs.size <= maxJobs) return;
    for (const [id, j] of this.jobs.entries()) {
      if (j.status !== 'running') {
        this.jobs.delete(id);
        if (this.jobs.size <= maxJobs) break;
      }
    }
  }

  /**
   * Terminates all currently running child process trees (used on MCP server shutdown, `M-07`).
   */
  killAll() {
    let killed = 0;
    for (const j of this.jobs.values()) {
      if (j.status === 'running') {
        j.cancelled = true;
        j.status = 'cancelled';
        j.progressActive = false;
        if (j.pid) {
          killProcessTree(j.pid);
          killed += 1;
        }
      }
    }
    return killed;
  }

  /**
   * Spawns `node tools/aitest.mjs ...cliArgs` in an isolated child process.
   * @param {{
   *   toolName: string,
   *   cliArgs: string[],
   *   workspaceLockKey?: string | null,
   *   requestId?: string | number | null,
   *   sessionId?: string | null,
   *   syncBudgetMs?: number,
   *   forceAsync?: boolean,
   *   timeoutMs?: number,
   *   onProgress?: ((info: { progress: number, message: string }) => void) | null,
   *   customCommand?: { command: string, args: string[] } | null
   * }} spec
   */
  async executeOrBackground(spec) {
    this.pruneOldJobs();
    const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
    const ownerSessionId = spec.sessionId || 'default';
    const startedAt = new Date().toISOString();
    const syncBudgetMs =
      spec.syncBudgetMs !== undefined
        ? Number(spec.syncBudgetMs)
        : Number(process.env.AITEST_MCP_SYNC_BUDGET_MS || DEFAULT_SYNC_BUDGET_MS);
    const timeoutMs = spec.timeoutMs ?? 45 * 60_000;

    /** @type {any} */
    const jobRecord = {
      jobId,
      ownerSessionId,
      tool: spec.toolName,
      status: 'running',
      startedAt,
      finishedAt: null,
      pid: null,
      exitCode: null,
      progressLines: 0,
      progressActive: true,
      lastMessage: `Starting ${spec.toolName}`,
      rawStdout: '',
      stdout: '',
      stderr: '',
      parsedData: null,
      cancelled: false,
      timedOut: false,
      completionPromise: null,
    };

    this.jobs.set(jobId, jobRecord);
    const reqKey =
      spec.requestId !== undefined && spec.requestId !== null
        ? this._makeRequestKey(spec.requestId, ownerSessionId)
        : null;
    if (reqKey) {
      this.requestToJob.set(reqKey, jobId);
    }

    const startChild = async () => {
      await this._acquireSlot();
      try {
        return await new Promise((resolve) => {
          if (jobRecord.cancelled) {
            jobRecord.status = 'cancelled';
            jobRecord.exitCode = 130;
            jobRecord.finishedAt = new Date().toISOString();
            if (reqKey) this.requestToJob.delete(reqKey);
            resolve(jobRecord);
            return;
          }

          const cmd = spec.customCommand ? spec.customCommand.command : process.execPath;
          const cmdArgs = spec.customCommand ? spec.customCommand.args : [AITEST_BIN, ...spec.cliArgs];

          const child = spawn(cmd, cmdArgs, {
            cwd: process.cwd(),
            env: buildSafeChildEnv(process.env),
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          jobRecord.pid = child.pid || null;
          if (spec.onProgress && jobRecord.progressActive) {
            try {
              spec.onProgress({ progress: 0, message: jobRecord.lastMessage });
            } catch {
              // ignore callback failures
            }
          }

          const maxTimer =
            timeoutMs > 0
              ? setTimeout(() => {
                  jobRecord.timedOut = true;
                  killProcessTree(child.pid);
                }, timeoutMs)
              : null;

          child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
            const text = chunk.toString('utf8');
            jobRecord.rawStdout = appendBoundedBuffer(jobRecord.rawStdout, text, this.maxOutputBytes);
            const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
            if (lines.length > 0) {
              jobRecord.progressLines += lines.length;
              jobRecord.lastMessage = redactSecrets(lines[lines.length - 1]).slice(0, 180);
              if (jobRecord.progressActive && typeof spec.onProgress === 'function') {
                spec.onProgress({
                  progress: jobRecord.progressLines,
                  message: jobRecord.lastMessage,
                });
              }
            }
          });

          child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
            jobRecord.stderr = appendBoundedBuffer(jobRecord.stderr, chunk.toString('utf8'), this.maxOutputBytes);
          });

          child.on('error', (err) => {
            if (maxTimer) clearTimeout(maxTimer);
            if (reqKey) this.requestToJob.delete(reqKey);
            jobRecord.stderr = redactSecrets(appendBoundedBuffer(jobRecord.stderr, `\n${err.message}`, this.maxOutputBytes));
            jobRecord.exitCode = 1;
            jobRecord.status = 'failed';
            jobRecord.finishedAt = new Date().toISOString();
            resolve(jobRecord);
          });

          child.on('close', (code) => {
            if (maxTimer) clearTimeout(maxTimer);
            if (reqKey) this.requestToJob.delete(reqKey);
            jobRecord.finishedAt = new Date().toISOString();
            jobRecord.exitCode = jobRecord.cancelled ? 130 : typeof code === 'number' ? code : 1;

            // Parse JSON BEFORE redacting so workbench sessionId / jobId / runId stay intact (`M-01`)!
            const rawParsed = parseSubprocessJsonOutput(jobRecord.rawStdout);
            jobRecord.parsedData = rawParsed !== null ? redactStructuredValue(rawParsed) : null;
            jobRecord.stdout = redactSecrets(jobRecord.rawStdout);
            jobRecord.rawStdout = ''; // free raw buffer immediately
            jobRecord.stderr = redactSecrets(jobRecord.stderr);

            jobRecord.status = jobRecord.cancelled
              ? 'cancelled'
              : jobRecord.timedOut
                ? 'timed_out'
                : jobRecord.exitCode === 0
                  ? 'succeeded'
                  : 'failed';

            if (jobRecord.progressActive && typeof spec.onProgress === 'function' && !jobRecord.cancelled) {
              spec.onProgress({
                progress: jobRecord.progressLines + 1,
                message: `${spec.toolName} ${jobRecord.status} (exitCode=${jobRecord.exitCode})`,
              });
            }
            resolve(jobRecord);
          });
        });
      } finally {
        this._releaseSlot();
      }
    };

    jobRecord.completionPromise = withWorkspaceWriteLock(spec.workspaceLockKey || null, startChild);

    if (spec.forceAsync) {
      jobRecord.progressActive = false; // Stop request-bound progress notifications once response is sent (`M-10`)
      return { backgrounded: true, job: this.getPublicStatus(jobId, ownerSessionId) };
    }

    let budgetTimer = null;
    const raceWinner = await Promise.race([
      jobRecord.completionPromise.then(() => 'completed'),
      new Promise((resolve) => {
        budgetTimer = setTimeout(() => resolve('backgrounded'), Math.max(25, syncBudgetMs));
      }),
    ]);
    if (budgetTimer) clearTimeout(budgetTimer);

    if (raceWinner === 'backgrounded' && jobRecord.status === 'running') {
      jobRecord.progressActive = false; // MCP spec: do not emit progress notifications after response returned (`M-10`)
      return { backgrounded: true, job: this.getPublicStatus(jobId, ownerSessionId) };
    }

    return { backgrounded: false, job: jobRecord };
  }

  /** @param {string} jobId @param {string | null} [callerSessionId] */
  _getOwnedJob(jobId, callerSessionId = null) {
    const j = this.jobs.get(jobId);
    if (!j) return null;
    if (callerSessionId && j.ownerSessionId && j.ownerSessionId !== callerSessionId) {
      return null;
    }
    return j;
  }

  /** @param {string} jobId @param {string | null} [callerSessionId] */
  getPublicStatus(jobId, callerSessionId = null) {
    const j = this._getOwnedJob(jobId, callerSessionId);
    if (!j) return null;
    return {
      jobId: j.jobId,
      tool: j.tool,
      status: j.status,
      pid: j.pid,
      startedAt: j.startedAt,
      finishedAt: j.finishedAt,
      exitCode: j.exitCode,
      progressLines: j.progressLines,
      lastMessage: j.lastMessage,
    };
  }

  /** @param {string} jobId @param {number} [waitMs] @param {string | null} [callerSessionId] */
  async waitForResult(jobId, waitMs = 0, callerSessionId = null) {
    const j = this._getOwnedJob(jobId, callerSessionId);
    if (!j) return null;
    if (j.status === 'running' && waitMs > 0 && j.completionPromise) {
      let timer = null;
      await Promise.race([
        j.completionPromise,
        new Promise((resolve) => {
          timer = setTimeout(resolve, Math.min(60_000, waitMs));
        }),
      ]);
      if (timer) clearTimeout(timer);
    }
    return {
      ...this.getPublicStatus(jobId, callerSessionId),
      data: j.parsedData || (j.stdout ? { output: j.stdout.slice(0, 4000) } : {}),
      stderr: j.exitCode !== 0 && j.stderr ? j.stderr.slice(0, 2000) : undefined,
    };
  }

  /** @param {string} jobId @param {string | null} [callerSessionId] */
  cancelByJobId(jobId, callerSessionId = null) {
    const j = this._getOwnedJob(jobId, callerSessionId);
    if (!j) return { found: false, cancelled: false };
    if (j.status !== 'running') {
      return { found: true, cancelled: false, status: j.status };
    }
    j.cancelled = true;
    j.status = 'cancelled';
    j.progressActive = false;
    if (j.pid) {
      killProcessTree(j.pid);
    }
    return { found: true, cancelled: true, jobId, killedPid: j.pid };
  }

  /** @param {string | number} requestId @param {string | null} [callerSessionId] */
  cancelByRequestId(requestId, callerSessionId = 'default') {
    const scopedKey = this._makeRequestKey(requestId, callerSessionId);
    const jobId = this.requestToJob.get(scopedKey);
    if (!jobId) return { found: false, cancelled: false };
    return this.cancelByJobId(jobId, callerSessionId);
  }
}

export const defaultJobManager = new McpJobManager();
