// @ts-check
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { killProcessTree, redactSecrets } from './proc.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AITEST_BIN = path.resolve(__dirname, '..', 'tools', 'aitest.mjs');

export const DEFAULT_SYNC_BUDGET_MS = 45_000;

/** @type {Map<string, Promise<any>>} */
const workspaceLocks = new Map();

/**
 * Per-workspace async mutex (`M-03`): serializes write operations ONLY for the same `workspaceKey`
 * while allowing read-only tools and different workspaces to execute concurrently!
 * @template T
 * @param {string | null} workspaceKey
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export function withWorkspaceWriteLock(workspaceKey, fn) {
  if (!workspaceKey) return fn();
  const normKey = path.resolve(workspaceKey).toLowerCase();
  const prev = workspaceLocks.get(normKey) || Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.finally(() => {
    if (workspaceLocks.get(normKey) === tracked) {
      workspaceLocks.delete(normKey);
    }
  });
  workspaceLocks.set(normKey, tracked);
  return next;
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
 * Manages child-process MCP jobs with progress notifications, sync budget backgrounding,
 * request-ID cancellation (`notifications/cancelled`), and process-tree cleanup (`R0-3`).
 */
export class McpJobManager {
  constructor() {
    /** @type {Map<string, any>} */
    this.jobs = new Map();
    /** @type {Map<string | number, string>} */
    this.requestToJob = new Map();
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
   * Spawns `node tools/aitest.mjs ...cliArgs` in an isolated child process.
   * @param {{
   *   toolName: string,
   *   cliArgs: string[],
   *   workspaceLockKey?: string | null,
   *   requestId?: string | number | null,
   *   syncBudgetMs?: number,
   *   forceAsync?: boolean,
   *   timeoutMs?: number,
   *   onProgress?: ((info: { progress: number, total?: number, message: string }) => void) | null,
   *   customCommand?: { command: string, args: string[] } | null
   * }} spec
   */
  async executeOrBackground(spec) {
    this.pruneOldJobs();
    const jobId = `job_${crypto.randomBytes(8).toString('hex')}`;
    const startedAt = new Date().toISOString();
    const syncBudgetMs =
      spec.syncBudgetMs !== undefined
        ? Number(spec.syncBudgetMs)
        : Number(process.env.AITEST_MCP_SYNC_BUDGET_MS || DEFAULT_SYNC_BUDGET_MS);
    const timeoutMs = spec.timeoutMs ?? 45 * 60_000;

    /** @type {any} */
    const jobRecord = {
      jobId,
      tool: spec.toolName,
      status: 'running',
      startedAt,
      finishedAt: null,
      pid: null,
      exitCode: null,
      progressLines: 0,
      lastMessage: `Starting ${spec.toolName}`,
      stdout: '',
      stderr: '',
      parsedData: null,
      cancelled: false,
      timedOut: false,
      completionPromise: null,
    };

    this.jobs.set(jobId, jobRecord);
    if (spec.requestId !== undefined && spec.requestId !== null) {
      this.requestToJob.set(spec.requestId, jobId);
    }

    const startChild = () =>
      new Promise((resolve) => {
        if (jobRecord.cancelled) {
          jobRecord.status = 'cancelled';
          jobRecord.exitCode = 130;
          jobRecord.finishedAt = new Date().toISOString();
          resolve(jobRecord);
          return;
        }

        const cmd = spec.customCommand ? spec.customCommand.command : process.execPath;
        const cmdArgs = spec.customCommand ? spec.customCommand.args : [AITEST_BIN, ...spec.cliArgs];

        const child = spawn(cmd, cmdArgs, {
          cwd: process.cwd(),
          env: {
            ...process.env,
            AITEST_MCP_CHILD: '1',
          },
          shell: false,
          windowsHide: true,
          detached: process.platform !== 'win32',
          stdio: ['ignore', 'pipe', 'pipe'],
        });

        jobRecord.pid = child.pid || null;

        const maxTimer =
          timeoutMs > 0
            ? setTimeout(() => {
                jobRecord.timedOut = true;
                killProcessTree(child.pid);
              }, timeoutMs)
            : null;

        child.stdout?.on('data', (chunk) => {
          const text = chunk.toString('utf8');
          jobRecord.stdout += text;
          const lines = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          if (lines.length > 0) {
            jobRecord.progressLines += lines.length;
            jobRecord.lastMessage = redactSecrets(lines[lines.length - 1]).slice(0, 180);
            if (typeof spec.onProgress === 'function') {
              spec.onProgress({
                progress: Math.min(95, jobRecord.progressLines * 5),
                total: 100,
                message: jobRecord.lastMessage,
              });
            }
          }
        });

        child.stderr?.on('data', (chunk) => {
          jobRecord.stderr += chunk.toString('utf8');
        });

        child.on('error', (err) => {
          if (maxTimer) clearTimeout(maxTimer);
          jobRecord.stderr += `\n${err.message}`;
          jobRecord.exitCode = 1;
          jobRecord.status = 'failed';
          jobRecord.finishedAt = new Date().toISOString();
          resolve(jobRecord);
        });

        child.on('close', (code) => {
          if (maxTimer) clearTimeout(maxTimer);
          if (spec.requestId !== undefined && spec.requestId !== null) {
            this.requestToJob.delete(spec.requestId);
          }
          jobRecord.finishedAt = new Date().toISOString();
          jobRecord.exitCode = jobRecord.cancelled ? 130 : typeof code === 'number' ? code : 1;
          jobRecord.stdout = redactSecrets(jobRecord.stdout);
          jobRecord.stderr = redactSecrets(jobRecord.stderr);
          jobRecord.parsedData = parseSubprocessJsonOutput(jobRecord.stdout);
          jobRecord.status = jobRecord.cancelled
            ? 'cancelled'
            : jobRecord.timedOut
              ? 'timed_out'
              : jobRecord.exitCode === 0
                ? 'succeeded'
                : 'failed';

          if (typeof spec.onProgress === 'function' && !jobRecord.cancelled) {
            spec.onProgress({
              progress: 100,
              total: 100,
              message: `${spec.toolName} ${jobRecord.status} (exitCode=${jobRecord.exitCode})`,
            });
          }
          resolve(jobRecord);
        });
      });

    jobRecord.completionPromise = withWorkspaceWriteLock(spec.workspaceLockKey || null, startChild);

    if (spec.forceAsync) {
      return { backgrounded: true, job: this.getPublicStatus(jobId) };
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
      return { backgrounded: true, job: this.getPublicStatus(jobId) };
    }

    return { backgrounded: false, job: jobRecord };
  }

  getPublicStatus(jobId) {
    const j = this.jobs.get(jobId);
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

  async waitForResult(jobId, waitMs = 0) {
    const j = this.jobs.get(jobId);
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
      ...this.getPublicStatus(jobId),
      data: j.parsedData || (j.stdout ? { output: j.stdout.slice(0, 4000) } : {}),
      stderr: j.stderr ? j.stderr.slice(0, 2000) : undefined,
    };
  }

  cancelByJobId(jobId) {
    const j = this.jobs.get(jobId);
    if (!j) return { found: false, cancelled: false };
    if (j.status !== 'running') {
      return { found: true, cancelled: false, status: j.status };
    }
    j.cancelled = true;
    j.status = 'cancelled';
    if (j.pid) {
      killProcessTree(j.pid);
    }
    return { found: true, cancelled: true, jobId, killedPid: j.pid };
  }

  cancelByRequestId(requestId) {
    const jobId = this.requestToJob.get(requestId);
    if (!jobId) return { found: false, cancelled: false };
    return this.cancelByJobId(jobId);
  }
}

export const defaultJobManager = new McpJobManager();
