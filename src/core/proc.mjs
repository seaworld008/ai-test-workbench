// @ts-check
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolvePlaywrightCli } from './playwright-resolve.mjs';

const execFileAsync = promisify(execFile);

/**
 * @typedef {{
 *   cwd?: string;
 *   env?: NodeJS.ProcessEnv;
 *   inheritStdio?: boolean;
 *   capture?: boolean;
 *   timeoutMs?: number;
 *   windowsHide?: boolean;
 *   signal?: AbortSignal | null;
 *   onStdoutLine?: ((line: string) => void) | null;
 * }} RunProcessOptions
 */

/**
 * @typedef {{
 *   code: number;
 *   signal: NodeJS.Signals | null;
 *   timedOut: boolean;
 *   cancelled: boolean;
 *   stdout: string;
 *   stderr: string;
 * }} RunProcessResult
 */

/**
 * Terminates a child process and its entire descendant tree cleanly across Windows & POSIX.
 * @param {number | undefined} pid
 * @returns {void}
 */
export function killProcessTree(pid) {
  if (!pid || typeof pid !== 'number') return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        shell: false,
        windowsHide: true,
        stdio: 'ignore',
      });
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        process.kill(pid, 'SIGTERM');
      }
    }
  } catch {
    // process already exited
  }
}

/**
 * Resolves the bundled npm-cli.js path relative to the active Node binary so we never spawn npm.cmd with shell:false on Windows.
 * @returns {string | null}
 */
export function resolveNpmCliPath() {
  const execDir = path.dirname(process.execPath);
  const candidates = [
    path.join(execDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(execDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  if (process.env.npm_execpath && process.env.npm_execpath.endsWith('.js') && fs.existsSync(process.env.npm_execpath)) {
    return process.env.npm_execpath;
  }
  return null;
}

/**
 * Resolves a tool executable cleanly without shell interpolation.
 * @param {string} toolName
 * @returns {Promise<{ kind: 'exe' | 'ps1' | 'other' | 'bin', path: string } | null>}
 */
export async function findExecutable(toolName) {
  const isWin = process.platform === 'win32';
  const locator = isWin ? 'where.exe' : 'which';
  try {
    const { stdout } = await execFileAsync(locator, [toolName], { windowsHide: true });
    const lines = stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (lines.length === 0) return null;
    if (isWin) {
      const exe = lines.find((l) => l.toLowerCase().endsWith('.exe'));
      if (exe) return { kind: 'exe', path: exe };
      const ps1 = lines.find((l) => l.toLowerCase().endsWith('.ps1'));
      if (ps1) return { kind: 'ps1', path: ps1 };
      for (const line of lines) {
        const ps1Sibling = `${line.replace(/\.(cmd|bat)$/i, '')}.ps1`;
        if (fs.existsSync(ps1Sibling)) {
          return { kind: 'ps1', path: ps1Sibling };
        }
      }
      return { kind: 'other', path: lines[0] };
    }
    return { kind: 'bin', path: lines[0] };
  } catch {
    return null;
  }
}

/**
 * Runs a command safely using argument arrays and `shell: false`, supporting timeouts, cancellation signals,
 * and full process-tree cleanup.
 * @param {string} command
 * @param {string[]} [args]
 * @param {RunProcessOptions} [options]
 * @returns {Promise<RunProcessResult>}
 */
export function runProcess(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    inheritStdio = false,
    capture = true,
    timeoutMs = 0,
    windowsHide = true,
    signal = null,
    onStdoutLine = null,
  } = options;

  const capturedStdioMode = inheritStdio && process.env.AITEST_MCP_CAPTURED_STDIO === '1';
  const effectiveInherit = inheritStdio && !capturedStdioMode;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      resolve({
        code: 130,
        signal: 'SIGTERM',
        timedOut: false,
        cancelled: true,
        stdout: '',
        stderr: 'Aborted before spawn',
      });
      return;
    }

    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide,
      detached: process.platform !== 'win32' && !effectiveInherit,
      stdio: effectiveInherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    const onAbort = () => {
      cancelled = true;
      killProcessTree(child.pid);
    };

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child.pid);
      }, timeoutMs);
    }

    if (!effectiveInherit && (capture || capturedStdioMode)) {
      child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (typeof onStdoutLine === 'function') {
          for (const line of text.split(/\r?\n/).filter(Boolean)) {
            onStdoutLine(line);
          }
        }
        if (capturedStdioMode) {
          const trimmed = text.replace(/\r?\n$/, '');
          if (trimmed) console.log(trimmed);
        }
      });
      child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
        const text = chunk.toString();
        stderr += text;
        if (capturedStdioMode) {
          const trimmed = text.replace(/\r?\n$/, '');
          if (trimmed) console.error(trimmed);
        }
      });
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      reject(err);
    });

    child.on('close', (code, closeSignal) => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve({
        code: typeof code === 'number' ? code : cancelled ? 130 : 1,
        signal: closeSignal || null,
        timedOut,
        cancelled,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Probes an external CLI tool's version safely (handles Windows .exe and .ps1 shims without shell:true).
 * @param {string} toolName
 * @param {string[]} [versionArgs]
 * @returns {Promise<{ installed: boolean, path: string | null, version: string | null }>}
 */
export async function probeToolVersion(toolName, versionArgs = ['--version']) {
  const resolved = await findExecutable(toolName);
  if (!resolved) return { installed: false, path: null, version: null };

  try {
    if (resolved.kind === 'ps1') {
      const pwsh = (await findExecutable('pwsh')) || (await findExecutable('powershell'));
      if (!pwsh) return { installed: true, path: resolved.path, version: 'installed (pwsh missing)' };
      const res = await runProcess(
        pwsh.path,
        ['-NoProfile', '-NonInteractive', '-File', resolved.path, ...versionArgs],
        { timeoutMs: 8000 }
      );
      const output = (res.stdout || res.stderr).trim().split(/\r?\n/)[0] || '';
      return { installed: res.code === 0, path: resolved.path, version: output || 'unknown' };
    }
    const res = await runProcess(resolved.path, versionArgs, { timeoutMs: 8000 });
    const output = (res.stdout || res.stderr).trim().split(/\r?\n/)[0] || '';
    return { installed: res.code === 0, path: resolved.path, version: output || 'unknown' };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { installed: true, path: resolved.path, version: `error: ${msg}` };
  }
}

/**
 * Invokes npm safely via Node + npm-cli.js (or POSIX npm) with shell: false.
 * @param {string[]} args
 * @param {RunProcessOptions} [options]
 * @returns {Promise<RunProcessResult>}
 */
export async function runNpm(args, options = {}) {
  const npmCli = resolveNpmCliPath();
  if (npmCli) {
    return runProcess(process.execPath, [npmCli, ...args], options);
  }
  if (process.platform !== 'win32') {
    return runProcess('npm', args, options);
  }
  throw new Error('Cannot locate npm-cli.js next to node.exe on Windows.');
}

/**
 * Invokes local Playwright CLI inside a QA project directory via Node with shell: false.
 * @param {string} qaDir
 * @param {string[]} args
 * @param {RunProcessOptions} [options]
 * @returns {Promise<RunProcessResult>}
 */
export async function runPlaywright(qaDir, args, options = {}) {
  const cliPath = resolvePlaywrightCli(qaDir);
  if (!cliPath) {
    throw new Error(
      `Playwright CLI not found in ${qaDir}. Run npm install or npm ci inside the QA directory first.`
    );
  }
  return runProcess(process.execPath, [cliPath, ...args], {
    cwd: qaDir,
    ...options,
  });
}
