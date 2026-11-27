// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable, runProcess } from '../../core/proc.mjs';
import {
  DEFAULT_GRAPH_ENGINE_ID,
  getPinnedEngineManifest,
  resolveIsolatedEngineDirs,
  resolvePlatformAsset,
  validateRuntimeDirSafety,
} from './engine-manifest.mjs';

const MANIFEST_FILENAME = 'engine-manifest.json';
const HASH_CHUNK_BYTES = 1024 * 1024;
const AV_QUARANTINE_RE = /(?:virus|potentially unwanted|wacatac|trojan|defender|blocked by.*policy|operation did not complete successfully)/i;
const ACL_FAILURE_RE = /(?:private[_ -]?directory|acl|icacls|reparse|ancestor|ownership|security descriptor|unsafe filesystem|endpoint)/i;

/**
 * Computes lowercase hex SHA-256 of a file using bounded 1MB chunks.
 * @param {string} filePath
 * @returns {string}
 */
export function computeFileSha256(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n <= 0) break;
      hash.update(n === buf.length ? buf : buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Timing-safe SHA-256 verification against one or more accepted hex digests.
 * @param {string} filePath
 * @param {string | string[]} expectedSha256
 */
export function verifyBinaryChecksum(filePath, expectedSha256) {
  const expected = (Array.isArray(expectedSha256) ? expectedSha256 : [expectedSha256])
    .map((h) => String(h || '').trim().toLowerCase().replace(/^sha256:/, ''))
    .filter((h) => /^[0-9a-f]{64}$/.test(h));
  if (!expected.length) return { ok: false, actualSha256: '', expectedSha256: [], reason: 'Invalid or missing expected SHA-256 digest.' };
  if (!fs.existsSync(filePath)) return { ok: false, actualSha256: '', expectedSha256: expected, reason: `File not found: ${filePath}` };
  const actualSha256 = computeFileSha256(filePath);
  const actualBuf = Buffer.from(actualSha256, 'hex');
  const matched = expected.some((c) => { const b = Buffer.from(c, 'hex'); return b.length === actualBuf.length && crypto.timingSafeEqual(actualBuf, b); });
  return { ok: matched, actualSha256, expectedSha256: expected, ...(matched ? {} : { reason: `SHA-256 mismatch: actual=${actualSha256}, expected=${expected.join('|')}` }) };
}

/** @param {string | undefined} qaDir @returns {Record<string, any> | null} */
export function readEngineManifestRecord(qaDir) {
  if (!qaDir) return null;
  const p = path.join(qaDir, '.aitest', MANIFEST_FILENAME);
  if (!fs.existsSync(p)) return null;
  try { const parsed = JSON.parse(fs.readFileSync(p, 'utf8')); return parsed && typeof parsed === 'object' ? parsed : null; } catch { return null; }
}

/**
 * Resolves the active installed binary path for a pinned graph engine.
 * @param {string} [id]
 * @param {{ qaDir?: string; binaryPath?: string; pinnedVersion?: string; binarySha256?: string; runtimeDir?: string; cacheDir?: string; binBaseDir?: string; env?: NodeJS.ProcessEnv; platform?: string }} [config]
 */
export function resolveInstalledEngineBinary(id = DEFAULT_GRAPH_ENGINE_ID, config = {}) {
  const version = String(config.pinnedVersion || getPinnedEngineManifest(id)?.pinnedVersion || '0.12.1').replace(/^v/i, '');
  const env = config.env || process.env;
  const dirs = resolveIsolatedEngineDirs(id, version, { platform: config.platform, env, runtimeDir: config.runtimeDir, cacheDir: config.cacheDir, binBaseDir: config.binBaseDir });
  const manifestRecord = readEngineManifestRecord(config.qaDir);
  const expectedBinarySha256 = config.binarySha256 || manifestRecord?.binarySha256 || null;
  if (config.binaryPath) {
    const explicitPath = path.resolve(config.binaryPath);
    try {
      if (fs.existsSync(explicitPath) && fs.statSync(explicitPath).isFile()) {
        return { found: true, binaryPath: explicitPath, source: 'config', version, expectedBinarySha256, dirs, manifestRecord };
      }
    } catch { /* ignore */ }
    return { found: false, binaryPath: explicitPath, source: 'missing', version, expectedBinarySha256, dirs, manifestRecord };
  }
  /** @type {Array<{ source: string, path: string }>} */
  const candidates = [
    ...(env.AITEST_CBM_BIN ? [{ source: 'env', path: path.resolve(env.AITEST_CBM_BIN) }] : []),
    ...(manifestRecord?.engine === id && typeof manifestRecord.binaryPath === 'string' && manifestRecord.binaryPath
      ? [{ source: 'engine-manifest', path: manifestRecord.binaryPath }] : []),
    { source: 'isolated-cache', path: dirs.binaryPath },
  ];
  for (const cand of candidates) {
    try {
      if (fs.existsSync(cand.path) && fs.statSync(cand.path).isFile()) {
        return { found: true, binaryPath: cand.path, source: cand.source, version, expectedBinarySha256, dirs, manifestRecord };
      }
    } catch { /* ignore */ }
  }
  return { found: false, binaryPath: candidates[0]?.path || dirs.binaryPath, source: 'missing', version, expectedBinarySha256, dirs, manifestRecord };
}

/**
 * Probes sidecar binary presence, checksum, runtime dir safety, and executable health,
 * emitting actionable Windows Defender quarantine and NTFS ACL recovery steps.
 * @param {string} [id]
 * @param {{ qaDir?: string; binaryPath?: string; pinnedVersion?: string; binarySha256?: string; strictChecksum?: boolean; runtimeDir?: string; cacheDir?: string; binBaseDir?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; platform?: string; runProcessImpl?: typeof runProcess }} [config]
 */
export async function probeEngineHealth(id = DEFAULT_GRAPH_ENGINE_ID, config = {}) {
  const execProc = config.runProcessImpl || runProcess;
  const resolved = resolveInstalledEngineBinary(id, config);
  const platform = config.platform || process.platform;
  const rtSafety = validateRuntimeDirSafety(resolved.dirs.runtimeDir, { platform });
  const cacheSafety = validateRuntimeDirSafety(resolved.dirs.cacheDir, { platform });
  const fail = (/** @type {string} */ blockerKind, /** @type {string} */ reason, /** @type {string[]} */ recoverySteps, /** @type {string | null} */ binarySha256 = null) => ({
    ok: false, healthy: false, id, binaryPath: resolved.binaryPath, dirs: resolved.dirs,
    blockerKind, reason, installedVersion: null, binarySha256, recoverySteps,
  });

  if (!rtSafety.safe || !cacheSafety.safe) {
    return fail(
      'ACL_OR_RUNTIME_UNSAFE',
      [...rtSafety.issues, ...cacheSafety.issues].join(' '),
      platform === 'win32'
        ? [
            `Set AITEST_CBM_RUNTIME_DIR="${resolved.dirs.fallbackRuntimeDir}" (short, owner-only, non-reparse path < 185 chars).`,
            'Fix inherited NTFS ACEs via: icacls <dir> /inheritance:r /grant:r "%USERNAME%":(OI)(CI)F',
          ]
        : ['Set AITEST_CBM_RUNTIME_DIR and AITEST_CBM_CACHE_DIR to short owner-only native filesystem paths.']
    );
  }

  if (!resolved.found) {
    const av = platform === 'win32' && Boolean(resolved.manifestRecord?.engine === id && resolved.manifestRecord?.binaryPath);
    return fail(
      av ? 'AV_QUARANTINE_SUSPECTED' : 'BINARY_NOT_INSTALLED',
      av
        ? `Previously installed binary missing at ${resolved.manifestRecord?.binaryPath} (possible Windows Defender/EDR quarantine).`
        : `Graph engine binary "${id}" is not installed (checked ${resolved.binaryPath}).`,
      av
        ? [
            'Windows Defender / EDR may have quarantined the unsigned native binary (e.g. Wacatac.B!ml false positive).',
            'Verify archive SHA-256 + Sigstore bundle, allowlist %LOCALAPPDATA%\\aitw\\bin\\cbm\\ in EDR, or run: aitw mcp install-engine --from-file <local.zip>',
            'Alternatively continue with built-in zero-dep CodeMap fallback (engine: "auto" or "builtin").',
          ]
        : [
            `Install pinned ${id} v${resolved.version}: aitw mcp install-engine (or --from-file <local.zip> / --mirror-url <url>).`,
            'Or continue with built-in zero-dep CodeMap fallback (engine: "auto" or "builtin").',
          ]
    );
  }

  const actualSha256 = computeFileSha256(resolved.binaryPath);
  if (resolved.expectedBinarySha256 && config.strictChecksum !== false) {
    const ck = verifyBinaryChecksum(resolved.binaryPath, resolved.expectedBinarySha256);
    if (!ck.ok) {
      return fail(
        'CHECKSUM_MISMATCH',
        ck.reason || 'Engine binary SHA-256 verification failed.',
        [`Re-install verified ${id} v${resolved.version} or approve .aitest/engine-manifest.json via human governance.`],
        actualSha256
      );
    }
  }

  try {
    const res = await execProc(resolved.binaryPath, ['--version'], { timeoutMs: config.timeoutMs ?? 5000, windowsHide: true });
    const combined = `${res.stdout}\n${res.stderr}`.trim();
    if (res.code !== 0) {
      const isAv = AV_QUARANTINE_RE.test(combined);
      const isAcl = ACL_FAILURE_RE.test(combined);
      return fail(
        isAv ? 'AV_QUARANTINE_SUSPECTED' : isAcl ? 'ACL_OR_RUNTIME_UNSAFE' : 'EXECUTION_FAILED',
        `Engine "--version" exited ${res.code}: ${combined.slice(0, 240)}`,
        isAv
          ? ['Check Windows Defender/EDR quarantine logs and verify archive checksum before allowlisting.']
          : isAcl
            ? ['Point AITEST_CBM_RUNTIME_DIR and AITEST_CBM_CACHE_DIR to short owner-only directories without inherited cross-account ACEs.']
            : ['Verify binary architecture compatibility and execute permission.'],
        actualSha256
      );
    }
    const verMatch = combined.match(/\bv?(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/);
    return {
      ok: true, healthy: true, id, binaryPath: resolved.binaryPath, dirs: resolved.dirs,
      blockerKind: null, reason: null,
      installedVersion: verMatch ? verMatch[1] : combined.split(/\r?\n/)[0] || 'unknown',
      binarySha256: actualSha256, recoverySteps: [],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const code = err && typeof err === 'object' && 'code' in err ? String(err.code) : '';
    const av = platform === 'win32' && (code === 'EACCES' || code === 'EPERM' || AV_QUARANTINE_RE.test(msg));
    return fail(
      av ? 'AV_QUARANTINE_SUSPECTED' : 'EXECUTION_FAILED',
      `Failed to execute ${resolved.binaryPath}: ${msg}`,
      av
        ? ['Windows Defender / EDR blocked execution. Allowlist %LOCALAPPDATA%\\aitw\\bin\\cbm\\ after verifying SHA-256, or use builtin fallback.']
        : ['Verify binary permissions and architecture compatibility.'],
      actualSha256
    );
  }
}

/** Validates archive member paths against zip-slip / absolute-path traversal. @param {string[]} entries */
export function validateArchiveMemberPaths(entries) {
  for (const rawEntry of entries) {
    const entry = String(rawEntry || '').replace(/\\/g, '/').trim();
    if (!entry) continue;
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) return { ok: false, reason: `Archive member uses absolute path: "${rawEntry}"` };
    if (entry.split('/').includes('..')) return { ok: false, reason: `Archive member escapes destination directory (zip-slip): "${rawEntry}"` };
  }
  return { ok: true, reason: null };
}

/** Inspects ZIP central-directory entry names in pure Node before extraction. @param {string} zipPath @returns {string[]} */
export function listZipEntryNames(zipPath) {
  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22) throw new Error('Archive is too small to be a valid ZIP file.');
  const maxSearch = Math.max(0, buf.length - 65557);
  let eocd = -1;
  for (let i = buf.length - 22; i >= maxSearch; i -= 1) { if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error('ZIP End-Of-Central-Directory signature not found.');
  const count = buf.readUInt16LE(eocd + 10);
  const cdEnd = buf.readUInt32LE(eocd + 16) + buf.readUInt32LE(eocd + 12);
  let cursor = buf.readUInt32LE(eocd + 16);
  /** @type {string[]} */
  const names = [];
  for (let i = 0; i < count && cursor + 46 <= buf.length && cursor < cdEnd; i += 1) {
    if (buf.readUInt32LE(cursor) !== 0x02014b50) break;
    const nLen = buf.readUInt16LE(cursor + 28);
    names.push(buf.subarray(cursor + 46, cursor + 46 + nLen).toString('utf8'));
    cursor += 46 + nLen + buf.readUInt16LE(cursor + 30) + buf.readUInt16LE(cursor + 32);
  }
  return names;
}

/** @param {string} archivePath @param {'zip' | 'tar.gz'} archiveType @param {string} destDir */
async function extractVerifiedArchive(archivePath, archiveType, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  if (archiveType === 'zip') {
    const check = validateArchiveMemberPaths(listZipEntryNames(archivePath));
    if (!check.ok) throw new Error(check.reason || 'Unsafe ZIP archive.');
    if (process.platform === 'win32') {
      const pwsh = (await findExecutable('pwsh')) || (await findExecutable('powershell'));
      if (!pwsh) throw new Error('PowerShell executable not found to extract ZIP archive.');
      const res = await runProcess(pwsh.path, ['-NoProfile', '-NonInteractive', '-Command', '& { param($s,$d) Expand-Archive -LiteralPath $s -DestinationPath $d -Force } @args', archivePath, destDir], { timeoutMs: 60_000, windowsHide: true });
      if (res.code !== 0) throw new Error(`Expand-Archive failed: ${(res.stderr || res.stdout).trim()}`);
      return;
    }
    const res = await runProcess('tar', ['-xf', archivePath, '-C', destDir], { timeoutMs: 60_000 });
    if (res.code !== 0) throw new Error(`tar zip extraction failed: ${(res.stderr || res.stdout).trim()}`);
    return;
  }
  const listRes = await runProcess('tar', ['-tzf', archivePath], { timeoutMs: 30_000, windowsHide: true });
  if (listRes.code !== 0) throw new Error(`Failed to inspect tar.gz archive: ${(listRes.stderr || listRes.stdout).trim()}`);
  const check = validateArchiveMemberPaths(listRes.stdout.split(/\r?\n/).filter(Boolean));
  if (!check.ok) throw new Error(check.reason || 'Unsafe tar.gz archive.');
  const extRes = await runProcess('tar', ['-xzf', archivePath, '-C', destDir], { timeoutMs: 60_000, windowsHide: true });
  if (extRes.code !== 0) throw new Error(`Failed to extract tar.gz archive: ${(extRes.stderr || extRes.stdout).trim()}`);
}

/** @param {string} dir @param {string} targetName @returns {string | null} */
function findFileRecursive(dir, targetName) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = findFileRecursive(full, targetName);
      if (hit) return hit;
    } else if (e.isFile() && e.name.toLowerCase() === targetName.toLowerCase()) return full;
  }
  return null;
}

/** Retains `currentVersion` and `N-1` for rollback, pruning older versions. @param {string} binBaseDir @param {string} currentVersion */
function retainCurrentAndPreviousVersions(binBaseDir, currentVersion) {
  if (!fs.existsSync(binBaseDir)) return [];
  const older = fs
    .readdirSync(binBaseDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name !== currentVersion && !e.name.startsWith('.staging-'))
    .map((e) => ({ name: e.name, full: path.join(binBaseDir, e.name), mtimeMs: fs.statSync(path.join(binBaseDir, e.name)).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  /** @type {string[]} */
  const pruned = [];
  for (const stale of older.slice(1)) {
    fs.rmSync(stale.full, { recursive: true, force: true });
    pruned.push(stale.name);
  }
  return pruned;
}

/**
 * Installs a pinned graph engine from `--from-file`, `--mirror-url`, or official GitHub release
 * with pre-extraction SHA-256 verification, atomic N-1 placement, and `.aitest/engine-manifest.json`.
 * @param {{ id?: string; version?: string; fromFile?: string; mirrorUrl?: string; qaDir?: string; expectedSha256?: string; allowUnverifiedLocalBinary?: boolean; platform?: string; arch?: string; env?: NodeJS.ProcessEnv; binBaseDir?: string; runtimeDir?: string; cacheDir?: string; fetchImpl?: typeof fetch; extractImpl?: (archivePath: string, archiveType: 'zip' | 'tar.gz', destDir: string) => Promise<void> }} [opts]
 */
export async function installGraphEngine(opts = {}) {
  const id = opts.id || DEFAULT_GRAPH_ENGINE_ID;
  const platform = opts.platform || process.platform;
  const arch = opts.arch || process.arch;
  const asset = resolvePlatformAsset(id, platform, arch);
  if (!asset) throw new Error(`Unsupported engine/platform combination: ${id} on ${platform}-${arch}.`);
  const version = String(opts.version || asset.version).replace(/^v/i, '');
  const dirs = resolveIsolatedEngineDirs(id, version, {
    platform, arch, env: opts.env, binBaseDir: opts.binBaseDir, runtimeDir: opts.runtimeDir, cacheDir: opts.cacheDir,
  });
  const acceptedHashes = opts.expectedSha256 ? [opts.expectedSha256] : [asset.sha256, ...asset.alternateAssets.map((a) => a.sha256)];
  const stageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aitw-eng-stage-'));

  try {
    let sourcePath = '';
    let isArchive = true;
    /** @type {'zip' | 'tar.gz'} */
    let archiveType = asset.archiveType;
    let sourceMode = 'github-release';

    if (opts.fromFile) {
      sourceMode = 'from-file';
      sourcePath = path.resolve(opts.fromFile);
      if (!fs.existsSync(sourcePath)) throw new Error(`Local engine file not found: ${sourcePath}`);
      if (/\.zip$/i.test(sourcePath)) archiveType = 'zip';
      else if (/\.(?:tar\.gz|tgz)$/i.test(sourcePath)) archiveType = 'tar.gz';
      else isArchive = false;
    } else {
      const url = opts.mirrorUrl ? `${opts.mirrorUrl.replace(/\/+$/, '')}/${asset.asset}` : asset.downloadUrl;
      sourceMode = opts.mirrorUrl ? 'mirror' : 'github-release';
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
        throw new Error(`Refusing non-HTTPS engine download URL: ${url}`);
      }
      const resp = await (opts.fetchImpl || globalThis.fetch)(url, { redirect: 'follow' });
      if (!resp.ok) throw new Error(`Engine download failed (${resp.status} ${resp.statusText}) from ${url}`);
      sourcePath = path.join(stageRoot, asset.asset);
      fs.writeFileSync(sourcePath, Buffer.from(await resp.arrayBuffer()));
    }

    /** @type {string | null} */
    let archiveSha256 = null;
    let stagedBinaryPath = '';
    if (isArchive) {
      const ck = verifyBinaryChecksum(sourcePath, acceptedHashes);
      if (!ck.ok) throw new Error(`[Checksum Verification Failed] ${ck.reason}`);
      archiveSha256 = ck.actualSha256;
      const extractDir = path.join(stageRoot, 'extracted');
      await (opts.extractImpl || extractVerifiedArchive)(sourcePath, archiveType, extractDir);
      const found = findFileRecursive(extractDir, asset.binaryName);
      if (!found) throw new Error(`Expected binary "${asset.binaryName}" not found inside verified archive.`);
      stagedBinaryPath = found;
    } else {
      if (opts.expectedSha256) {
        const ck = verifyBinaryChecksum(sourcePath, opts.expectedSha256);
        if (!ck.ok) throw new Error(`[Checksum Verification Failed] ${ck.reason}`);
      } else if (!opts.allowUnverifiedLocalBinary) {
        throw new Error('Raw binary --from-file requires --expected-sha256 (or pass a verified release .zip/.tar.gz archive).');
      }
      stagedBinaryPath = sourcePath;
    }

    fs.mkdirSync(dirs.binBaseDir, { recursive: true });
    const tempDir = path.join(dirs.binBaseDir, `.staging-${version}-${process.pid}-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const tempBin = path.join(tempDir, asset.binaryName);
    fs.copyFileSync(stagedBinaryPath, tempBin);
    if (platform !== 'win32') fs.chmodSync(tempBin, 0o755);

    const backupDir = `${dirs.binDir}.bak-${Date.now()}`;
    const hadExisting = fs.existsSync(dirs.binDir);
    if (hadExisting) fs.renameSync(dirs.binDir, backupDir);
    try {
      fs.renameSync(tempDir, dirs.binDir);
      if (hadExisting) fs.rmSync(backupDir, { recursive: true, force: true });
    } catch (swapErr) {
      if (hadExisting && fs.existsSync(backupDir) && !fs.existsSync(dirs.binDir)) fs.renameSync(backupDir, dirs.binDir);
      throw swapErr;
    }

    const prunedVersions = retainCurrentAndPreviousVersions(dirs.binBaseDir, version);
    const manifestRecord = {
      schemaVersion: 1, engine: id, pinnedVersion: asset.version, installedVersion: version, sourceMode,
      archiveSha256, binarySha256: computeFileSha256(dirs.binaryPath), binaryPath: dirs.binaryPath,
      platform: asset.platformKey, installedAt: new Date().toISOString(),
    };
    /** @type {string | null} */
    let manifestPath = null;
    if (opts.qaDir) {
      fs.mkdirSync(path.join(opts.qaDir, '.aitest'), { recursive: true });
      manifestPath = path.join(opts.qaDir, '.aitest', MANIFEST_FILENAME);
      fs.writeFileSync(manifestPath, JSON.stringify(manifestRecord, null, 2) + '\n', 'utf8');
    }
    return { ok: true, ...manifestRecord, manifestPath, prunedVersions, dirs };
  } finally {
    fs.rmSync(stageRoot, { recursive: true, force: true });
  }
}
