// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { PROTECTED_AITEST_LOCK_FILES } from '../../core/config-schema.mjs';
import { DEFAULT_CONFIG_PROTECTED_GLOBS, loadAndValidateAitestConfigFile } from '../../core/config.mjs';
import { compileGlob } from '../../core/glob.mjs';
import { WORKBENCH_VERSION } from '../../core/version.mjs';
import { sha256Hex } from './workspace-hash.mjs';
import { loadActiveQuarantine } from './policy-quarantine.mjs';
import { BOT_APPROVER_RE, isBotApprover, isCoveredByWaiver, loadAndValidateWaivers } from './policy-waivers.mjs';
import { verifyPayloadT1 } from './trust-hmac.mjs';

export { BOT_APPROVER_RE, PROTECTED_AITEST_LOCK_FILES, isBotApprover, isCoveredByWaiver, loadActiveQuarantine, loadAndValidateWaivers };

export const DEFAULT_PROTECTED_GLOBS = DEFAULT_CONFIG_PROTECTED_GLOBS;

// Static referee-kernel list (adaptation layer files like perf-budget.json, auth.setup.ts, and tests/fixtures/custom/** are open)
export const PROTECTED_GOVERNANCE_REL_FILES = Object.freeze([
  'playwright.config.ts',
  'playwright.config.js',
  'eslint.config.mjs',
  'eslint.config.js',
  'aitest.config.json',
  'waivers.json',
  'tsconfig.json',
  'impact-map.json',
  'package.json',
  '.gitignore',
  'support/target-guard.mjs',
  'support/gate-kernel.mjs',
  'support/schema-validator.mjs',
  'support/gate/trust-context.mjs',
  'support/gate/trust-hmac.mjs',
  'support/gate/git-utils.mjs',
  'support/gate/policy.mjs',
  'support/gate/ast-analyzer.mjs',
  'support/gate/ledger-verify.mjs',
  'support/gate/engine.mjs',
  'scripts/audit-results.mjs',
  'tests/fixtures/base.ts',
]);

/**
 * Converts a simple glob (`**`, `*`) to a case-insensitive RegExp anchored on POSIX relative paths.
 * @param {string} glob
 */
export function compilePolicyGlob(glob) {
  return compileGlob(glob);
}

/**
 * Returns whether a diff file path targets a protected governance file (`G-09`, `I-01`).
 * @param {string} filePath
 * @param {string[]} [extraGlobs]
 */
export function isProtectedDiffPath(filePath, extraGlobs = []) {
  const norm = String(filePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!norm) return false;

  if (/(^|\/)\.aitest\/(governance\.lock|quarantine\.json|governance-audit\.jsonl|template-manifest\.json|baseline-ref|mcp\.lock|engine-manifest\.json)$/i.test(norm)) {
    return true;
  }
  if (/(^|\/)\.env(?:\.[^/]+)?$/i.test(norm) && !/\.env\.example$/i.test(norm) && !/\.env\.mcp\.example$/i.test(norm)) {
    return true;
  }

  const qaIdx = norm.indexOf('/qa/');
  const candidates = [norm];
  if (norm.startsWith('qa/')) candidates.push(norm.slice(3));
  if (qaIdx >= 0) candidates.push(norm.slice(qaIdx + 4));

  const allGlobs = [...DEFAULT_PROTECTED_GLOBS, ...(Array.isArray(extraGlobs) ? extraGlobs : [])];
  const regexes = allGlobs.map(compilePolicyGlob);

  for (const cand of candidates) {
    if (regexes.some((re) => re.test(cand))) {
      return true;
    }
  }
  return false;
}

/** @param {string} qaDir */
export function loadAitestConfig(qaDir) {
  return loadAndValidateAitestConfigFile(qaDir).config;
}

/** @param {string[]} [assertFunctionNames] @returns {string[]} */
export function validateAssertFunctionNames(assertFunctionNames = []) {
  const errors = [];
  for (const pat of assertFunctionNames) {
    const trimmed = String(pat || '').trim();
    if (!trimmed || trimmed === '*' || /^\*+$/.test(trimmed) || trimmed.replace(/\*/g, '').length < 3) {
      errors.push(
        `[AITEST-G113] Overly broad wildcard "${pat}" in assertFunctionNames is forbidden (minimum 3 literal identifier characters required).`
      );
    }
  }
  return errors;
}

/** @param {string} qaDir @param {readonly string[]} globs @returns {string[]} */
function collectFilesMatchingGlobs(qaDir, globs) {
  /** @type {Set<string>} */
  const matched = new Set();
  const compiled = globs.map(compilePolicyGlob);
  const skipDirs = new Set(['node_modules', '.git', 'reports', 'playwright-report', 'test-results', 'knowledge', '.aitest']);

  /** @param {string} dir */
  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && skipDirs.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      const rel = path.relative(qaDir, full).replace(/\\/g, '/');
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && compiled.some((re) => re.test(rel))) {
        matched.add(rel);
      }
    }
  };

  walk(qaDir);
  return [...matched].sort();
}

/**
 * Collects all protected target files inside `qaDir` matching `globs`, plus explicitly including
 * protected `.aitest/` supply-chain lockfiles (`.aitest/mcp.lock`, `.aitest/engine-manifest.json`)
 * when present on disk even though generic `.aitest/` runtime directories are skipped during walk.
 * @param {string} qaDir
 * @param {readonly string[]} [globs]
 * @returns {string[]}
 */
export function collectProtectedTargetFiles(qaDir, globs = DEFAULT_PROTECTED_GLOBS) {
  const matched = new Set(collectFilesMatchingGlobs(qaDir, globs));
  for (const rel of PROTECTED_AITEST_LOCK_FILES) {
    const full = path.join(qaDir, ...rel.split('/'));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      matched.add(rel);
    }
  }
  return [...matched].sort();
}

/**
 * Computes normalized CRLF->LF SHA-256 hashes of all protected governance files inside `qaDir`.
 * @param {string} qaDir
 */
export function computeProtectedFileHashes(qaDir) {
  const cfg = loadAitestConfig(qaDir);
  const globs = cfg.governance?.protected || [...DEFAULT_PROTECTED_GLOBS];
  const matchedFiles = collectProtectedTargetFiles(qaDir, globs);

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of matchedFiles) {
    const full = path.join(qaDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      const normalized = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
      files[rel] = `sha256:${sha256Hex(normalized)}`;
    }
  }
  return files;
}

/**
 * Determines whether `qaDir` is an initialized QA workspace requiring a governance lock (`T-02`).
 * @param {string} qaDir
 */
export function isInitializedQaWorkspace(qaDir) {
  if (!qaDir || !fs.existsSync(qaDir)) return false;
  return (
    fs.existsSync(path.join(qaDir, 'aitest.config.json')) ||
    fs.existsSync(path.join(qaDir, 'playwright.config.ts')) ||
    fs.existsSync(path.join(qaDir, 'playwright.config.js')) ||
    fs.existsSync(path.join(qaDir, '.aitest', 'governance-audit.jsonl'))
  );
}

/**
 * Computes a deterministic content-only SHA-256 digest of `.aitest/template-manifest.json`'s `files` map
 * using code-unit key sorting (excludes volatile metadata such as `updatedAt`).
 * @param {Record<string, any> | null | undefined} manifestObj
 * @returns {string | null}
 */
export function computeTemplateManifestDigest(manifestObj) {
  if (!manifestObj || typeof manifestObj !== 'object' || !manifestObj.files || typeof manifestObj.files !== 'object') {
    return null;
  }
  const sortedEntries = Object.entries(/** @type {Record<string, string>} */ (manifestObj.files)).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0
  );
  return `sha256:${sha256Hex(JSON.stringify(Object.fromEntries(sortedEntries)))}`;
}

/**
 * Verifies that an `aitest-init` lock has NOT drifted from the recorded factory template manifest.
 * @param {string} qaDir
 * @param {Record<string, any>} lockObj
 * @param {Record<string, string>} currentHashes
 * @returns {{ ok: boolean, blocked: boolean, errors: string[] }}
 */
function verifyInitLockAgainstFactoryManifest(qaDir, lockObj, currentHashes) {
  /** @type {string[]} */
  const errors = [];
  const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    errors.push(
      '[Governance Tamper Blocked] Governance lock has source="aitest-init" but .aitest/template-manifest.json is missing; run "governance approve" after human review.'
    );
    return { ok: false, blocked: true, errors };
  }

  let manifestRaw = '';
  let manifestObj;
  try {
    manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    manifestObj = JSON.parse(manifestRaw);
  } catch (err) {
    errors.push(
      `[Governance Tamper Blocked] Corrupted .aitest/template-manifest.json: ${err instanceof Error ? err.message : String(err)}`
    );
    return { ok: false, blocked: true, errors };
  }

  if (!lockObj.templateManifestDigest || typeof lockObj.templateManifestDigest !== 'string') {
    errors.push(
      '[Governance Tamper Blocked] Governance lock has source="aitest-init" without mandatory templateManifestDigest binding.'
    );
  } else {
    const actualCanonicalDigest = computeTemplateManifestDigest(manifestObj);
    const actualRawDigest = `sha256:${sha256Hex(manifestRaw.replace(/\r\n/g, '\n'))}`;
    if (
      lockObj.templateManifestDigest !== actualCanonicalDigest &&
      lockObj.templateManifestDigest !== actualRawDigest
    ) {
      errors.push(
        `[Governance Tamper Blocked] .aitest/template-manifest.json digest mismatch (${String(actualCanonicalDigest || actualRawDigest).slice(0, 19)} != ${String(lockObj.templateManifestDigest).slice(0, 19)}) under aitest-init lock.`
      );
    }
  }

  const factoryFiles = manifestObj?.files && typeof manifestObj.files === 'object' ? manifestObj.files : {};
  for (const [rel, curHash] of Object.entries(currentHashes)) {
    const expectedFactoryHash = factoryFiles[rel];
    if (!expectedFactoryHash) {
      errors.push(
        `[Governance Tamper Blocked] Unapproved protected file "${rel}" present under source="aitest-init" lock (not in factory template manifest).`
      );
    } else if (curHash !== expectedFactoryHash) {
      errors.push(
        `[Governance Tamper Blocked] Protected file "${rel}" differs from factory template manifest under source="aitest-init" lock (${curHash.slice(0, 19)} != ${String(expectedFactoryHash).slice(0, 19)}).`
      );
    }
  }

  return { ok: errors.length === 0, blocked: errors.length > 0, errors };
}

/**
 * Fail-closed Layer 0 Governance Lock verification (`T-01`, `T-02`).
 * @param {string} qaDir
 * @param {{ requireT1Mac?: boolean, allowUninitialized?: boolean, trustContext?: import('./trust-context.mjs').TrustContext }} [options]
 * @returns {{ ok: boolean, status: 'pass' | 'fail' | 'blocked', enforced: boolean, trustTier: 'T0' | 'T1', lockPath: string, lockDigest?: string, errors: string[], warnings: string[], approvedBy?: string }}
 */
export function verifyGovernanceLockInQaDir(qaDir, options = {}) {
  const aitestDir = path.join(qaDir, '.aitest');
  const lockPath = path.join(aitestDir, 'governance.lock');
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const warnings = [];

  if (!fs.existsSync(lockPath)) {
    if (isInitializedQaWorkspace(qaDir)) {
      errors.push(
        `[Governance Tamper Blocked] Missing .aitest/governance.lock in initialized QA workspace (${qaDir}). Fail-closed: restore from Git or have a human run "npx ai-test-workbench@${WORKBENCH_VERSION} governance approve".`
      );
      return { ok: false, status: 'blocked', enforced: true, trustTier: 'T0', lockPath, errors, warnings };
    }
    if (options.allowUninitialized === true) {
      return {
        ok: true,
        status: 'pass',
        enforced: false,
        trustTier: 'T0',
        lockPath,
        errors,
        warnings: ['Uninitialized QA workspace allowed by explicit allowUninitialized flag (T0 advisory).'],
      };
    }
    errors.push(
      `[Governance Blocked] Uninitialized QA workspace (${qaDir}) is missing playwright.config.* / aitest.config.json and .aitest/governance.lock. Fail-closed: run "npx ai-test-workbench@${WORKBENCH_VERSION} init" first.`
    );
    return { ok: false, status: 'blocked', enforced: true, trustTier: 'T0', lockPath, errors, warnings };
  }

  let lockObj;
  try {
    lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      status: 'blocked',
      enforced: true,
      trustTier: 'T0',
      lockPath,
      errors: [`[Governance Tamper Blocked] Corrupted JSON in .aitest/governance.lock: ${err instanceof Error ? err.message : String(err)}`],
      warnings,
    };
  }

  if (!lockObj || typeof lockObj.files !== 'object' || !lockObj.approvedBy) {
    errors.push('[Governance Tamper Blocked] Invalid .aitest/governance.lock schema (missing files or approvedBy).');
    return { ok: false, status: 'blocked', enforced: true, trustTier: 'T0', lockPath, errors, warnings };
  }

  if (lockObj.source !== 'aitest-init' && isBotApprover(lockObj.approvedBy)) {
    errors.push(`[Governance Tamper Blocked] Lock approver "${lockObj.approvedBy}" matches reserved AI/bot identity.`);
  }

  const macCheck = verifyPayloadT1('governance.lock', lockObj, lockObj.mac, {
    qaDir,
    repoDir: path.dirname(qaDir),
    requireMac: Boolean(options.requireT1Mac),
    macs: lockObj.macs || null,
    trustContext: options.trustContext,
  });
  let forceBlocked = false;
  if (!macCheck.ok) {
    forceBlocked = true;
    errors.push(`[Governance Tamper Blocked] ${macCheck.reason}`);
  } else if (!macCheck.verified) {
    warnings.push(`[Governance T0 Advisory] ${macCheck.reason}`);
  }

  const currentHashes = computeProtectedFileHashes(qaDir);
  const lockedFiles = lockObj.files || {};

  if (lockObj.source === 'aitest-init') {
    const factoryCheck = verifyInitLockAgainstFactoryManifest(qaDir, lockObj, currentHashes);
    if (!factoryCheck.ok) {
      forceBlocked = true;
      errors.push(...factoryCheck.errors);
    }
  }

  for (const [rel, expectedHash] of Object.entries(lockedFiles)) {
    const actualHash = currentHashes[rel];
    if (!actualHash) {
      forceBlocked = true;
      errors.push(
        `[Governance Tamper Blocked] Protected governance file "${rel}" was deleted. Human approval required via "npx ai-test-workbench@${WORKBENCH_VERSION} governance approve".`
      );
    } else if (actualHash !== expectedHash) {
      forceBlocked = true;
      errors.push(
        `[Governance Tamper Blocked] Protected governance file "${rel}" was modified (${actualHash.slice(0, 19)} != ${String(expectedHash).slice(0, 19)}). Agents may NOT edit governance configs/waivers; a human must run "npx ai-test-workbench@${WORKBENCH_VERSION} governance approve --target <repo> --by <name> --reason <why>".`
      );
    }
  }

  for (const rel of Object.keys(currentHashes)) {
    if (!(rel in lockedFiles)) {
      forceBlocked = true;
      errors.push(
        `[Governance Tamper Blocked] Unapproved protected file "${rel}" added without updating .aitest/governance.lock. Human approval required via "npx ai-test-workbench@${WORKBENCH_VERSION} governance approve".`
      );
    }
  }

  const status = errors.length === 0 ? 'pass' : forceBlocked ? 'blocked' : 'fail';
  return {
    ok: errors.length === 0,
    status,
    enforced: true,
    trustTier: errors.length === 0 && macCheck.verified ? 'T1' : 'T0',
    lockPath,
    lockDigest: `sha256:${sha256Hex(fs.readFileSync(lockPath, 'utf8').replace(/\r\n/g, '\n'))}`,
    errors,
    warnings,
    approvedBy: lockObj.approvedBy,
  };
}
