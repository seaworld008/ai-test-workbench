// @ts-check
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { killProcessTree } from '../../core/proc.mjs';
import { buildSafeChildEnv } from '../../jobs/workspace-lock.mjs';
import {
  DEFAULT_GRAPH_ENGINE_ID,
  hardenWindowsOwnerOnlyDir,
  hasUntrustedWindowsAncestorAcl,
  isWindowsAncestorAclError,
  resolveIsolatedEngineDirs,
  resolveWindowsDriveFallbackDirs,
} from './engine-manifest.mjs';

export const MAX_CBM_OUTPUT_BYTES = 24 * 1024 * 1024; // 24 MB bounded JSON output cap for paginated 1M-LOC Cypher pages
export const DEFAULT_CBM_QUERY_TIMEOUT_MS = 30_000;
export const DEFAULT_CBM_INDEX_TIMEOUT_MS = 180_000;

const PROXY_KEYS_TO_SCRUB = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const JSON_FORMAT_TOOLS = new Set([
  'list_projects', 'search_graph', 'query_graph', 'trace_path',
  'detect_changes', 'check_index_coverage', 'index_status', 'get_graph_schema',
]);
const NO_REQUIRED_ARGS_TOOLS = new Set(['list_projects']);

/**
 * Builds an isolated, proxy-scrubbed child environment for `codebase-memory-mcp`.
 * Always injects BOTH `CBM_RUNTIME_DIR` and `CBM_CACHE_DIR` together to isolate from global CBM cohorts.
 * @param {{ runtimeDir: string; cacheDir: string; allowedRoot?: string; maxRssMb?: number; baseEnv?: NodeJS.ProcessEnv }} opts
 * @returns {Record<string, string>}
 */
export function buildCbmChildEnv(opts) {
  const env = buildSafeChildEnv(opts.baseEnv || process.env);
  for (const key of PROXY_KEYS_TO_SCRUB) delete env[key];
  delete env.AITEST_HMAC_KEY_FILE;
  delete env.AITEST_MCP_CHILD;
  env.NO_PROXY = '*';
  env.no_proxy = '*';
  env.CBM_RUNTIME_DIR = opts.runtimeDir;
  env.CBM_CACHE_DIR = opts.cacheDir;
  if (opts.allowedRoot) env.CBM_ALLOWED_ROOT = opts.allowedRoot;
  if (typeof opts.maxRssMb === 'number' && Number.isFinite(opts.maxRssMb) && opts.maxRssMb > 0) {
    env.CBM_INDEX_MAX_RSS_MB = String(Math.floor(opts.maxRssMb));
  }
  return env;
}

/**
 * Parses raw MCP CLI stdout envelope (`{"content":[{"type":"text","text":"..."}],"isError":bool}`).
 * @param {string} stdoutText
 * @returns {{ ok: boolean, isError: boolean, data: any, rawText: string }}
 */
export function parseCbmCliOutput(stdoutText) {
  const trimmed = String(stdoutText || '').trim();
  if (!trimmed) return { ok: false, isError: true, data: null, rawText: '' };
  let parsed = null;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    const lastIdx = trimmed.lastIndexOf('\n{');
    if (lastIdx === -1) return { ok: false, isError: true, data: null, rawText: trimmed };
    try {
      parsed = JSON.parse(trimmed.slice(lastIdx + 1).trim());
    } catch {
      return { ok: false, isError: true, data: null, rawText: trimmed };
    }
  }
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.content)) {
    const isError = Boolean(parsed.isError);
    const firstText = parsed.content.find((/** @type {any} */ c) => c && typeof c.text === 'string')?.text ?? '';
    let inner = firstText;
    if (typeof firstText === 'string' && (firstText.trim().startsWith('{') || firstText.trim().startsWith('['))) {
      try { inner = JSON.parse(firstText); } catch { inner = firstText; }
    }
    return { ok: !isError, isError, data: inner, rawText: firstText };
  }
  const isError = Boolean(parsed && typeof parsed === 'object' && parsed.isError === true);
  return { ok: !isError, isError, data: parsed, rawText: trimmed };
}

/** @param {Record<string, unknown>} params @returns {string[]} */
function buildFlagArgs(params) {
  /** @type {string[]} */
  const flags = [];
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const flag = `--${k.replace(/_/g, '-')}`;
    if (typeof v === 'boolean') { if (v) flags.push(flag); }
    else if (typeof v === 'number' || typeof v === 'string') flags.push(flag, String(v));
  }
  return flags;
}

/**
 * Spawns `codebase-memory-mcp` with `shell: false`, `windowsHide: true`, timeout + `killProcessTree()`,
 * and bounded 8 MB stdout cap.
 * @param {string} binaryPath
 * @param {string[]} args
 * @param {{ cwd?: string; env: Record<string, string>; stdinText?: string | null; timeoutMs?: number; maxOutputBytes?: number }} opts
 * @returns {Promise<{ ok: boolean; code: number; timedOut: boolean; outputCapped: boolean; stdout: string; stderr: string; error?: string }>}
 */
export function runCbmProcess(binaryPath, args, opts) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CBM_QUERY_TIMEOUT_MS;
  const maxOutputBytes = opts.maxOutputBytes ?? MAX_CBM_OUTPUT_BYTES;

  return new Promise((resolve) => {
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let timedOut = false;
    let outputCapped = false;
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    let child;
    try {
      child = spawn(binaryPath, args, {
        cwd: opts.cwd || process.cwd(),
        env: opts.env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, code: 1, timedOut: false, outputCapped: false, stdout: '', stderr: '', error: err instanceof Error ? err.message : String(err) });
      return;
    }

    /** @param {{ ok: boolean, code: number, error?: string }} outcome */
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ...outcome,
        timedOut,
        outputCapped,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      });
    };

    if (timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; killProcessTree(child.pid, { graceMs: 1000 }); }, timeoutMs);
    }

    child.stdout?.on('data', (/** @type {Buffer} */ chunk) => {
      if (outputCapped) return;
      if (stdoutBytes + chunk.length > maxOutputBytes) {
        const rem = Math.max(0, maxOutputBytes - stdoutBytes);
        if (rem > 0) stdoutChunks.push(chunk.subarray(0, rem));
        stdoutBytes = maxOutputBytes;
        outputCapped = true;
        killProcessTree(child.pid, { graceMs: 500 });
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr?.on('data', (/** @type {Buffer} */ chunk) => {
      const cap = 512 * 1024;
      if (stderrBytes >= cap) return;
      stderrChunks.push(stderrBytes + chunk.length > cap ? chunk.subarray(0, cap - stderrBytes) : chunk);
      stderrBytes += chunk.length;
    });

    child.on('error', (err) => finish({ ok: false, code: 1, error: err instanceof Error ? err.message : String(err) }));
    child.on('close', (code) => {
      const exitCode = typeof code === 'number' ? code : 1;
      if (timedOut) return finish({ ok: false, code: exitCode || 124, error: `CBM command timed out after ${timeoutMs}ms.` });
      if (outputCapped) return finish({ ok: false, code: exitCode || 1, error: `CBM stdout exceeded ${maxOutputBytes} byte safety cap.` });
      finish({ ok: exitCode === 0, code: exitCode });
    });

    try {
      if (opts.stdinText !== undefined && opts.stdinText !== null) child.stdin?.end(opts.stdinText, 'utf8');
      else child.stdin?.end();
    } catch {
      // ignore EPIPE if child exited early
    }
  });
}

/**
 * Creates a typed, isolated CLI client for a pinned `codebase-memory-mcp` binary (`v0.12.1`).
 * @param {{ binaryPath: string; runtimeDir?: string; cacheDir?: string; allowedRoot?: string; timeoutMs?: number; indexTimeoutMs?: number; maxOutputBytes?: number; maxRssMb?: number; baseEnv?: NodeJS.ProcessEnv; cwd?: string; processRunner?: typeof runCbmProcess }} options
 */
export function createCbmClient(options) {
  const execCbm = options.processRunner || runCbmProcess;
  const baseEnv = options.baseEnv || process.env;
  const dirs = resolveIsolatedEngineDirs(DEFAULT_GRAPH_ENGINE_ID, undefined, {
    runtimeDir: options.runtimeDir, cacheDir: options.cacheDir, env: baseEnv,
  });
  const isLiveWin = process.platform === 'win32' && !options.processRunner;
  const winFallback = resolveWindowsDriveFallbackDirs(baseEnv);
  let runtimeDir = options.runtimeDir || dirs.runtimeDir;
  let cacheDir = options.cacheDir || dirs.cacheDir;
  let usingDriveFallback = false;

  const sameAsFallback =
    path.win32.normalize(winFallback.runtimeDir).toLowerCase() === path.win32.normalize(runtimeDir).toLowerCase() &&
    path.win32.normalize(winFallback.cacheDir).toLowerCase() === path.win32.normalize(cacheDir).toLowerCase();
  const hasExplicitDirConfig = Boolean(
    options.runtimeDir || options.cacheDir || baseEnv.AITEST_DATA_DIR || baseEnv.AITEST_CBM_RUNTIME_DIR || baseEnv.AITEST_CBM_CACHE_DIR
  );

  if (isLiveWin && !sameAsFallback && !hasExplicitDirConfig && (hasUntrustedWindowsAncestorAcl(runtimeDir, baseEnv) || hasUntrustedWindowsAncestorAcl(cacheDir, baseEnv))) {
    try {
      hardenWindowsOwnerOnlyDir(winFallback.runtimeDir, baseEnv);
      hardenWindowsOwnerOnlyDir(winFallback.cacheDir, baseEnv);
      runtimeDir = winFallback.runtimeDir;
      cacheDir = winFallback.cacheDir;
      usingDriveFallback = true;
    } catch {
      // fall through to configured dirs; callTool retry handles any runtime ACL error
    }
  }

  const defaultTimeoutMs = options.timeoutMs ?? DEFAULT_CBM_QUERY_TIMEOUT_MS;
  const defaultIndexTimeoutMs = options.indexTimeoutMs ?? DEFAULT_CBM_INDEX_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_CBM_OUTPUT_BYTES;

  /** @param {string} [allowedRoot] */
  const makeEnv = (allowedRoot) => {
    if (isLiveWin) {
      hardenWindowsOwnerOnlyDir(runtimeDir, baseEnv);
      hardenWindowsOwnerOnlyDir(cacheDir, baseEnv);
    } else {
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return buildCbmChildEnv({
      runtimeDir, cacheDir, allowedRoot: allowedRoot || options.allowedRoot, maxRssMb: options.maxRssMb, baseEnv,
    });
  };

  /**
   * Executes one CBM MCP tool via `codebase-memory-mcp --ui=false cli --quiet --json <tool>`.
   * Automatically falls back to owner-only 1-level drive-root dirs (`C:\aitw-rt`, `C:\aitw-cbm`) on Windows ACL failure.
   * @param {string} toolName
   * @param {Record<string, unknown>} [params]
   * @param {{ timeoutMs?: number, allowedRoot?: string }} [callOpts]
   */
  async function callTool(toolName, params = {}, callOpts = {}) {
    /** @type {Record<string, unknown>} */
    const payload = { ...params };
    if (JSON_FORMAT_TOOLS.has(toolName) && payload.format === undefined) payload.format = 'json';
    const useFlagForm = NO_REQUIRED_ARGS_TOOLS.has(toolName);
    const args = useFlagForm
      ? ['--ui=false', 'cli', '--quiet', '--json', toolName, ...buildFlagArgs(payload)]
      : ['--ui=false', 'cli', '--quiet', '--json', toolName];
    let res = await execCbm(options.binaryPath, args, {
      cwd: options.cwd,
      env: makeEnv(callOpts.allowedRoot),
      stdinText: useFlagForm ? null : JSON.stringify(payload),
      timeoutMs: callOpts.timeoutMs ?? defaultTimeoutMs,
      maxOutputBytes,
    });
    if (!res.ok && isLiveWin && !usingDriveFallback && !sameAsFallback && isWindowsAncestorAclError(`${res.stderr}\n${res.stdout}\n${res.error || ''}`)) {
      try {
        hardenWindowsOwnerOnlyDir(winFallback.runtimeDir, baseEnv);
        hardenWindowsOwnerOnlyDir(winFallback.cacheDir, baseEnv);
        runtimeDir = winFallback.runtimeDir;
        cacheDir = winFallback.cacheDir;
        usingDriveFallback = true;
        res = await execCbm(options.binaryPath, args, {
          cwd: options.cwd,
          env: makeEnv(callOpts.allowedRoot),
          stdinText: useFlagForm ? null : JSON.stringify(payload),
          timeoutMs: callOpts.timeoutMs ?? defaultTimeoutMs,
          maxOutputBytes,
        });
      } catch {
        // return original failure
      }
    }
    const parsed = parseCbmCliOutput(res.stdout);
    if (!res.ok) {
      return {
        ok: false, tool: toolName, code: res.code, timedOut: res.timedOut, outputCapped: res.outputCapped,
        error: res.error || (typeof parsed.data === 'string' && parsed.data) || res.stderr.trim() || `Exit code ${res.code}`,
        data: parsed.data, stderr: res.stderr,
      };
    }
    return {
      ok: parsed.ok, tool: toolName, code: res.code, timedOut: false, outputCapped: false,
      error: parsed.ok ? null : typeof parsed.data === 'string' ? parsed.data : parsed.rawText || 'CBM tool returned isError=true',
      data: parsed.data, stderr: res.stderr,
    };
  }

  return {
    binaryPath: options.binaryPath,
    runtimeDir,
    cacheDir,
    callTool,

    async getVersion() {
      const res = await execCbm(options.binaryPath, ['--version'], {
        cwd: options.cwd, env: makeEnv(), timeoutMs: Math.min(defaultTimeoutMs, 5000), maxOutputBytes: 64 * 1024,
      });
      const text = `${res.stdout}\n${res.stderr}`.trim();
      const match = text.match(/\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/);
      return { ok: res.ok, version: match ? match[1] : null, raw: text, error: res.ok ? null : res.error || text };
    },

    /** @param {{ detail?: 'identity' | 'stats', limit?: number, offset?: number }} [opts] */
    listProjects(opts = {}) {
      return callTool('list_projects', { format: 'json', ...opts });
    },

    /** @param {string} repoPath @param {{ mode?: 'full' | 'moderate' | 'fast', name?: string, timeoutMs?: number }} [opts] */
    indexRepository(repoPath, opts = {}) {
      const resolvedRepo = path.resolve(repoPath);
      /** @type {Record<string, unknown>} */
      const params = { repo_path: resolvedRepo, mode: opts.mode || 'moderate' };
      if (opts.name) params.name = opts.name;
      return callTool('index_repository', params, { timeoutMs: opts.timeoutMs ?? defaultIndexTimeoutMs, allowedRoot: options.allowedRoot || resolvedRepo });
    },

    /** @param {string} project @param {{ paths?: string[], scopes?: string[], diagnostics?: 'none' | 'full', pathLimit?: number }} [opts] */
    checkIndexCoverage(project, opts = {}) {
      /** @type {Record<string, unknown>} */
      const params = { project, diagnostics: opts.diagnostics || 'full', format: 'json' };
      if (Array.isArray(opts.paths) && opts.paths.length > 0) params.paths = opts.paths.slice(0, 128);
      else if (Array.isArray(opts.scopes) && opts.scopes.length > 0) params.scopes = opts.scopes.slice(0, 64);
      else params.scopes = ['.'];
      if (typeof opts.pathLimit === 'number') params.path_limit = opts.pathLimit;
      return callTool('check_index_coverage', params);
    },

    /** @param {string} project @param {string} cypher @param {{ maxRows?: number, offset?: number, cursor?: string, maxOutputTokens?: number, timeoutMs?: number }} [opts] */
    queryGraph(project, cypher, opts = {}) {
      /** @type {Record<string, unknown>} */
      const params = { project, query: cypher, format: 'json', max_rows: opts.maxRows ?? 2000, max_output_tokens: opts.maxOutputTokens ?? 200_000 };
      if (typeof opts.offset === 'number' && opts.offset > 0) params.offset = opts.offset;
      if (opts.cursor) params.cursor = opts.cursor;
      return callTool('query_graph', params, { timeoutMs: opts.timeoutMs });
    },

    /** @param {string} project @param {string} symbol @param {{ direction?: 'inbound' | 'outbound' | 'both', depth?: number, limit?: number, mode?: string, includeTests?: boolean }} [opts] */
    tracePath(project, symbol, opts = {}) {
      return callTool('trace_path', {
        project, function_name: symbol, direction: opts.direction || 'both', depth: opts.depth ?? 3,
        limit: opts.limit ?? 100, mode: opts.mode || 'calls', include_tests: Boolean(opts.includeTests), format: 'json',
      });
    },

    /** @param {string} project @param {{ scope?: 'files' | 'impact' | 'tests', direction?: 'inbound' | 'outbound' | 'both', depth?: number, baseRef?: string }} [opts] */
    detectChanges(project, opts = {}) {
      /** @type {Record<string, unknown>} */
      const params = { project, scope: opts.scope || 'impact', direction: opts.direction || 'inbound', depth: opts.depth ?? 3, format: 'json' };
      if (opts.baseRef) params.base_ref = opts.baseRef;
      return callTool('detect_changes', params);
    },

    /** @param {string} project @param {{ query?: string, label?: string, namePattern?: string, filePattern?: string, limit?: number, maxOutputTokens?: number }} [opts] */
    searchGraph(project, opts = {}) {
      /** @type {Record<string, unknown>} */
      const params = { project, limit: opts.limit ?? 50, max_output_tokens: opts.maxOutputTokens ?? 3200, format: 'json' };
      if (opts.query) params.query = opts.query;
      if (opts.label) params.label = opts.label;
      if (opts.namePattern) params.name_pattern = opts.namePattern;
      if (opts.filePattern) params.file_pattern = opts.filePattern;
      return callTool('search_graph', params);
    },
  };
}
