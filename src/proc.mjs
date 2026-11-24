// @ts-check
import { execFile, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SECRET_KEYS =
  /(password|passwd|pwd|secret|client[_-]?secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|cookie|authorization|api[_-]?key|private[_-]?key|session[_-]?id|bearer|jwt|otp|pin|hmac[_-]?key)/i;

const JSON_SECRET_KEY_PATTERN =
  'password|passwd|pwd|secret|client_secret|clientSecret|token|access_token|accessToken|refresh_token|refreshToken|id_token|idToken|auth_token|authToken|api_key|apiKey|private_key|privateKey|session_id|sessionId|cookie|authorization|bearer|jwt|otp|pin|secretKey|secret_key|hmac_key|hmacKey';

/**
 * Internal AI Test Workbench correlation/session IDs that are NEVER credentials (`M-01`).
 * Preserving these avoids breaking MCP heal/job/ledger workflows while still redacting
 * external application session cookies/tokens such as `{"sessionId":"sid_cookie_val_888"}`.
 */
const WORKBENCH_INTERNAL_ID_KEYS = new Set([
  'sessionId',
  'jobId',
  'runId',
  'traceId',
  'spanId',
  'testId',
  'snapshotId',
  'requestId',
  'correlationId',
]);

const WORKBENCH_SAFE_ID_VALUE_RE =
  /^(?:heal_[0-9a-f]{8,32}|job_[0-9a-f]{8,32}|exp_[0-9a-f]{8,32}|snap_[0-9a-f]{8,32}|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Redacts credentials, JSON secret fields, JWTs, API tokens, private keys, cookies,
 * query-string tokens, and Basic auth URLs from arbitrary text output (`S-05` Redaction v2).
 * Preserves internal workbench `heal_*` / `job_*` / ULID identifiers (`M-01`).
 * @param {string} input
 */
export function redactSecrets(input) {
  if (!input || typeof input !== 'string') return '';
  let out = input;

  // 1. Redact PEM private keys completely
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    '[REDACTED_PRIVATE_KEY]'
  );

  // 2. Redact HTTP header lines (Authorization, Proxy-Authorization, Cookie, Set-Cookie, X-Api-Key, X-Auth-Token)
  out = out.replace(
    /(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|api-key)\s*:\s*)(?!\s*["'])(?![[{])([^\r\n]+)/gi,
    '$1[REDACTED]'
  );

  // 3. Redact JSON string/primitive key-value pairs while keeping JSON valid AND preserving internal workbench IDs (`M-01`)
  const jsonDoubleRe = new RegExp(
    `("([A-Za-z0-9_.-]*?(?:${JSON_SECRET_KEY_PATTERN}))"\\s*:\\s*)("(?:\\\\.|[^"\\\\])*"|'[^']*'|\\d[\\d.]*)`,
    'gi'
  );
  out = out.replace(jsonDoubleRe, (full, prefix, keyName, rawVal) => {
    const bareVal = String(rawVal || '').replace(/^["']|["']$/g, '');
    if (WORKBENCH_INTERNAL_ID_KEYS.has(keyName) && WORKBENCH_SAFE_ID_VALUE_RE.test(bareVal)) {
      return full;
    }
    return `${prefix}"[REDACTED]"`;
  });

  const jsonSingleRe = new RegExp(
    `('([A-Za-z0-9_.-]*?(?:${JSON_SECRET_KEY_PATTERN}))'\\s*:\\s*)('(?:\\\\.|[^'\\\\])*'|"[^"]*"|\\d[\\d.]*)`,
    'gi'
  );
  out = out.replace(jsonSingleRe, (full, prefix, keyName, rawVal) => {
    const bareVal = String(rawVal || '').replace(/^["']|["']$/g, '');
    if (WORKBENCH_INTERNAL_ID_KEYS.has(keyName) && WORKBENCH_SAFE_ID_VALUE_RE.test(bareVal)) {
      return full;
    }
    return `${prefix}'[REDACTED]'`;
  });

  // 4. Redact standalone JWT tokens (eyJ...header.eyJ...payload.signature) anywhere in text/JSON/URLs
  out = out.replace(/\beyJ[A-Za-z0-9_-]{6,}\.eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED_JWT]');

  // 5. Redact standalone Bearer / Basic tokens
  out = out.replace(/(\bBearer\s+)[A-Za-z0-9\-._~+/]+=*/gi, '$1[REDACTED]');
  out = out.replace(/(\bBasic\s+)[A-Za-z0-9+/]{8,}=*/gi, '$1[REDACTED]');

  // 6. Redact well-known cloud / SaaS secret token prefixes
  out = out.replace(
    /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghu_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{22,}|glpat-[A-Za-z0-9_-]{16,}|glsa_[A-Za-z0-9_]{16,}|sntrys_[A-Za-z0-9_]{16,}|sk-proj-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9]{20,}|sk_live_[A-Za-z0-9]{16,}|rk_live_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{16,}|AKIA[0-9A-Z]{16})\b/g,
    '[REDACTED_TOKEN]'
  );

  // 7. Redact credentials in URLs (http/https/postgres/mysql/redis/mongodb/amqp)
  out = out.replace(/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^:\s/@]*:)([^@\s/'"]+)(@)/g, '$1[REDACTED]$3');

  // 8. Redact sensitive URL query string parameters (?token=zzz&api_key=xxx)
  out = out.replace(
    /([?&](?:token|access_token|refresh_token|id_token|auth_token|api_key|apikey|password|passwd|pwd|secret|client_secret|session_id|sessionid|sig|signature|ticket|otp)=)([^&#\s"']+)/gi,
    '$1[REDACTED]'
  );

  // 9. Redact inline cookie fragments (`connect.sid=...`, `JSESSIONID=...`, `PHPSESSID=...`, `session_id=...`)
  out = out.replace(
    /(\b(?:connect\.sid|jsessionid|phpsessid|session_id|sessionid|auth_token|remember_token)\s*=\s*)([^;\s"'\r\n]+)/gi,
    '$1[REDACTED]'
  );

  // 10. Redact KEY=VALUE or KEY: VALUE secret assignments
  out = out.replace(
    /(\b(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|PWD|SECRET|TOKEN|COOKIE|API_KEY|PRIVATE_KEY|SESSION_ID)|password|passwd|pwd|secret|client_secret|token|access_token|refresh_token|api_key|private_key|session_id)\b\s*[:=]\s*)(?!\[REDACTED)([^\s\r\n"',;}]+|"[^"]*"|'[^']*')/gi,
    '$1[REDACTED]'
  );

  return out;
}

/**
 * Recursively redacts secrets inside a parsed JSON object/array AFTER parsing (`M-01`),
 * preserving allowlisted workbench correlation IDs (`sessionId`, `jobId`, `runId`, `traceId`, `testId`)
 * while strictly redacting credentials, tokens, passwords, and embedded secrets inside strings.
 * @template T
 * @param {T} value
 * @param {string} [parentKey]
 * @returns {T}
 */
export function redactStructuredValue(value, parentKey = '') {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (WORKBENCH_INTERNAL_ID_KEYS.has(parentKey)) {
      // Preserve genuine workbench IDs; still scrub if value looks like a JWT/token/external cookie
      if (WORKBENCH_SAFE_ID_VALUE_RE.test(value) || parentKey === 'testId') {
        return /** @type {any} */ (value);
      }
      if (/^sessionId$/i.test(parentKey) && !WORKBENCH_SAFE_ID_VALUE_RE.test(value)) {
        return /** @type {any} */ ('[REDACTED]');
      }
      return /** @type {any} */ (redactSecrets(value));
    }
    if (parentKey && SECRET_KEYS.test(parentKey)) {
      return /** @type {any} */ ('[REDACTED]');
    }
    return /** @type {any} */ (redactSecrets(value));
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    if (parentKey && !WORKBENCH_INTERNAL_ID_KEYS.has(parentKey) && SECRET_KEYS.test(parentKey)) {
      return /** @type {any} */ ('[REDACTED]');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return /** @type {any} */ (value.map((item) => redactStructuredValue(item, '')));
  }
  if (typeof value === 'object') {
    /** @type {Record<string, any>} */
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactStructuredValue(v, k);
    }
    return /** @type {any} */ (out);
  }
  return value;
}

/**
 * Redacts sensitive environment variable dictionaries before printing or saving diagnostics.
 * @param {Record<string, any>} envObj
 */
export function redactEnvEntries(envObj) {
  /** @type {Record<string, any>} */
  const result = {};
  for (const [k, v] of Object.entries(envObj || {})) {
    result[k] = SECRET_KEYS.test(k) ? '[REDACTED]' : typeof v === 'string' ? redactSecrets(v) : v;
  }
  return result;
}

/**
 * Terminates a child process and its entire descendant tree cleanly across Windows & POSIX (`R0-3`).
 * @param {number | undefined} pid
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
 * @param {Record<string, any>} [options]
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
      resolve({ code: 130, signal: 'SIGTERM', timedOut: false, cancelled: true, stdout: '', stderr: 'Aborted before spawn' });
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
      child.stdout?.on('data', (chunk) => {
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
 * @param {string[]} args
 * @param {Record<string, any>} [options]
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

/**
 * @param {string} qaDir
 * @param {string[]} args
 * @param {Record<string, any>} [options]
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
