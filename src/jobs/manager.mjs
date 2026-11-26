// @ts-check
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, killProcessTreeAsync } from '../core/proc.mjs';
import { redactSecrets, redactStructuredValue } from '../core/redact.mjs';
import {
  BARE_JSON_LINE_RE,
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_SYNC_BUDGET_MS,
  MAX_JOB_OUTPUT_BYTES,
  appendBoundedBuffer,
  buildJobFailureEnvelope,
  buildSafeChildEnv,
  emitJobProgressNotification,
  formatJobWaitResult,
  readFramedSubprocessResult,
  withWorkspaceWriteLock,
} from './workspace-lock.mjs';

export {
  DEFAULT_MAX_CONCURRENT_JOBS,
  DEFAULT_SYNC_BUDGET_MS,
  MAX_JOB_OUTPUT_BYTES,
  appendBoundedBuffer,
  buildSafeChildEnv,
  withWorkspaceWriteLock,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AITEST_BIN = path.resolve(__dirname, '..', '..', 'tools', 'aitest.mjs');

/**
 * Hardened child-process MCP Job Manager (`M-01`, `M-05`, `M-07`, `M-09`, `M-12`, `M-13`, `WU-02`).
 */
export class McpJobManager {
  /**
   * @param {{ maxConcurrentJobs?: number, maxOutputBytes?: number, lockTimeoutMs?: number }} [options]
   */
  constructor(options = {}) {
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string, string>} */
    this.requestToJob = new Map();
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.maxOutputBytes = options.maxOutputBytes ?? MAX_JOB_OUTPUT_BYTES;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 15_000;
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
        j.cancelling = true;
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
   * Spawns `node tools/aitest.mjs ...cliArgs` in an isolated child process with framed IPC.
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
      progressListeners: /** @type {Set<(info: { progress: number, message: string }) => void>} */ (new Set()),
      lastMessage: `Starting ${spec.toolName}`,
      rawStdout: '',
      stdout: '',
      stderr: '',
      parsedData: null,
      cancelling: false,
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

    const ipcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-ipc-'));
    const resultFilePath = path.join(ipcDir, `${jobId}.result.json`);
    const cleanupIpc = () => {
      try {
        fs.rmSync(ipcDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup failure
      }
    };

    const startChild = async () => {
      await this._acquireSlot();
      try {
        return await new Promise((resolve) => {
          if (jobRecord.cancelling) {
            jobRecord.cancelled = true;
            jobRecord.status = 'cancelled';
            jobRecord.exitCode = 130;
            jobRecord.finishedAt = new Date().toISOString();
            if (reqKey) this.requestToJob.delete(reqKey);
            cleanupIpc();
            resolve(jobRecord);
            return;
          }

          const cmd = spec.customCommand ? spec.customCommand.command : process.execPath;
          const cmdArgs = spec.customCommand ? spec.customCommand.args : [AITEST_BIN, ...spec.cliArgs];

          const child = spawn(cmd, cmdArgs, {
            cwd: process.cwd(),
            env: buildSafeChildEnv(process.env, spec.customCommand ? undefined : resultFilePath),
            shell: false,
            windowsHide: true,
            detached: process.platform !== 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          jobRecord.pid = child.pid || null;
          emitJobProgressNotification(jobRecord, spec.onProgress, { progress: 0, message: jobRecord.lastMessage });

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
            const lines = text
              .split(/\r?\n/)
              .map((s) => s.trim())
              .filter((s) => s.length > 0 && !BARE_JSON_LINE_RE.test(s));
            if (lines.length > 0) {
              jobRecord.progressLines += lines.length;
              jobRecord.lastMessage = redactSecrets(lines[lines.length - 1]).slice(0, 180);
              emitJobProgressNotification(jobRecord, spec.onProgress, {
                progress: jobRecord.progressLines,
                message: jobRecord.lastMessage,
              });
            }
          });

          child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
            jobRecord.stderr = appendBoundedBuffer(jobRecord.stderr, chunk.toString('utf8'), this.maxOutputBytes);
          });

          child.on('error', (err) => {
            if (maxTimer) clearTimeout(maxTimer);
            if (reqKey) this.requestToJob.delete(reqKey);
            cleanupIpc();
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
            if (jobRecord.cancelling) jobRecord.cancelled = true;
            jobRecord.exitCode = jobRecord.cancelled ? 130 : typeof code === 'number' ? code : 1;

            const rawParsed = readFramedSubprocessResult(spec.customCommand ? null : resultFilePath, jobRecord.rawStdout);
            cleanupIpc();
            jobRecord.parsedData = rawParsed !== null ? redactStructuredValue(rawParsed) : null;
            jobRecord.stdout = redactSecrets(jobRecord.rawStdout);
            jobRecord.rawStdout = '';
            jobRecord.stderr = redactSecrets(jobRecord.stderr);

            jobRecord.status = jobRecord.cancelled
              ? 'cancelled'
              : jobRecord.timedOut
                ? 'timed_out'
                : jobRecord.exitCode === 0
                  ? 'succeeded'
                  : 'failed';

            if (!jobRecord.cancelled) {
              emitJobProgressNotification(jobRecord, spec.onProgress, {
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

    const runPromise = withWorkspaceWriteLock(
      spec.workspaceLockKey || null,
      startChild,
      this.lockTimeoutMs,
      { toolName: spec.toolName, jobId }
    ).catch((err) => {
      cleanupIpc();
      if (reqKey) this.requestToJob.delete(reqKey);
      if (jobRecord.cancelling) {
        jobRecord.cancelled = true;
        jobRecord.finishedAt = new Date().toISOString();
        jobRecord.exitCode = 130;
        jobRecord.status = 'cancelled';
        return jobRecord;
      }
      const built = buildJobFailureEnvelope(spec.toolName, err);
      jobRecord.finishedAt = new Date().toISOString();
      jobRecord.exitCode = built.exitCode;
      jobRecord.status = 'failed';
      jobRecord.lastMessage = built.lastMessage;
      jobRecord.parsedData = built.parsedData;
      return jobRecord;
    });

    jobRecord.completionPromise = runPromise;

    if (spec.forceAsync) {
      jobRecord.progressActive = false;
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
      jobRecord.progressActive = false;
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

  /**
   * @param {string} jobId
   * @param {number} [waitMs]
   * @param {string | null} [callerSessionId]
   * @param {{ onProgress?: ((info: { progress: number, message: string }) => void) | null }} [options]
   */
  async waitForResult(jobId, waitMs = 0, callerSessionId = null, options = {}) {
    const j = this._getOwnedJob(jobId, callerSessionId);
    if (!j) return null;
    if (j.status === 'running' && waitMs > 0 && j.completionPromise) {
      const listener = typeof options?.onProgress === 'function' ? options.onProgress : null;
      if (listener) {
        j.progressListeners.add(listener);
        try {
          listener({ progress: j.progressLines, message: j.lastMessage });
        } catch {
          // ignore initial progress delivery error
        }
      }
      let timer = null;
      try {
        await Promise.race([
          j.completionPromise,
          new Promise((resolve) => {
            timer = setTimeout(resolve, Math.min(60_000, waitMs));
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
        if (listener) j.progressListeners.delete(listener);
      }
    }
    return formatJobWaitResult(j, this.getPublicStatus(jobId, callerSessionId));
  }

  /** @param {string} jobId @param {string | null} [callerSessionId] */
  cancelByJobId(jobId, callerSessionId = null) {
    const j = this._getOwnedJob(jobId, callerSessionId);
    if (!j) return { found: false, cancelled: false };
    if (j.status !== 'running') {
      return { found: true, cancelled: false, status: j.status };
    }
    j.cancelling = true;
    j.progressActive = false;
    if (j.pid) {
      killProcessTree(j.pid, { graceMs: 5000 });
    }
    return { found: true, cancelled: true, jobId, status: j.status, killedPid: j.pid };
  }

  /** @param {string} jobId @param {string | null} [callerSessionId] */
  async cancelByJobIdAndWait(jobId, callerSessionId = null) {
    const res = this.cancelByJobId(jobId, callerSessionId);
    if (!res.found || !res.cancelled) return res;
    const j = this._getOwnedJob(jobId, callerSessionId);
    if (!j) return res;
    if (j.pid) {
      await killProcessTreeAsync(j.pid, { graceMs: 5000 });
    }
    if (j.completionPromise) {
      await Promise.race([
        j.completionPromise,
        new Promise((resolve) => setTimeout(resolve, 1500)),
      ]);
    }
    return { found: true, cancelled: true, jobId, status: j.status, killedPid: j.pid };
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
