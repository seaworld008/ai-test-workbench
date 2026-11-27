// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..');

/**
 * Reads the authoritative package version from root `package.json`.
 * @returns {string}
 */
function loadRootPackageVersion() {
  try {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const parsed = /** @type {{ version?: unknown }} */ (JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
    return typeof parsed.version === 'string' && parsed.version.trim() ? parsed.version.trim() : '6.7.0';
  } catch {
    return '6.7.0';
  }
}

export const WORKBENCH_VERSION = loadRootPackageVersion();

export const SCHEMA_VERSIONS = Object.freeze({
  resultEnvelope: 2,
  codeMap: 5,
  ledgerManifest: 1,
  governanceLock: 1,
  templateManifest: 1,
  healSession: 1,
  verdict: 2,
  mcpLock: 1,
  quarantine: 1,
  traceMatrix: 1,
});
