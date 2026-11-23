import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SECRET_KEYS = /(password|passwd|secret|token|cookie|authorization|api[_-]?key|session[_-]?id|bearer)/i;

/**
 * Redacts credentials, cookies, tokens, and authorization headers from text output.
 */
export function redactSecrets(input) {
  if (!input || typeof input !== 'string') return '';
  let out = input;
  // 1. Redact HTTP header lines (Authorization, Cookie, Set-Cookie, X-Api-Key) completely to end of line
  out = out.replace(
    /(\b(?:authorization|cookie|set-cookie|x-api-key)\s*:\s*)([^\r\n]+)/gi,
    '$1[REDACTED]'
  );
  // 2. Redact standalone Bearer tokens anywhere in text
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
  // 3. Redact Basic auth in URLs: http://user:pass@host
  out = out.replace(/(https?:\/\/[^:\s/@]+:)([^@\s/]+)(@)/gi, '$1[REDACTED]$3');
  // 4. Redact KEY=VALUE or KEY: VALUE secret assignments
  out = out.replace(
    /(\b(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|COOKIE|API_KEY|SESSION_ID)|password|passwd|secret|token|api_key|session_id)\b\s*[:=]\s*)([^\s\r\n"']+|"[^"]*"|'[^']*')/gi,
    '$1[REDACTED]'
  );
  return out;
}

/**
 * Redacts sensitive environment variable dictionaries before printing or saving diagnostics.
 */
export function redactEnvEntries(envObj) {
  const result = {};
  for (const [k, v] of Object.entries(envObj || {})) {
    result[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : v;
  }
  return result;
}

/**
 * Resolves the bundled npm-cli.js path relative to the active Node binary so we never spawn npm.cmd with shell:false on Windows.
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
 * Runs a command safely using argument arrays and shell: false.
 */
export function runProcess(command, args = [], options = {}) {
  const {
    cwd = process.cwd(),
    env = process.env,
    inheritStdio = false,
    capture = true,
    timeoutMs = 0,
    windowsHide = true,
  } = options;

  // Inside stdio MCP server, child processes MUST NEVER write raw text to OS stdout FD 1
  const capturedStdioMode = inheritStdio && process.env.AITEST_MCP_CAPTURED_STDIO === '1';
  const effectiveInherit = inheritStdio && !capturedStdioMode;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell: false,
      windowsHide,
      stdio: effectiveInherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timer = null;

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGTERM');
      }, timeoutMs);
    }

    if (!effectiveInherit && (capture || capturedStdioMode)) {
      child.stdout?.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        if (capturedStdioMode) {
          const trimmed = text.replace(/\r?\n$/, '');
          if (trimmed) console.log(trimmed);
        }
      });
      child.stderr?.on('data', (chunk) => {
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
      reject(err);
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: typeof code === 'number' ? code : 1,
        signal: signal || null,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Probes an external CLI tool's version safely (handles Windows .exe and .ps1 shims without shell:true).
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
    return { installed: true, path: resolved.path, version: `error: ${err.message}` };
  }
}

/**
 * Invokes npm safely via Node + npm-cli.js (or POSIX npm) with shell: false.
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
 */
export function resolvePlaywrightCli(qaDir) {
  const candidates = [
    path.join(qaDir, 'node_modules', '@playwright', 'test', 'cli.js'),
    path.join(qaDir, 'node_modules', 'playwright', 'cli.js'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

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
