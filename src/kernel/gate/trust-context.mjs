// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Resolves the default user-level T1 key path outside any project workspace.
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function resolveDefaultHmacKeyFilePath(env = process.env) {
  if (env.AITEST_HMAC_KEY_FILE) {
    return path.resolve(env.AITEST_HMAC_KEY_FILE);
  }
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ai-test-workbench', 't1-hmac.key');
  }
  const base = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ai-test-workbench', 't1-hmac.key');
}

/**
 * Computes a non-secret 16-hex identifier for a T1 HMAC key (`keyId`).
 * @param {string} key
 * @returns {string}
 */
export function computeKeyId(key) {
  return crypto.createHash('sha256').update(`aitest-key-id:${String(key)}`, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Returns the sticky T1 marker file path corresponding to `keyPath`.
 * Isolates custom `AITEST_HMAC_KEY_FILE` sandboxes from host OS config.
 * @param {string} keyPath
 * @param {Record<string, string | undefined>} [env]
 * @returns {string}
 */
export function getStickyMarkerPath(keyPath, env = process.env) {
  if (env.AITEST_HMAC_KEY_FILE) {
    return `${path.resolve(keyPath)}.sticky`;
  }
  return path.join(path.dirname(path.resolve(keyPath)), 't1-sticky.json');
}

/**
 * @param {string} candidatePath
 * @param {string} dirPath
 * @returns {boolean}
 */
export function isPathInsideDir(candidatePath, dirPath) {
  if (!candidatePath || !dirPath) return false;
  const normCand = path.resolve(candidatePath);
  const normDir = path.resolve(dirPath);
  const c = process.platform === 'win32' ? normCand.toLowerCase() : normCand;
  const d = process.platform === 'win32' ? normDir.toLowerCase() : normDir;
  if (c === d) return true;
  const withSep = d.endsWith(path.sep) ? d : `${d}${path.sep}`;
  return c.startsWith(withSep);
}

/**
 * Records that this host/key-store has created or used a T1 key so subsequent
 * verification treats stripped `mac`/`macs` fields as tampering (`fail-closed`).
 * @param {string} keyPath
 * @param {string} keyId
 * @param {Record<string, string | undefined>} [env]
 */
export function recordHostT1Sticky(keyPath, keyId, env = process.env) {
  if (!keyPath) return;
  try {
    const markerPath = getStickyMarkerPath(keyPath, env);
    fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(markerPath)) {
      fs.writeFileSync(
        markerPath,
        JSON.stringify({ sticky: true, keyId, recordedAt: new Date().toISOString() }) + '\n',
        { encoding: 'utf8', mode: 0o600 }
      );
    }
  } catch {
    // non-fatal if marker directory is read-only
  }
}

/**
 * Returns true if this host or active key-store has previously used T1 HMAC signing.
 * @param {string | null | undefined} keyPath
 * @param {Record<string, string | undefined>} [env]
 * @returns {boolean}
 */
export function isHostT1Sticky(keyPath, env = process.env) {
  if (env.AITEST_HMAC_KEY && env.AITEST_HMAC_KEY.trim().length >= 16) {
    return true;
  }
  if (!keyPath) return false;
  if (fs.existsSync(keyPath)) return true;
  const markerPath = getStickyMarkerPath(keyPath, env);
  return fs.existsSync(markerPath);
}

/**
 * @typedef {{
 *   tierCeiling: 'T0' | 'T1';
 *   key: string | null;
 *   keyId: string | null;
 *   source: string;
 *   keyPath: string | null;
 *   hostT1Sticky: boolean;
 *   error: string | null;
 * }} TrustContext
 */

/**
 * Opens an immutable `TrustContext` ONCE at command/pipeline entry and threads it
 * explicitly through all governance, ledger, heal, and attestation verifiers.
 * @param {{
 *   qaDir?: string;
 *   repoDir?: string;
 *   env?: Record<string, string | undefined>;
 *   createKeyIfMissing?: boolean;
 * }} [options]
 * @returns {Readonly<TrustContext>}
 */
export function openTrustContext(options = {}) {
  const { qaDir, repoDir, env = process.env, createKeyIfMissing = false } = options;

  if (env.AITEST_HMAC_KEY && env.AITEST_HMAC_KEY.trim().length >= 16) {
    const key = env.AITEST_HMAC_KEY.trim();
    return Object.freeze({
      tierCeiling: 'T1',
      key,
      keyId: computeKeyId(key),
      source: 'env:AITEST_HMAC_KEY',
      keyPath: null,
      hostT1Sticky: true,
      error: null,
    });
  }

  const keyPath = resolveDefaultHmacKeyFilePath(env);
  if ((qaDir && isPathInsideDir(keyPath, qaDir)) || (repoDir && isPathInsideDir(keyPath, repoDir))) {
    return Object.freeze({
      tierCeiling: 'T0',
      key: null,
      keyId: null,
      source: 'rejected-in-workspace',
      keyPath,
      hostT1Sticky: false,
      error: `Refusing to use T1 HMAC key inside workspace directory: ${keyPath}`,
    });
  }

  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (existing.length >= 16) {
        const keyId = computeKeyId(existing);
        recordHostT1Sticky(keyPath, keyId, env);
        return Object.freeze({
          tierCeiling: 'T1',
          key: existing,
          keyId,
          source: 'user-config-keyfile',
          keyPath,
          hostT1Sticky: true,
          error: null,
        });
      }
    }

    if (createKeyIfMissing) {
      fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
      const generated = crypto.randomBytes(32).toString('hex');
      fs.writeFileSync(keyPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
      const keyId = computeKeyId(generated);
      recordHostT1Sticky(keyPath, keyId, env);
      return Object.freeze({
        tierCeiling: 'T1',
        key: generated,
        keyId,
        source: 'user-config-keyfile',
        keyPath,
        hostT1Sticky: true,
        error: null,
      });
    }

    const sticky = isHostT1Sticky(keyPath, env);
    return Object.freeze({
      tierCeiling: 'T0',
      key: null,
      keyId: null,
      source: 'missing',
      keyPath,
      hostT1Sticky: sticky,
      error: sticky ? `T1 HMAC key missing on T1-sticky host (${keyPath}).` : null,
    });
  } catch (err) {
    return Object.freeze({
      tierCeiling: 'T0',
      key: null,
      keyId: null,
      source: 'io-error',
      keyPath,
      hostT1Sticky: isHostT1Sticky(keyPath, env),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
