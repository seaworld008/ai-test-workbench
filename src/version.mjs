// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

function loadRootPackageVersion() {
  try {
    const pkgPath = path.join(REPO_ROOT, 'package.json');
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return String(parsed.version || '5.0.0');
  } catch {
    return '5.0.0';
  }
}

export const WORKBENCH_VERSION = loadRootPackageVersion();

export const SCHEMA_VERSIONS = Object.freeze({
  resultEnvelope: 1,
  codeMap: 4,
  ledgerManifest: 1,
  governanceLock: 1,
  healSession: 1,
  verdict: 2,
  mcpLock: 1,
  quarantine: 1,
  traceMatrix: 1,
});
