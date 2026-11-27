// @ts-check
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEFAULT_GRAPH_ENGINE_ID = 'codebase-memory-mcp';
export const PINNED_CBM_VERSION = '0.12.1';
export const WINDOWS_RUNTIME_DIR_MAX_CHARS = 185;
export const MACOS_RUNTIME_DIR_MAX_BYTES = 60;

const WIN_ACL_ERROR_RE =
  /(?:could not load saved runtime settings|secure CLI coordination|win_private_directory|DACL entry grants mutation rights|untrusted identity|endpoint\)|private[_ -]?directory)/i;
const WIN_UNTRUSTED_ANCESTOR_ACE_RE = /(?:CodexSandboxUsers|Authenticated Users|Everyone|BUILTIN\\Users):(?:\([^)]*\))*(?:\([A-Z,]*(?:M|W|F|D|WD|AD|DC)[A-Z,]*\))/i;
/** @type {Map<string, boolean>} */
const ancestorAclCache = new Map();
/** @type {Set<string>} */
const hardenedWinDirs = new Set();

/** Detects CBM Windows NTFS ancestor/DACL failure messages. @param {string} text @returns {boolean} */
export function isWindowsAncestorAclError(text) {
  return WIN_ACL_ERROR_RE.test(String(text || ''));
}

/**
 * Resolves fallback directories on Windows: honors `AITEST_DATA_DIR` / `AITEST_CBM_RUNTIME_DIR` /
 * `AITEST_CBM_CACHE_DIR` first, otherwise falls back to 1-level drive-root dirs (`C:\aitw-rt`, `C:\aitw-cbm`)
 * to bypass untrusted ancestor ACEs on `C:\Users\<user>` (e.g. `CodexSandboxUsers`).
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveWindowsDriveFallbackDirs(env = process.env) {
  const customDataDir = String(env.AITEST_DATA_DIR || '').trim();
  const explicitRuntime = String(env.AITEST_CBM_RUNTIME_DIR || '').trim();
  const explicitCache = String(env.AITEST_CBM_CACHE_DIR || '').trim();
  if (customDataDir) {
    return {
      runtimeDir: explicitRuntime || path.win32.join(customDataDir, 'rt'),
      cacheDir: explicitCache || path.win32.join(customDataDir, 'cbm'),
    };
  }
  const drive = String(env.SystemDrive || 'C:').trim().replace(/\\+$/, '') || 'C:';
  if (explicitRuntime || explicitCache) {
    return {
      runtimeDir: explicitRuntime || `${drive}\\aitw-rt`,
      cacheDir: explicitCache || `${drive}\\aitw-cbm`,
    };
  }
  return {
    runtimeDir: `${drive}\\aitw-rt`,
    cacheDir: `${drive}\\aitw-cbm`,
  };
}

/**
 * Checks whether a Windows directory or its user-profile ancestor carries untrusted mutation ACEs
 * rejected by CBM's `win_private_directory_tree_secure` (cached per process).
 * @param {string} dirPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function hasUntrustedWindowsAncestorAcl(dirPath, env = process.env) {
  if (process.platform !== 'win32') return false;
  const norm = path.win32.normalize(String(dirPath || ''));
  const userProfile = String(env.USERPROFILE || '').trim();
  const target =
    userProfile && norm.toLowerCase().startsWith(path.win32.normalize(userProfile).toLowerCase())
      ? path.win32.normalize(userProfile)
      : path.win32.dirname(norm);
  if (!target || /^[A-Za-z]:\\?$/.test(target)) return false;
  const key = target.toLowerCase();
  if (ancestorAclCache.has(key)) return Boolean(ancestorAclCache.get(key));
  try {
    const out = execFileSync('icacls', [target], { windowsHide: true, encoding: 'utf8', timeout: 3000 });
    const untrusted = WIN_UNTRUSTED_ANCESTOR_ACE_RE.test(out);
    ancestorAclCache.set(key, untrusted);
    return untrusted;
  } catch {
    ancestorAclCache.set(key, false);
    return false;
  }
}

/**
 * Creates a directory on Windows and applies a protected owner-only DACL via `icacls`
 * (`/inheritance:r /grant:r "<user>:(OI)(CI)F"`, `shell: false`, `windowsHide: true`).
 * @param {string} dirPath
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ ok: boolean, dirPath: string }}
 */
export function hardenWindowsOwnerOnlyDir(dirPath, env = process.env) {
  fs.mkdirSync(dirPath, { recursive: true });
  if (process.platform !== 'win32') return { ok: true, dirPath };
  const key = path.win32.normalize(dirPath).toLowerCase();
  if (hardenedWinDirs.has(key)) return { ok: true, dirPath };
  const user = String(env.USERNAME || os.userInfo().username || '').trim();
  if (!user) return { ok: false, dirPath };
  try {
    execFileSync('icacls', [dirPath, '/inheritance:r', '/grant:r', `${user}:(OI)(CI)F`], {
      windowsHide: true,
      stdio: 'pipe',
      timeout: 5000,
    });
    hardenedWinDirs.add(key);
    return { ok: true, dirPath };
  } catch {
    return { ok: false, dirPath };
  }
}

/**
 * @typedef {{ asset: string; sha256: string; archiveType: 'zip' | 'tar.gz'; binaryName: string; alternateAssets?: ReadonlyArray<{ asset: string; sha256: string }> }} PlatformAssetSpec
 * @typedef {{ id: string; displayName: string; repo: string; license: string; pinnedVersion: string; releaseBaseUrl: string; cliDisableUiArg: string; platforms: Readonly<Record<string, PlatformAssetSpec>> }} EngineManifest
 */

/**
 * Verified official SHA-256 checksums for `DeusData/codebase-memory-mcp` `v0.12.1`
 * from `https://github.com/DeusData/codebase-memory-mcp/releases/download/v0.12.1/checksums.txt`.
 * @type {Readonly<Record<string, EngineManifest>>}
 */
export const ENGINE_MANIFESTS = Object.freeze({
  'codebase-memory-mcp': Object.freeze({
    id: 'codebase-memory-mcp',
    displayName: 'Codebase Memory MCP (Sidecar Graph Engine)',
    repo: 'DeusData/codebase-memory-mcp',
    license: 'MIT',
    pinnedVersion: PINNED_CBM_VERSION,
    releaseBaseUrl: `https://github.com/DeusData/codebase-memory-mcp/releases/download/v${PINNED_CBM_VERSION}`,
    cliDisableUiArg: '--ui=false',
    platforms: Object.freeze({
      'win32-x64': Object.freeze({
        asset: 'codebase-memory-mcp-windows-amd64.zip',
        sha256: '4e4e0f16b45233af5c757a1fcbe3c3b16e9056375b1fbe2ce020b6de75dedcc0',
        archiveType: 'zip',
        binaryName: 'codebase-memory-mcp.exe',
      }),
      'win32-arm64': Object.freeze({
        asset: 'codebase-memory-mcp-windows-arm64.zip',
        sha256: '934ab6bd67a76c6ebd9e110d87b7090ffd629919bedaeddabe5a19175038b063',
        archiveType: 'zip',
        binaryName: 'codebase-memory-mcp.exe',
      }),
      'darwin-arm64': Object.freeze({
        asset: 'codebase-memory-mcp-darwin-arm64.tar.gz',
        sha256: '9bfcbe38414b47969a3e1d1c1999f5357409387c86fa3d24221b5458267660d2',
        archiveType: 'tar.gz',
        binaryName: 'codebase-memory-mcp',
      }),
      'darwin-x64': Object.freeze({
        asset: 'codebase-memory-mcp-darwin-amd64.tar.gz',
        sha256: 'ca6e64397a8ae80cec898a8205a6aa16750ac798acc05a0c3ed983837944a581',
        archiveType: 'tar.gz',
        binaryName: 'codebase-memory-mcp',
      }),
      'linux-x64': Object.freeze({
        asset: 'codebase-memory-mcp-linux-amd64-portable.tar.gz',
        sha256: '8c3d0341064301e78ecc84cf7348d4e2c6562a0f57448243ea560aaa34de36c1',
        archiveType: 'tar.gz',
        binaryName: 'codebase-memory-mcp',
        alternateAssets: Object.freeze([Object.freeze({ asset: 'codebase-memory-mcp-linux-amd64.tar.gz', sha256: '8453015145f072c1b9b019cbdd02cea8cc6f18cc5e116036dd20992631c638c7' })]),
      }),
      'linux-arm64': Object.freeze({
        asset: 'codebase-memory-mcp-linux-arm64-portable.tar.gz',
        sha256: 'ed0f1f548cd79b121c401c2e9f7841c189a001af26d3768368088c24f6a53533',
        archiveType: 'tar.gz',
        binaryName: 'codebase-memory-mcp',
        alternateAssets: Object.freeze([Object.freeze({ asset: 'codebase-memory-mcp-linux-arm64.tar.gz', sha256: '8575f126092660b93b170bdc2e06f3ef2dd28d3cc49ad6d0895dc3e4767219cd' })]),
      }),
    }),
  }),
});

/**
 * Returns the pinned sidecar manifest for an engine ID.
 * @param {string} [id]
 * @returns {EngineManifest | null}
 */
export function getPinnedEngineManifest(id = DEFAULT_GRAPH_ENGINE_ID) {
  return ENGINE_MANIFESTS[id] || null;
}

/**
 * Resolves the verified release asset specification for a target OS and CPU architecture.
 * @param {string} [id]
 * @param {string} [platform]
 * @param {string} [arch]
 */
export function resolvePlatformAsset(
  id = DEFAULT_GRAPH_ENGINE_ID,
  platform = process.platform,
  arch = process.arch
) {
  const manifest = getPinnedEngineManifest(id);
  if (!manifest) return null;
  const platformKey = `${platform}-${arch}`;
  const spec = manifest.platforms[platformKey];
  if (!spec) return null;
  return {
    id: manifest.id,
    version: manifest.pinnedVersion,
    platformKey,
    asset: spec.asset,
    sha256: spec.sha256,
    archiveType: spec.archiveType,
    binaryName: spec.binaryName,
    alternateAssets: spec.alternateAssets ? [...spec.alternateAssets] : [],
    downloadUrl: `${manifest.releaseBaseUrl}/${spec.asset}`,
  };
}

/**
 * Returns true when two Windows paths differ solely by NTFS 8.3 short-name segments
 * (e.g. `C:\work\RUNNER~1\Temp` vs `C:\work\runneradmin\Temp`)
 * and no differing ancestor segment is a symlink/junction reparse point.
 * @param {string} rawPath
 * @param {string} realPath
 * @param {{ checkFs?: boolean }} [options]
 * @returns {boolean}
 */
export function isWindows83ShortNameAliasOnly(rawPath, realPath, options = {}) {
  const rawSegs = path.win32.normalize(String(rawPath || '')).replace(/\\+$/, '').split('\\');
  const realSegs = path.win32.normalize(String(realPath || '')).replace(/\\+$/, '').split('\\');
  if (rawSegs.length !== realSegs.length || rawSegs.length < 2) return false;
  if (rawSegs[0].toLowerCase() !== realSegs[0].toLowerCase()) return false;
  let sawShort = false;
  for (let i = 1; i < rawSegs.length; i += 1) {
    const a = rawSegs[i].toLowerCase();
    const b = realSegs[i].toLowerCase();
    if (a === b) continue;
    if (!/~\d+(?:\.[^.\\]+)?$/.test(a)) return false;
    if (options.checkFs !== false) {
      try {
        if (fs.lstatSync(rawSegs.slice(0, i + 1).join('\\')).isSymbolicLink()) return false;
      } catch {
        return false;
      }
    }
    sawShort = true;
  }
  return sawShort;
}

/**
 * Validates candidate runtime/cache dir against CBM OS rules: no `.aitest/` nesting,
 * Windows `< 185` chars & no reparse/symlink ancestors, macOS `<= 60` bytes AF_UNIX budget, no WSL `/mnt/*`.
 * @param {string} dirPath
 * @param {{ platform?: string, checkFs?: boolean }} [options]
 * @returns {{ safe: boolean, issues: string[], warnings: string[], normalizedPath: string }}
 */
export function validateRuntimeDirSafety(dirPath, options = {}) {
  const platform = options.platform || process.platform;
  const checkFs = options.checkFs !== false;
  /** @type {string[]} */
  const issues = [];
  /** @type {string[]} */
  const warnings = [];
  const raw = String(dirPath || '').trim();
  if (!raw) return { safe: false, issues: ['Runtime directory path is empty.'], warnings, normalizedPath: '' };

  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const normalizedPath = pathApi.normalize(raw);
  const slashPath = normalizedPath.replace(/\\/g, '/');

  if (!pathApi.isAbsolute(normalizedPath)) {
    issues.push(`Runtime directory must be an absolute path (got "${raw}").`);
  }
  if (/(?:^|\/)\.aitest(?:\/|$)/i.test(slashPath)) {
    issues.push('Runtime/cache directory must NEVER be placed under <qaDir>/.aitest/ (breaks Windows MAX_PATH & NTFS ACL checks).');
  }
  if (platform === 'win32') {
    if (normalizedPath.length >= WINDOWS_RUNTIME_DIR_MAX_CHARS) {
      issues.push(`Windows runtime path length (${normalizedPath.length}) >= ${WINDOWS_RUNTIME_DIR_MAX_CHARS} chars (MAX_PATH 260 risk).`);
    }
    if (/^[a-zA-Z]:\\(?:Windows|Program Files)/i.test(normalizedPath)) {
      issues.push(`Windows runtime path "${normalizedPath}" targets a system-owned directory.`);
    }
  } else if (platform === 'darwin') {
    const byteLen = Buffer.byteLength(normalizedPath, 'utf8');
    if (byteLen > MACOS_RUNTIME_DIR_MAX_BYTES) {
      issues.push(`macOS runtime path is ${byteLen}B (> ${MACOS_RUNTIME_DIR_MAX_BYTES}B budget for 104B AF_UNIX socket).`);
    }
  } else if (platform === 'linux' && /^\/mnt\/[a-zA-Z](?:\/|$)/.test(slashPath)) {
    issues.push('Linux/WSL2 runtime/cache directory cannot reside on DrvFs (/mnt/*); use native Linux filesystem.');
  }

  if (checkFs && platform === process.platform) {
    let cursor = normalizedPath;
    for (let depth = 0; depth < 16; depth += 1) {
      try {
        if (fs.existsSync(cursor)) {
          if (fs.lstatSync(cursor).isSymbolicLink()) {
            issues.push(`Directory or ancestor "${cursor}" is a symlink/reparse point (rejected by CBM).`);
            break;
          }
          if (platform === 'win32') {
            const real = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native(cursor) : fs.realpathSync(cursor);
            if (
              path.win32.normalize(real).toLowerCase() !== path.win32.normalize(cursor).toLowerCase() &&
              !isWindows83ShortNameAliasOnly(cursor, real, { checkFs: true })
            ) {
              issues.push(`Windows ancestor "${cursor}" resolves to "${real}" (junction/reparse point rejected by CBM).`);
              break;
            }
          }
          break;
        }
      } catch {
        warnings.push(`Could not inspect filesystem attributes for "${cursor}".`);
        break;
      }
      const parent = path.dirname(cursor);
      if (!parent || parent === cursor) break;
      cursor = parent;
    }
  }
  return { safe: issues.length === 0, issues, warnings, normalizedPath };
}

/**
 * Resolves short, owner-only, out-of-workspace binary/runtime/cache directories isolated from any
 * developer-global CBM version cohort.
 * @param {string} [id]
 * @param {string} [version]
 * @param {{ platform?: string; arch?: string; env?: NodeJS.ProcessEnv; homeDir?: string; uid?: number; runtimeDir?: string; cacheDir?: string; binBaseDir?: string; checkFs?: boolean }} [overrides]
 */
export function resolveIsolatedEngineDirs(id = DEFAULT_GRAPH_ENGINE_ID, version = undefined, overrides = {}) {
  const manifest = getPinnedEngineManifest(id);
  const resolvedVersion = String(version || manifest?.pinnedVersion || PINNED_CBM_VERSION).replace(/^v/i, '');
  const platform = overrides.platform || process.platform;
  const env = overrides.env || process.env;
  const homeDir = overrides.homeDir || env.HOME || env.USERPROFILE || os.homedir();
  const uid = typeof overrides.uid === 'number' ? overrides.uid : typeof process.getuid === 'function' ? process.getuid() : 0;
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const binaryName = platform === 'win32' ? `${id}.exe` : id;
  const shortKey = id === DEFAULT_GRAPH_ENGINE_ID ? 'cbm' : id.replace(/[^a-z0-9_-]/gi, '').slice(0, 12) || 'eng';

  const hasExplicitEnv = Boolean(overrides.env);
  const allowHostDataEnv = hasExplicitEnv || !overrides.platform || overrides.platform === process.platform;
  const customDataDir = allowHostDataEnv ? String(env.AITEST_DATA_DIR || '').trim() : '';
  const customBinDir = allowHostDataEnv ? String(env.AITEST_CBM_BIN_DIR || '').trim() : '';

  let binBaseDir = '';
  let primaryRuntimeDir = '';
  let fallbackRuntimeDir = '';
  let defaultCacheDir = '';

  if (customDataDir) {
    binBaseDir = overrides.binBaseDir || customBinDir || pathApi.join(customDataDir, 'bin', shortKey);
    primaryRuntimeDir = pathApi.join(customDataDir, 'rt');
    fallbackRuntimeDir = pathApi.join(customDataDir, 'rt');
    defaultCacheDir = pathApi.join(customDataDir, shortKey);
  } else if (platform === 'win32') {
    const localAppData = String(env.LOCALAPPDATA || '').trim() || pathApi.join(homeDir, 'AppData', 'Local');
    binBaseDir = overrides.binBaseDir || customBinDir || pathApi.join(localAppData, 'aitw', 'bin', shortKey);
    primaryRuntimeDir = pathApi.join(localAppData, 'aitw', 'rt');
    fallbackRuntimeDir = pathApi.join(homeDir, '.aitw', 'rt');
    defaultCacheDir = pathApi.join(localAppData, 'aitw', shortKey);
  } else if (platform === 'darwin') {
    binBaseDir = overrides.binBaseDir || customBinDir || pathApi.join(homeDir, 'Library', 'Caches', 'aitw', 'bin', shortKey);
    primaryRuntimeDir = `/private/tmp/aitw-rt-${uid}`;
    fallbackRuntimeDir = `/tmp/aitw-rt-${uid}`;
    defaultCacheDir = pathApi.join(homeDir, 'Library', 'Caches', 'aitw', shortKey);
  } else {
    const xdgCache = String(env.XDG_CACHE_HOME || '').trim() || pathApi.join(homeDir, '.cache');
    const xdgRuntime = String(env.XDG_RUNTIME_DIR || '').trim();
    binBaseDir = overrides.binBaseDir || customBinDir || pathApi.join(xdgCache, 'aitw', 'bin', shortKey);
    primaryRuntimeDir = xdgRuntime ? pathApi.join(xdgRuntime, `aitw-rt-${uid}`) : `/tmp/aitw-rt-${uid}`;
    fallbackRuntimeDir = `/tmp/aitw-rt-${uid}`;
    defaultCacheDir = pathApi.join(xdgCache, 'aitw', shortKey);
  }

  const explicitRuntime = allowHostDataEnv
    ? String(overrides.runtimeDir || env.AITEST_CBM_RUNTIME_DIR || '').trim()
    : String(overrides.runtimeDir || '').trim();
  const explicitCache = allowHostDataEnv
    ? String(overrides.cacheDir || env.AITEST_CBM_CACHE_DIR || '').trim()
    : String(overrides.cacheDir || '').trim();
  let runtimeDir = explicitRuntime || primaryRuntimeDir;
  let safety = validateRuntimeDirSafety(runtimeDir, { platform, checkFs: overrides.checkFs });
  if (!explicitRuntime && !safety.safe && fallbackRuntimeDir) {
    const fbSafety = validateRuntimeDirSafety(fallbackRuntimeDir, { platform, checkFs: overrides.checkFs });
    if (fbSafety.safe) {
      runtimeDir = fallbackRuntimeDir;
      safety = fbSafety;
    }
  }
  const cacheDir = explicitCache || defaultCacheDir;
  const cacheSafety = validateRuntimeDirSafety(cacheDir, { platform, checkFs: overrides.checkFs });
  const binDir = pathApi.join(binBaseDir, resolvedVersion);

  return {
    id, version: resolvedVersion, platform, binBaseDir, binDir, binaryName,
    binaryPath: pathApi.join(binDir, binaryName),
    runtimeDir, fallbackRuntimeDir, cacheDir, safety, cacheSafety,
  };
}
