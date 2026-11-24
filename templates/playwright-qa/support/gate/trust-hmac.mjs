import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * T1 Out-of-Workspace HMAC Tamper-Evidence Engine (`ADR-0002`).
 *
 * Threat-model honesty:
 * - T0 (Advisory): unsigned local artifacts; no tamper evidence.
 * - T1 (Tamper-Evident Local): HMAC-SHA256 keyed from an out-of-workspace key store
 *   (`AITEST_HMAC_KEY`, `AITEST_HMAC_KEY_FILE`, or OS user config dir with `0o600` permissions).
 *   Detects workspace-confined tampering by agents without host-key access.
 * - T2 (CI-Attested): clean-checkout CI execution + signed in-toto Statement v1.
 */

export const HMAC_PREFIX = 'hmac-sha256:';

/**
 * Resolves the default user-level config directory outside any project workspace.
 */
export function getDefaultHmacKeyFilePath() {
  if (process.env.AITEST_HMAC_KEY_FILE) {
    return path.resolve(process.env.AITEST_HMAC_KEY_FILE);
  }
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'ai-test-workbench', 't1-hmac.key');
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, 'ai-test-workbench', 't1-hmac.key');
}

function isPathInsideDir(candidatePath, dirPath) {
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
 * Deterministically serializes JSON objects with recursively sorted keys.
 * @param {any} value
 * @returns {string}
 */
export function canonicalizeJson(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(',')}]`;
  }
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(value[k])}`).join(',')}}`;
}

/**
 * Loads or creates the T1 HMAC key from outside the workspace.
 * Refuses key files placed inside `qaDir` or `repoDir` to keep key material outside workspace scope.
 * @param {{ createIfMissing?: boolean, qaDir?: string, repoDir?: string }} [options]
 */
export function resolveT1HmacKey(options = {}) {
  const { createIfMissing = false, qaDir, repoDir } = options;

  if (process.env.AITEST_HMAC_KEY && process.env.AITEST_HMAC_KEY.trim().length >= 16) {
    return {
      ok: true,
      key: process.env.AITEST_HMAC_KEY.trim(),
      source: 'env:AITEST_HMAC_KEY',
      keyPath: null,
    };
  }

  const keyPath = getDefaultHmacKeyFilePath();
  if ((qaDir && isPathInsideDir(keyPath, qaDir)) || (repoDir && isPathInsideDir(keyPath, repoDir))) {
    return {
      ok: false,
      key: null,
      source: 'rejected-in-workspace',
      keyPath,
      error: `Refusing to use T1 HMAC key inside workspace directory: ${keyPath}`,
    };
  }

  try {
    if (fs.existsSync(keyPath)) {
      const existing = fs.readFileSync(keyPath, 'utf8').trim();
      if (existing.length >= 16) {
        return { ok: true, key: existing, source: 'user-config-keyfile', keyPath };
      }
    }
    if (!createIfMissing) {
      return { ok: false, key: null, source: 'missing', keyPath };
    }
    fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(keyPath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
    return { ok: true, key: generated, source: 'user-config-keyfile', keyPath };
  } catch (err) {
    return { ok: false, key: null, source: 'io-error', keyPath, error: err?.message || String(err) };
  }
}

/**
 * Computes a domain-separated canonical HMAC-SHA256 digest.
 * @param {string} domain
 * @param {Record<string, any>} payload
 * @param {string} key
 */
export function computeDomainHmac(domain, payload, key) {
  const canonical = canonicalizeJson(payload);
  const hex = crypto
    .createHmac('sha256', String(key))
    .update(`${domain}\n${canonical}`, 'utf8')
    .digest('hex');
  return `${HMAC_PREFIX}${hex}`;
}

/**
 * Strips signature fields (`mac`, `hmac`, `signature`, `trustTier`) before MAC computation.
 * @param {Record<string, any>} obj
 */
export function stripSignatureFields(obj) {
  if (!obj || typeof obj !== 'object') return {};
  const copy = { ...obj };
  delete copy.mac;
  delete copy.hmac;
  delete copy.signature;
  return copy;
}

/**
 * Signs a structured payload for T1 local tamper evidence.
 * @param {string} domain
 * @param {Record<string, any>} payload
 * @param {{ qaDir?: string, repoDir?: string, createIfMissing?: boolean }} [options]
 */
export function signPayloadT1(domain, payload, options = {}) {
  const keyRes = resolveT1HmacKey({
    createIfMissing: options.createIfMissing !== false,
    qaDir: options.qaDir,
    repoDir: options.repoDir,
  });
  if (!keyRes.ok || !keyRes.key) {
    return {
      signed: false,
      mac: null,
      trustTier: 'T0',
      source: keyRes.source,
      error: keyRes.error || null,
    };
  }
  const mac = computeDomainHmac(domain, stripSignatureFields(payload), keyRes.key);
  return {
    signed: true,
    mac,
    trustTier: 'T1',
    source: keyRes.source,
    error: null,
  };
}

/**
 * Verifies a T1 HMAC signature using constant-time comparison.
 * @param {string} domain
 * @param {Record<string, any>} payload
 * @param {string | null | undefined} macValue
 * @param {{ qaDir?: string, repoDir?: string, requireMac?: boolean }} [options]
 */
export function verifyPayloadT1(domain, payload, macValue, options = {}) {
  const { qaDir, repoDir, requireMac = false } = options;

  if (!macValue || typeof macValue !== 'string') {
    if (requireMac) {
      return {
        ok: false,
        verified: false,
        trustTier: 'T0',
        reason: `Missing required T1 HMAC signature for ${domain}.`,
      };
    }
    return {
      ok: true,
      verified: false,
      trustTier: 'T0',
      reason: `Unsigned ${domain} (T0 advisory only).`,
    };
  }

  if (!macValue.startsWith(HMAC_PREFIX)) {
    return {
      ok: false,
      verified: false,
      trustTier: 'T0',
      reason: `Malformed HMAC format for ${domain}.`,
    };
  }

  const keyRes = resolveT1HmacKey({ createIfMissing: false, qaDir, repoDir });
  if (!keyRes.ok || !keyRes.key) {
    // Key not present on this machine (e.g., lock committed from another dev machine or fresh CI checkout):
    // In CI, T2 recomputes from clean checkout; locally without key we cannot verify MAC so downgrade to T0 unless requireMac.
    if (requireMac) {
      return {
        ok: false,
        verified: false,
        trustTier: 'T0',
        reason: keyRes.error || `T1 HMAC key unavailable to verify ${domain}.`,
      };
    }
    return {
      ok: true,
      verified: false,
      trustTier: 'T0',
      reason: `T1 HMAC key not present locally for ${domain}; cannot verify local MAC (T0).`,
    };
  }

  const expected = computeDomainHmac(domain, stripSignatureFields(payload), keyRes.key);
  const actualBuf = Buffer.from(macValue, 'utf8');
  const expectedBuf = Buffer.from(expected, 'utf8');
  const matches = actualBuf.length === expectedBuf.length && crypto.timingSafeEqual(actualBuf, expectedBuf);

  if (!matches) {
    return {
      ok: false,
      verified: false,
      trustTier: 'T0',
      reason: `[Tamper Detected] HMAC-SHA256 mismatch on ${domain}: artifact was modified outside trusted writer.`,
    };
  }

  return {
    ok: true,
    verified: true,
    trustTier: 'T1',
    reason: `Verified T1 HMAC (${keyRes.source}).`,
  };
}
