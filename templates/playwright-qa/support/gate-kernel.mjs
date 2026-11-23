import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Authoritative 4-Layer Anti-Fake-Green Gate Kernel (v5.0.0).
 * Single source of truth shared by `<qaDir>/scripts/audit-results.mjs` and `ai-test-workbench` CLI/MCP.
 * Zero mandatory external dependencies; automatically upgrades to TypeScript Compiler AST when `typescript`
 * is present in `<qaDir>/node_modules` or `templates/playwright-qa/node_modules`.
 */
export const GATE_KERNEL_VERSION = '5.0.0';

export const PROTECTED_GOVERNANCE_REL_FILES = Object.freeze([
  'playwright.config.ts',
  'playwright.config.js',
  'eslint.config.mjs',
  'eslint.config.js',
  'aitest.config.json',
  'waivers.json',
  'tsconfig.json',
  'perf-budget.json',
  'support/target-guard.mjs',
  'support/gate-kernel.mjs',
  'support/schema-validator.mjs',
  'scripts/audit-results.mjs',
  'tests/fixtures/base.ts',
]);

const PROTECTED_DIFF_PATH_RE =
  /(^|\/)(playwright\.config\.[jt]s|eslint\.config\.[mc]?[jt]s|aitest\.config\.json|waivers\.json|tsconfig\.json|perf-budget\.json|governance\.lock|support\/[^/]+|scripts\/audit-results\.mjs|tests\/fixtures\/[^/]+)$/i;

const BOT_APPROVER_RE = /^(ai|agent|bot|healer|codex|claude|cursor|copilot|gemini|antigravity|auto|self)$/i;

const S5_EXACT_MATCHERS = new Set([
  'toEqual',
  'toStrictEqual',
  'toHaveText',
  'toHaveValue',
  'toHaveValues',
  'toHaveURL',
  'toMatchAriaSnapshot',
  'toHaveScreenshot',
  'toBe',
]);

const S4_STRUCTURAL_MATCHERS = new Set([
  'toHaveCount',
  'toHaveAttribute',
  'toHaveJSProperty',
  'toHaveCSS',
  'toHaveClass',
  'toHaveRole',
  'toHaveAccessibleName',
  'toHaveAccessibleDescription',
  'toHaveId',
  'toHaveTitle',
]);

const S3_PARTIAL_MATCHERS = new Set([
  'toContainText',
  'toContain',
  'toContainEqual',
  'toMatch',
  'toMatchObject',
  'toHaveProperty',
]);

const S2_STATE_MATCHERS = new Set([
  'toBeVisible',
  'toBeHidden',
  'toBeEnabled',
  'toBeDisabled',
  'toBeChecked',
  'toBeEditable',
  'toBeAttached',
  'toBeInViewport',
  'toBeEmpty',
  'toBeFocused',
  'toBeOK',
]);

const S1_WEAK_MATCHERS = new Set([
  'toBeTruthy',
  'toBeFalsy',
  'toBeDefined',
  'toBeNull',
  'toBeUndefined',
  'toBeNaN',
  'toBeGreaterThan',
  'toBeGreaterThanOrEqual',
  'toBeLessThan',
  'toBeLessThanOrEqual',
  'toBeCloseTo',
]);

/**
 * Attempts to resolve `typescript` compiler module from `qaDir` or sibling template `node_modules`.
 * @param {string} [qaDir]
 */
export function resolveTypeScriptCompiler(qaDir) {
  const req = createRequire(import.meta.url);
  const candidates = [];
  if (qaDir) {
    candidates.push(path.join(qaDir, 'node_modules', 'typescript'));
  }
  candidates.push(path.resolve(__dirname, '..', 'node_modules', 'typescript'));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        return req(candidate);
      }
    } catch {
      // continue fallback
    }
  }
  return null;
}

export function sha256Hex(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function computeProtectedFileHashes(qaDir) {
  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of PROTECTED_GOVERNANCE_REL_FILES) {
    const full = path.join(qaDir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      // Normalize CRLF -> LF so governance hashes stay portable across Windows and Linux CI!
      const normalized = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
      files[rel] = `sha256:${sha256Hex(normalized)}`;
    }
  }
  return files;
}

export function verifyGovernanceLockInQaDir(qaDir) {
  const aitestDir = path.join(qaDir, '.aitest');
  const lockPath = path.join(aitestDir, 'governance.lock');
  const errors = [];
  const warnings = [];

  const auditTrailPath = path.join(aitestDir, 'governance-audit.jsonl');
  if (!fs.existsSync(lockPath)) {
    if (fs.existsSync(auditTrailPath)) {
      errors.push(
        `[Governance Tamper Blocked] Missing .aitest/governance.lock in initialized QA workspace (${qaDir}). Restore from Git or ask a human to run "aitest governance approve".`
      );
      return { ok: false, enforced: true, lockPath, errors, warnings };
    }
    return { ok: true, enforced: false, lockPath, errors, warnings };
  }

  let lockObj;
  try {
    lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      enforced: true,
      lockPath,
      errors: [`[Governance Tamper Blocked] Corrupted JSON in .aitest/governance.lock: ${err.message}`],
      warnings,
    };
  }

  if (!lockObj || typeof lockObj.files !== 'object' || !lockObj.approvedBy) {
    errors.push('[Governance Tamper Blocked] Invalid .aitest/governance.lock schema (missing files or approvedBy).');
    return { ok: false, enforced: true, lockPath, errors, warnings };
  }

  const currentHashes = computeProtectedFileHashes(qaDir);
  const lockedFiles = lockObj.files || {};

  for (const [rel, expectedHash] of Object.entries(lockedFiles)) {
    const actualHash = currentHashes[rel];
    if (!actualHash) {
      errors.push(
        `[Governance Tamper Blocked] Protected governance file "${rel}" was deleted. Human approval required via "aitest governance approve".`
      );
    } else if (actualHash !== expectedHash) {
      errors.push(
        `[Governance Tamper Blocked] Protected governance file "${rel}" was modified (${actualHash.slice(0, 19)} != ${String(expectedHash).slice(0, 19)}). Agents may NOT edit governance configs/waivers; a human must run "aitest governance approve --target <repo> --by <name> --reason <why>".`
      );
    }
  }

  for (const rel of Object.keys(currentHashes)) {
    if (!(rel in lockedFiles)) {
      errors.push(
        `[Governance Tamper Blocked] Unapproved protected file "${rel}" added without updating .aitest/governance.lock. Human approval required via "aitest governance approve".`
      );
    }
  }

  return { ok: errors.length === 0, enforced: true, lockPath, errors, warnings, approvedBy: lockObj.approvedBy };
}

export function loadAitestConfig(qaDir) {
  const cfgPath = path.join(qaDir, 'aitest.config.json');
  const defaults = {
    assertFunctionNames: ['expect*', 'assert*', 'verify*'],
    criticalTags: ['@critical', '@smoke'],
    maxFlaky: 0,
    maxWaivers: 5,
    maxWaiverDays: 14,
  };
  if (!fs.existsSync(cfgPath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const rawNames = Array.isArray(parsed.assertFunctionNames)
      ? parsed.assertFunctionNames
      : defaults.assertFunctionNames;
    return {
      ...defaults,
      ...parsed,
      assertFunctionNames: rawNames,
    };
  } catch {
    return defaults;
  }
}

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

/**
 * Validates `waivers.json` with anti-self-approval, issue/trace linkage, and <=14-day TTL enforcement.
 * @param {string} waiversPath
 * @param {number} [nowMs]
 * @param {{ maxWaiverDays?: number, maxWaivers?: number, legacyCompat?: boolean }} [options]
 */
export function loadAndValidateWaivers(waiversPath, nowMs = Date.now(), options = {}) {
  const maxWaiverDays = options.maxWaiverDays ?? 14;
  const maxWaivers = options.maxWaivers ?? 5;
  const legacyCompat = Boolean(options.legacyCompat);
  const errors = [];
  const activeWaivers = [];

  if (!waiversPath || !fs.existsSync(waiversPath)) {
    return { ok: true, errors, activeWaivers };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(waiversPath, 'utf8'));
  } catch (err) {
    return { ok: false, errors: [`Invalid JSON in waivers file (${waiversPath}): ${err.message}`], activeWaivers };
  }

  const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed.waivers) ? parsed.waivers : [];
  if (list.length > maxWaivers) {
    errors.push(`Waiver count (${list.length}) exceeds maximum allowed active waivers (${maxWaivers}).`);
  }

  list.forEach((w, idx) => {
    const label = `waiver[${idx}]`;
    if (!w || typeof w !== 'object') {
      errors.push(`${label}: entry must be an object.`);
      return;
    }
    if (!w.titlePattern && !w.filePattern) {
      errors.push(`${label}: requires "titlePattern" or "filePattern".`);
    }
    if (!w.owner || typeof w.owner !== 'string' || !w.owner.trim()) {
      errors.push(`${label}: missing mandatory "owner".`);
    } else if (BOT_APPROVER_RE.test(w.owner.trim())) {
      errors.push(`${label}: owner "${w.owner}" cannot be an AI agent/bot identifier.`);
    }
    if (!w.reason || typeof w.reason !== 'string' || !w.reason.trim()) {
      errors.push(`${label}: missing mandatory "reason".`);
    }
    if (!w.expiresAt || typeof w.expiresAt !== 'string') {
      errors.push(`${label}: missing mandatory ISO date "expiresAt".`);
      return;
    }
    const expMs = Date.parse(w.expiresAt);
    if (Number.isNaN(expMs)) {
      errors.push(`${label}: invalid date in "expiresAt": "${w.expiresAt}".`);
      return;
    }
    if (expMs <= nowMs) {
      errors.push(`${label}: waiver for "${w.titlePattern || w.filePattern}" owned by "${w.owner}" EXPIRED at ${w.expiresAt}.`);
      return;
    }

    if (!legacyCompat) {
      if (!w.approvedBy || typeof w.approvedBy !== 'string' || !w.approvedBy.trim()) {
        errors.push(`${label}: missing mandatory human "approvedBy" field (Agents cannot self-approve waivers).`);
      } else if (BOT_APPROVER_RE.test(w.approvedBy.trim())) {
        errors.push(`${label}: "approvedBy" ("${w.approvedBy}") must be a human reviewer, never an AI agent.`);
      }

      const hasLink = (typeof w.issue === 'string' && w.issue.trim()) || (typeof w.traceId === 'string' && w.traceId.trim());
      if (!hasLink) {
        errors.push(`${label}: requires linked "issue" or "traceId" for audit traceability.`);
      }

      const baseMs = w.createdAt ? Date.parse(w.createdAt) : nowMs;
      if (Number.isNaN(baseMs)) {
        errors.push(`${label}: invalid ISO date in "createdAt": "${w.createdAt}".`);
      } else {
        const maxDurationMs = maxWaiverDays * 24 * 60 * 60 * 1000;
        if (expMs - baseMs > maxDurationMs || expMs - nowMs > maxDurationMs) {
          errors.push(
            `${label}: waiver TTL exceeds maximum ${maxWaiverDays}-day governance limit (expiresAt=${w.expiresAt}).`
          );
        }
      }
    }

    activeWaivers.push(w);
  });

  return { ok: errors.length === 0, errors, activeWaivers };
}

export function isCoveredByWaiver(item, activeWaivers, scope = 'test') {
  for (const w of activeWaivers) {
    if (w.scope && w.scope !== scope && w.scope !== 'all') continue;
    const titleOk = w.titlePattern ? String(item.title || '').includes(w.titlePattern) : true;
    const fileOk = w.filePattern ? String(item.file || '').replace(/\\/g, '/').includes(w.filePattern) : true;
    if (titleOk && fileOk) return w;
  }
  return null;
}

function collectSpecsFromSuite(suite, parentTitles = [], fileHint = '') {
  const collected = [];
  const nextTitles = suite.title ? [...parentTitles, suite.title] : parentTitles;
  const currentFile = suite.file || fileHint;

  for (const spec of suite.specs || []) {
    const fullTitle = [...nextTitles, spec.title].filter(Boolean).join(' > ');
    const specTags = Array.isArray(spec.tags) ? spec.tags.map((t) => (t.startsWith('@') ? t : `@${t}`)) : [];
    const inlineTags = fullTitle.match(/@[a-zA-Z0-9_-]+/g) || [];
    const allTags = [...new Set([...specTags, ...inlineTags])];

    for (const testEntry of spec.tests || []) {
      collected.push({
        title: fullTitle,
        specTitle: spec.title || '',
        file: spec.file || currentFile || '',
        line: spec.line || 0,
        projectName: testEntry.projectName || '',
        status: testEntry.status || 'unknown',
        tags: allTags,
        annotations: testEntry.annotations || [],
        results: testEntry.results || [],
      });
    }
  }

  for (const child of suite.suites || []) {
    collected.push(...collectSpecsFromSuite(child, nextTitles, currentFile));
  }
  return collected;
}

export function countMutationSpecsInFiles(testsDir) {
  if (!fs.existsSync(testsDir)) return [];
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && /\.spec\.[jt]s$/.test(entry.name)) {
        const txt = fs.readFileSync(full, 'utf8');
        const lines = txt.split(/\r?\n/);
        lines.forEach((line, idx) => {
          if (/@mutation\b/.test(line) && /\btest(?:\.describe)?\s*\(/.test(line)) {
            found.push({
              file: path.relative(testsDir, full).replace(/\\/g, '/'),
              line: idx + 1,
              label: `${path.relative(testsDir, full).replace(/\\/g, '/')}:${idx + 1} — ${line.trim()}`,
            });
          }
        });
      }
    }
  };
  walk(testsDir);
  return found;
}

function normalizeMutationDedupKey(fileStr, lineNum) {
  const norm = String(fileStr || '')
    .replace(/\\/g, '/')
    .replace(/^tests\//, '');
  return `${norm}:${lineNum || 0}`;
}

/**
 * Layer 1: Audits Playwright JSON results (`reports/results.json`) with deduplicated @mutation counting.
 */
export function auditResultsJson(resultsObj, options = {}) {
  const {
    activeWaivers = [],
    requireE2e = false,
    maxFlaky = 0,
    maxSkipped = Infinity,
    allowMutation = false,
    excludedMutationHints = [],
    quarantinedTests = [],
  } = options;

  const errors = [];
  const warnings = [];
  const allTests = [];
  for (const suite of resultsObj.suites || []) {
    allTests.push(...collectSpecsFromSuite(suite));
  }

  let passed = 0;
  let failed = 0;
  let flaky = 0;
  let skipped = 0;
  let quarantinedCount = 0;
  let e2eExecuted = 0;

  const failedList = [];
  const flakyList = [];
  const unwaivedCriticalSkips = [];
  const waivedSkips = [];
  const seenMutationKeys = new Set();
  const policyExcludedTitles = [];

  for (const hint of excludedMutationHints) {
    if (typeof hint === 'string') {
      const m = /^([^:]+):(\d+)/.exec(hint);
      const key = m ? normalizeMutationDedupKey(m[1], Number(m[2])) : hint;
      if (!seenMutationKeys.has(key)) {
        seenMutationKeys.add(key);
        policyExcludedTitles.push(hint);
      }
    } else if (hint && typeof hint === 'object') {
      const key = normalizeMutationDedupKey(hint.file, hint.line);
      if (!seenMutationKeys.has(key)) {
        seenMutationKeys.add(key);
        policyExcludedTitles.push(hint.label || `${hint.file}:${hint.line}`);
      }
    }
  }

  const quarantineSet = new Set(
    (quarantinedTests || []).map((q) => (typeof q === 'string' ? q : `${q.file}::${q.title}`))
  );

  for (const t of allTests) {
    const isMutation = t.tags.includes('@mutation');
    const isCritical = t.tags.includes('@critical') || t.tags.includes('@smoke');
    const isE2e = t.projectName === 'e2e' || String(t.file).replace(/\\/g, '/').includes('e2e/');
    const retryPassed = t.status === 'expected' && Array.isArray(t.results) && t.results.length > 1;
    const isQuarantined =
      quarantineSet.has(t.title) || quarantineSet.has(`${String(t.file).replace(/\\/g, '/')}::${t.title}`);

    if (t.status === 'expected' && !retryPassed) {
      passed += 1;
      if (isE2e) e2eExecuted += 1;
    } else if (t.status === 'flaky' || retryPassed) {
      if (isE2e) e2eExecuted += 1;
      if (isQuarantined) {
        quarantinedCount += 1;
        warnings.push(`[Quarantined Flaky] ${t.file}:${t.line} — ${t.title}`);
      } else {
        flaky += 1;
        flakyList.push(`${t.file}:${t.line} — ${t.title}`);
      }
    } else if (t.status === 'unexpected') {
      if (isE2e) e2eExecuted += 1;
      if (isQuarantined && !isCritical) {
        quarantinedCount += 1;
        warnings.push(`[Quarantined Failure] ${t.file}:${t.line} — ${t.title}`);
      } else {
        failed += 1;
        failedList.push(`${t.file}:${t.line} — ${t.title}`);
      }
    } else if (t.status === 'skipped') {
      if (isMutation && !allowMutation) {
        const dedupKey = normalizeMutationDedupKey(t.file, t.line);
        if (!seenMutationKeys.has(dedupKey)) {
          seenMutationKeys.add(dedupKey);
          policyExcludedTitles.push(`${t.file}:${t.line} — ${t.title}`);
        }
        continue;
      }
      skipped += 1;
      if (isCritical) {
        const waiver = isCoveredByWaiver(t, activeWaivers, 'test');
        if (waiver) {
          waivedSkips.push(`${t.title} (waived by ${waiver.owner} until ${waiver.expiresAt})`);
        } else {
          unwaivedCriticalSkips.push(`${t.file}:${t.line} — ${t.title}`);
        }
      }
    }
  }

  const policyExcludedMutations = seenMutationKeys.size;

  const topErrors = Array.isArray(resultsObj.errors) ? resultsObj.errors : [];
  if (topErrors.length > 0) {
    for (const e of topErrors) {
      errors.push(`Runner error: ${(e.message || JSON.stringify(e)).split('\n')[0]}`);
    }
  }

  const executed = passed + failed + flaky + quarantinedCount;
  if (executed === 0) {
    errors.push('Zero tests were executed (passed + failed + flaky === 0). Empty or all-skipped runs cannot pass.');
  }

  if (failed > 0) {
    errors.push(`${failed} test(s) failed: ${failedList.slice(0, 5).join('; ')}`);
  }

  if (unwaivedCriticalSkips.length > 0) {
    errors.push(
      `${unwaivedCriticalSkips.length} @critical/@smoke test(s) were skipped without an active waiver: ${unwaivedCriticalSkips.join('; ')}`
    );
  }

  if (skipped > maxSkipped) {
    errors.push(`Skipped test count (${skipped}) exceeds --max-skipped (${maxSkipped}).`);
  }

  if (flaky > maxFlaky) {
    errors.push(`Flaky test count (${flaky}) exceeds --max-flaky (${maxFlaky}): ${flakyList.join('; ')}`);
  } else if (flaky > 0) {
    warnings.push(`${flaky} flaky test(s) detected: ${flakyList.join('; ')}`);
  }

  if (requireE2e && e2eExecuted === 0) {
    errors.push('--require-e2e is enabled, but 0 online E2E tests were executed.');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: {
      total: allTests.length,
      executed,
      passed,
      failed,
      flaky,
      quarantined: quarantinedCount,
      skipped,
      policyExcludedMutations,
      e2eExecuted,
    },
    policyExcludedTitles,
    waivedSkips,
  };
}

function buildAssertRegex(assertPatterns) {
  const safePatterns = assertPatterns.filter((p) => p && p !== '*');
  if (safePatterns.length === 0) return /\bexpect\s*\(/;
  const parts = safePatterns.map((pat) => {
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-zA-Z0-9_$]*');
    return `\\b${escaped}\\s*\\(`;
  });
  return new RegExp(parts.join('|'));
}

function isConstantPrimitiveLiteral(rawArg) {
  const s = String(rawArg || '').trim();
  if (!s) return false;
  if (/^(true|false|null|undefined|NaN|\d[\d_.]*|'[^']*'|"[^"]*"|`[^`$]*`|\{\s*\}|\[\s*\])$/.test(s)) {
    return true;
  }
  return false;
}

/**
 * Classifies an assertion statement or expression on the S0..S5 strength lattice.
 * @param {string} stmt
 */
export function classifyAssertionStatement(stmt) {
  const clean = String(stmt || '').trim();
  const isSoft = /\bexpect\.soft\s*\(/.test(clean);

  // Domain helpers exported by fixtures/base.ts
  if (/\b(?:expectAccessible|expectPerformanceBudget|expectApiContract)\s*\(/.test(clean)) {
    return { tier: 5, label: 'S5-domain-contract', matcher: 'domainHelper', isSoft, isTautology: false, raw: clean };
  }

  const expMatch = /\bexpect(?:\.(?:soft|poll))?\s*\(\s*([\s\S]*?)\s*\)\s*(?:\.\s*not\s*)?\.\s*([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)/.exec(
    clean
  );
  if (!expMatch) {
    return { tier: 3, label: 'S3-custom-helper', matcher: 'custom', isSoft, isTautology: false, raw: clean };
  }

  const actualExpr = expMatch[1].trim();
  const matcher = expMatch[2].trim();
  const expectedArg = expMatch[3].trim();

  // Detect S0 tautologies: expect(true).toBe(true), expect(1).toBeTruthy(), expect('x').toBeDefined(), etc.
  if (isConstantPrimitiveLiteral(actualExpr)) {
    return { tier: 0, label: 'S0-tautology', matcher, isSoft, isTautology: true, expectedArg, actualExpr, raw: clean };
  }

  if (S5_EXACT_MATCHERS.has(matcher)) {
    if ((matcher === 'toHaveText' || matcher === 'toHaveURL') && /^\/.*\/[gimsuy]*$/.test(expectedArg)) {
      return { tier: 3, label: 'S3-regex-match', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
    }
    if (matcher === 'toBe' && /^(true|false)$/.test(expectedArg) && !/\.(status|ok|isDisabled|isChecked|isVisible)\b/.test(actualExpr) && !/\bArray\.isArray\b|\btypeof\b/.test(actualExpr)) {
      return { tier: 2, label: 'S2-boolean-check', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
    }
    return { tier: 5, label: 'S5-exact', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
  }
  if (S4_STRUCTURAL_MATCHERS.has(matcher)) {
    if (matcher === 'toHaveTitle' && /^\/.*\/[gimsuy]*$/.test(expectedArg)) {
      return { tier: 3, label: 'S3-regex-title', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
    }
    return { tier: 4, label: 'S4-structural', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
  }
  if (S3_PARTIAL_MATCHERS.has(matcher)) {
    return { tier: 3, label: 'S3-partial', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
  }
  if (S2_STATE_MATCHERS.has(matcher)) {
    return { tier: 2, label: 'S2-state', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
  }
  if (S1_WEAK_MATCHERS.has(matcher)) {
    return { tier: 1, label: 'S1-weak', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
  }

  return { tier: 3, label: 'S3-other', matcher, isSoft, isTautology: false, expectedArg, actualExpr, raw: clean };
}

function detectSwallowedCatchInCode(codeSnippet) {
  // Matches .catch(() => ...), .catch(function() { ... }), .catch(Boolean) where body does not throw
  const catchMatches = [...codeSnippet.matchAll(/\.catch\s*\(\s*([\s\S]{0,160}?)\)/g)];
  for (const m of catchMatches) {
    const handler = m[1].trim();
    if (!/\bthrow\b/.test(handler)) {
      return m[0];
    }
  }
  // Matches try { ... } catch (...) { ... } where catch block does not throw
  const tryCatchMatches = [...codeSnippet.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{([^}]*)\}/g)];
  for (const m of tryCatchMatches) {
    if (!/\bthrow\b/.test(m[1])) {
      return m[0];
    }
  }
  return null;
}

function detectEmptyCustomHelperInSource(strippedSource, assertFunctionNames) {
  const customPrefixes = assertFunctionNames
    .filter((n) => n !== 'expect*' && n !== 'expect')
    .map((n) => n.replace(/\*/g, '[a-zA-Z0-9_$]*'));
  if (customPrefixes.length === 0) return [];
  const fnRe = new RegExp(
    `(?:async\\s+)?function\\s+(${customPrefixes.join('|')})\\s*\\([^)]*\\)\\s*\\{([^}]*)\\}|const\\s+(${customPrefixes.join('|')})\\s*=\\s*(?:async\\s*)?\\([^)]*\\)\\s*=>\\s*\\{([^}]*)\\}`,
    'g'
  );
  const badHelpers = [];
  for (const m of strippedSource.matchAll(fnRe)) {
    const fnName = m[1] || m[3];
    const body = m[2] || m[4] || '';
    if (!/\b(?:expect|expectAccessible|expectApiContract|expectPerformanceBudget|assert)\b/.test(body)) {
      badHelpers.push(fnName);
    }
  }
  return badHelpers;
}

/**
 * AST + Regex Spec Scanner: uses TypeScript Compiler AST when available + structural checks.
 */
export function scanSpecFilesFallback(testsDir, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [], qaDir } = options;
  const errors = [...validateAssertFunctionNames(assertFunctionNames)];
  if (!fs.existsSync(testsDir)) return { ok: errors.length === 0, errors };

  const assertRegex = buildAssertRegex(assertFunctionNames);
  const ts = resolveTypeScriptCompiler(qaDir || path.dirname(testsDir));

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.spec\.[jt]s$/.test(entry.name)) continue;
      if (entry.name === 'seed.spec.ts' || entry.name.endsWith('.official.example.ts')) continue;

      const rel = path.relative(testsDir, full).replace(/\\/g, '/');
      const raw = fs.readFileSync(full, 'utf8');
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      if (/\b(?:test|it|describe)\.only\s*\(/.test(stripped)) {
        errors.push(`[Static Check] Focused test (.only) forbidden in ${rel}`);
      }
      if (/\bwaitForTimeout\s*\(/.test(stripped)) {
        errors.push(`[Static Check] Hardcoded waitForTimeout() forbidden in ${rel}`);
      }
      if (/\b(?:test|it)\.(?:skip|fixme)\s*\(/.test(stripped)) {
        const covered = isCoveredByWaiver({ file: rel, title: raw }, activeWaivers, 'spec');
        if (!covered) {
          errors.push(`[Static Check] Unwaived test.skip/test.fixme forbidden in ${rel}`);
        }
      }
      if (/\b(?:test|it)\.fail\s*\(/.test(stripped)) {
        const covered = isCoveredByWaiver({ file: rel, title: raw }, activeWaivers, 'spec');
        if (!covered) {
          errors.push(`[Static Check] Expectation-inverting test.fail() forbidden in ${rel}`);
        }
      }
      if (/\brequest\.newContext\s*\(/.test(stripped)) {
        errors.push(`[Static Check] Raw request.newContext() bypasses API safety guard in ${rel}; use { request } fixture from base.ts.`);
      }

      const emptyHelpers = detectEmptyCustomHelperInSource(stripped, assertFunctionNames);
      for (const hName of emptyHelpers) {
        errors.push(`[Static Check] Custom assertion helper "${hName}" in ${rel} contains zero real expect() calls.`);
      }

      // Check tautological S0 assertions via AST or expression scan
      for (const line of stripped.split(/\r?\n/)) {
        if (/\bexpect\s*\(/.test(line)) {
          const cls = classifyAssertionStatement(line);
          if (cls.isTautology) {
            errors.push(`[Static Check] Tautological S0 assertion forbidden in ${rel}: "${line.trim()}"`);
          }
        }
      }

      if (ts) {
        // Real TypeScript AST inspection for conditional assertions (`if (...) { expect(...) }`)
        try {
          const sf = ts.createSourceFile(rel, raw, ts.ScriptTarget.Latest, true);
          const visit = (node, insideIf = false) => {
            const isIf = ts.isIfStatement(node);
            if (insideIf && ts.isCallExpression(node)) {
              const exprText = node.expression.getText(sf);
              if (exprText === 'expect' || exprText.startsWith('expect.')) {
                const covered = isCoveredByWaiver({ file: rel, title: node.getText(sf) }, activeWaivers, 'spec');
                if (!covered) {
                  errors.push(`[Static Check] Conditional expect() inside if-statement forbidden in ${rel}`);
                }
              }
            }
            ts.forEachChild(node, (child) => visit(child, insideIf || isIf));
          };
          visit(sf, false);
        } catch {
          // fallback below still runs
        }
      }

      const hasTestCall = /\b(?:test|it)\s*\(/.test(stripped);
      if (hasTestCall && !assertRegex.test(stripped)) {
        errors.push(
          `[Static Check] Spec ${rel} contains test() without any recognized assertion (${assertFunctionNames.join(', ')})`
        );
      }
    }
  };

  walk(testsDir);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * Layer 2: Runs `tsc --noEmit` + `eslint` + built-in AST semantic rules.
 */
export function runStaticSpecChecks(qaDir, options = {}) {
  const cfg = loadAitestConfig(qaDir);
  const activeWaivers = options.activeWaivers || [];
  const errors = [...validateAssertFunctionNames(cfg.assertFunctionNames)];
  const warnings = [];

  const tscBin = path.join(qaDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const tsconfigPath = path.join(qaDir, 'tsconfig.json');
  if (fs.existsSync(tscBin) && fs.existsSync(tsconfigPath)) {
    const tscRes = spawnSync(process.execPath, [tscBin, '--noEmit', '-p', tsconfigPath], {
      cwd: qaDir,
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (tscRes.status !== 0) {
      const msg = (tscRes.stdout || tscRes.stderr || '').trim();
      errors.push(`[TypeCheck] tsc --noEmit failed:\n${msg}`);
    }
  } else {
    warnings.push('[TypeCheck] typescript compiler not installed locally; skipped tsc --noEmit.');
  }

  const eslintBin = path.join(qaDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const eslintCfg = path.join(qaDir, 'eslint.config.mjs');
  const testsDir = path.join(qaDir, 'tests');

  if (fs.existsSync(eslintBin) && fs.existsSync(eslintCfg) && fs.existsSync(testsDir)) {
    const eslintRes = spawnSync(process.execPath, [eslintBin, 'tests'], {
      cwd: qaDir,
      shell: false,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (eslintRes.status !== 0) {
      const msg = (eslintRes.stdout || eslintRes.stderr || '').trim();
      errors.push(`[ESLint] Playwright anti-fake-green lint failed:\n${msg}`);
    }
    // Always run supplementary semantic checks (tautology S0, test.fail, request.newContext, empty custom helpers)
    const semanticScan = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
      qaDir,
    });
    for (const e of semanticScan.errors) {
      if (!errors.includes(e)) errors.push(e);
    }
  } else {
    warnings.push('[Static Check] eslint not found in node_modules; running built-in AST/semantic spec scanner.');
    const fallback = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
      qaDir,
    });
    errors.push(...fallback.errors);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Layer 3: Semantic Diff Guard v2 (`AITEST-G101` .. `AITEST-G113`).
 * Detects assertion deletion, assertion strength downgrade (S5->S2/S1), tautological S0 assertions,
 * `test.fail()`, `expect.soft()`, ANY swallowed `.catch(...)` / `try-catch`, retry/timeout inflation,
 * generic locator degradation (`getByRole` -> `locator('body')`), conditional assertions, and
 * protected governance/config file edits (`testIgnore`, ESLint rule `'off'`, `waivers.json`, etc.).
 */
export function analyzeHealerDiffText(diffText, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [] } = options;
  const assertGlobalRegex = new RegExp(buildAssertRegex(assertFunctionNames).source, 'g');
  const violations = [...validateAssertFunctionNames(assertFunctionNames)];

  if (!diffText || !diffText.trim()) {
    return { ok: violations.length === 0, violations };
  }

  let currentFile = 'unknown';
  let addedAsserts = 0;
  let removedAsserts = 0;
  /** @type {Array<ReturnType<typeof classifyAssertionStatement>>} */
  let removedClassifications = [];
  /** @type {Array<ReturnType<typeof classifyAssertionStatement>>} */
  let addedClassifications = [];
  let removedSemanticLocators = 0;
  let addedGenericLocators = 0;
  let removedSuccessStatus = false;
  let addedServerErrorStatus = false;
  let addedLinesBuffer = [];

  const canWaive = (titleKey) => isCoveredByWaiver({ file: currentFile, title: titleKey }, activeWaivers, 'diff');

  const flushFileAnalysis = () => {
    if (currentFile === 'unknown') return;

    // AITEST-G102: Net assertion count reduction
    if (removedAsserts > addedAsserts && !canWaive('assertion-deletion')) {
      violations.push(
        `[Healer Diff Guard][AITEST-G102] ${currentFile}: net assertion reduction detected (removed ${removedAsserts}, added ${addedAsserts}).`
      );
    }

    // AITEST-G103: Assertion strength lattice downgrade (even when count is unchanged!)
    if (removedClassifications.length > 0 && addedClassifications.length > 0) {
      const removedMax = Math.max(...removedClassifications.map((c) => c.tier));
      const addedMax = Math.max(...addedClassifications.map((c) => c.tier));
      const removedSum = removedClassifications.reduce((s, c) => s + c.tier, 0);
      const addedSum = addedClassifications.reduce((s, c) => s + c.tier, 0);
      if ((addedMax < removedMax || addedSum < removedSum) && !canWaive('assertion-weakening')) {
        violations.push(
          `[Healer Diff Guard][AITEST-G103] ${currentFile}: assertion strength downgraded (max tier S${removedMax} -> S${addedMax}, total strength ${removedSum} -> ${addedSum}).`
        );
      }
    }

    // AITEST-G111: Semantic locator degraded to generic body/html/*
    if (removedSemanticLocators > 0 && addedGenericLocators > 0 && !canWaive('locator-degradation')) {
      violations.push(
        `[Healer Diff Guard][AITEST-G111] ${currentFile}: semantic locator (getByRole/Label/Text/TestId) degraded to generic body/html/* locator.`
      );
    }

    // AITEST-G112: Oracle flipped from 2xx/4xx expected status to 5xx server error status
    if (removedSuccessStatus && addedServerErrorStatus && !canWaive('oracle-5xx-flip')) {
      violations.push(
        `[Healer Diff Guard][AITEST-G112] ${currentFile}: HTTP status oracle flipped from 2xx/4xx to 5xx to mask backend failure.`
      );
    }

    // Multi-line catch / conditional check across added lines in hunk ( handles nested parens in `if (await loc.isVisible())` )
    if (addedLinesBuffer.length > 0) {
      const joinedAdded = addedLinesBuffer.join('\n');
      if (/\bif\s*\([^\r\n]+\)\s*(?:\{[\s\S]{0,400}?|\s+)\bexpect(?:\.(?:soft|poll))?\s*\(/.test(joinedAdded) && !canWaive('conditional-expect')) {
        violations.push(
          `[Healer Diff Guard][AITEST-G110] ${currentFile}: wrapping expect() inside conditional if-block is forbidden.`
        );
      }
      const emptyHelpers = detectEmptyCustomHelperInSource(joinedAdded, assertFunctionNames);
      for (const h of emptyHelpers) {
        violations.push(
          `[Healer Diff Guard][AITEST-G113] ${currentFile}: added custom assertion helper "${h}" with zero expect() calls.`
        );
      }
    }

    addedAsserts = 0;
    removedAsserts = 0;
    removedClassifications = [];
    addedClassifications = [];
    removedSemanticLocators = 0;
    addedGenericLocators = 0;
    removedSuccessStatus = false;
    addedServerErrorStatus = false;
    addedLinesBuffer = [];
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushFileAnalysis();
      const match = line.match(/ b\/(.+)$/);
      currentFile = match ? match[1].trim() : 'unknown';

      // AITEST-G101: Protected config / lint / governance file edited in diff
      if (PROTECTED_DIFF_PATH_RE.test(currentFile) && !canWaive('protected-file')) {
        violations.push(
          `[Healer Diff Guard][AITEST-G101] ${currentFile}: modification to protected governance/config file is forbidden without human approval.`
        );
      }
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@ ')) continue;

    if (line.startsWith('-')) {
      const body = line.slice(1);
      if (!/^\s*\/\//.test(body)) {
        const matches = body.match(assertGlobalRegex);
        if (matches) {
          removedAsserts += matches.length;
          removedClassifications.push(classifyAssertionStatement(body));
        }
        if (/\.(?:getByRole|getByLabel|getByText|getByTestId|getByPlaceholder)\s*\(/.test(body)) {
          removedSemanticLocators += 1;
        }
        if (/\.toBe\s*\(\s*(?:200|201|202|204|400|401|403|404|409)\s*\)/.test(body)) {
          removedSuccessStatus = true;
        }
      }
      continue;
    }

    if (line.startsWith('+')) {
      const body = line.slice(1);
      if (/^\s*\/\//.test(body)) continue;
      addedLinesBuffer.push(body);

      const matches = body.match(assertGlobalRegex);
      if (matches) {
        addedAsserts += matches.length;
        const cls = classifyAssertionStatement(body);
        addedClassifications.push(cls);

        // AITEST-G104: Tautological / constant assertion (S0)
        if (cls.isTautology && !canWaive(body)) {
          violations.push(
            `[Healer Diff Guard][AITEST-G104] ${currentFile}: tautological/constant assertion (S0) forbidden ("${body.trim()}").`
          );
        }
        // AITEST-G106: Soft assertion downgrade
        if (cls.isSoft && !canWaive(body)) {
          violations.push(
            `[Healer Diff Guard][AITEST-G106] ${currentFile}: soft assertion expect.soft() weakens gate enforcement ("${body.trim()}").`
          );
        }
      }

      if (/\.(?:locator)\s*\(\s*['"`](?:body|html|\*|div)['"`]\s*\)/.test(body)) {
        addedGenericLocators += 1;
      }
      if (/\.toBe\s*\(\s*50\d\s*\)/.test(body)) {
        addedServerErrorStatus = true;
      }

      // AITEST-G105: skip / fixme / only / fail expectation inversion
      if (/\b(?:test|it|describe)\.(?:skip|fixme|only)\s*\(/.test(body)) {
        if (!canWaive(body)) {
          violations.push(`[Healer Diff Guard][AITEST-G105] ${currentFile}: added skip/fixme/only ("${body.trim()}").`);
        }
      }
      if (/\b(?:test|it|describe)\.fail\s*\(/.test(body)) {
        if (!canWaive(body)) {
          violations.push(
            `[Healer Diff Guard][AITEST-G105] ${currentFile}: added expectation-inverting test.fail() ("${body.trim()}").`
          );
        }
      }

      // Config-level bypass patterns even if path was unusual: testIgnore, rule 'off'
      if (/\btestIgnore\s*:/.test(body) && !canWaive(body)) {
        violations.push(`[Healer Diff Guard][AITEST-G101] ${currentFile}: added testIgnore exclusion ("${body.trim()}").`);
      }
      if (/['"]playwright\/[^'"]+['"]\s*:\s*['"](?:off|warn)['"]/.test(body) && !canWaive(body)) {
        violations.push(
          `[Healer Diff Guard][AITEST-G101] ${currentFile}: weakened eslint-plugin-playwright rule ("${body.trim()}").`
        );
      }

      // AITEST-G108: { force: true }
      if (/\bforce\s*:\s*true\b/.test(body) && !canWaive(body)) {
        violations.push(`[Healer Diff Guard][AITEST-G108] ${currentFile}: added { force: true } ("${body.trim()}").`);
      }

      // AITEST-G107: Swallowed exceptions via any non-throwing .catch(...)
      const swallowed = detectSwallowedCatchInCode(body);
      if (swallowed && !canWaive(body)) {
        violations.push(
          `[Healer Diff Guard][AITEST-G107] ${currentFile}: swallowed exception via non-rethrowing catch ("${body.trim()}").`
        );
      }

      // AITEST-G109: Retry inflation (`retries: >= 1`) or excessive timeout (`>= 60000`)
      const retryMatch = body.match(/\bretries\s*:\s*(\d+)/);
      if (retryMatch && Number(retryMatch[1]) >= 1 && !canWaive(body)) {
        violations.push(
          `[Healer Diff Guard][AITEST-G109] ${currentFile}: added test retry inflation (retries: ${retryMatch[1]}) ("${body.trim()}").`
        );
      }
      const timeoutMatch = body.match(/\b(?:setTimeout\s*\(\s*|timeout\s*:\s*)(\d[\d_]*)/);
      if (timeoutMatch) {
        const ms = Number(timeoutMatch[1].replace(/_/g, ''));
        if (ms >= 60_000 && !canWaive(body)) {
          violations.push(
            `[Healer Diff Guard][AITEST-G109] ${currentFile}: excessive timeout (${ms}ms >= 60000ms) ("${body.trim()}").`
          );
        }
      }
    }
  }

  flushFileAnalysis();
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}

/**
 * Runs full-QA-directory git diff guard (covering `tests/`, configs, fixtures, waivers, and untracked files!).
 */
export function runGitDiffGuard(qaDir, diffBase, options = {}) {
  const gitRes = spawnSync('git', ['diff', diffBase, '--', qaDir], {
    cwd: qaDir,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (gitRes.status !== 0) {
    return {
      ok: false,
      violations: [`[Healer Diff Guard] git diff "${diffBase}" failed: ${(gitRes.stderr || gitRes.stdout || '').trim()}`],
    };
  }

  const cfg = loadAitestConfig(qaDir);
  let combinedDiff = gitRes.stdout || '';

  // Also include untracked files inside qaDir (excluding generated artifacts) so newly dropped rogue configs/specs are inspected
  const untrackedRes = spawnSync('git', ['ls-files', '--others', '--exclude-standard', '--', qaDir], {
    cwd: qaDir,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (untrackedRes.status === 0 && untrackedRes.stdout) {
    for (const rawRel of untrackedRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)) {
      const fullUntracked = path.resolve(qaDir, rawRel);
      const relInsideQa = path.relative(qaDir, fullUntracked).replace(/\\/g, '/');
      if (/^(reports|playwright-report|test-results|knowledge|\.aitest|node_modules)\//.test(relInsideQa)) continue;
      if (!fs.existsSync(fullUntracked) || !fs.statSync(fullUntracked).isFile()) continue;
      if (!/\.(ts|js|mjs|json)$/.test(relInsideQa)) continue;
      const content = fs.readFileSync(fullUntracked, 'utf8');
      const syntheticHunk = [
        `diff --git a/${relInsideQa} b/${relInsideQa}`,
        '--- /dev/null',
        `+++ b/${relInsideQa}`,
        '@@ -0,0 +1 @@',
        ...content.split(/\r?\n/).map((l) => `+${l}`),
      ].join('\n');
      combinedDiff += `\n${syntheticHunk}`;
    }
  }

  return analyzeHealerDiffText(combinedDiff, {
    assertFunctionNames: cfg.assertFunctionNames,
    activeWaivers: options.activeWaivers || [],
  });
}

/**
 * Verifies Run Ledger binding on `reports/results.json` when `.aitest/runs/latest.json` exists.
 */
export function verifyLedgerBindingInQaDir(qaDir, resultsPath, rawResultsObj, options = {}) {
  if (options.allowUnboundResults) {
    return { ok: true, enforced: false, runId: null, errors: [], warnings: [] };
  }

  const latestPath = path.join(qaDir, '.aitest', 'runs', 'latest.json');
  if (!fs.existsSync(latestPath)) {
    return { ok: true, enforced: false, runId: null, errors: [], warnings: [] };
  }

  const errors = [];
  const warnings = [];
  let latest;
  try {
    latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
  } catch (err) {
    return {
      ok: false,
      enforced: true,
      runId: null,
      errors: [`[Run Ledger Blocked] Corrupted .aitest/runs/latest.json: ${err.message}`],
      warnings,
    };
  }

  const manifestPath = path.join(qaDir, '.aitest', 'runs', String(latest.runId || ''), 'manifest.json');
  if (!latest.runId || !fs.existsSync(manifestPath)) {
    return {
      ok: false,
      enforced: true,
      runId: latest.runId || null,
      errors: [`[Run Ledger Blocked] Missing run manifest for runId="${latest.runId}". Re-run "aitest run".`],
      warnings,
    };
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const resolvedDefaultResults = path.resolve(qaDir, 'reports', 'results.json');
  if (path.resolve(resultsPath) !== resolvedDefaultResults) {
    // Auditing an explicit custom results path: skip latest.json hash check unless expectedRunId specified
    if (!options.expectedRunId) {
      return { ok: true, enforced: false, runId: manifest.runId, errors, warnings };
    }
  }

  const actualResultsSha = `sha256:${sha256Hex(fs.readFileSync(resultsPath, 'utf8'))}`;
  if (manifest.resultsSha256 && actualResultsSha !== manifest.resultsSha256) {
    errors.push(
      `[Stale/Tampered Results Blocked] reports/results.json SHA-256 does not match Run Ledger manifest (${manifest.runId}).`
    );
  }

  const embeddedRunId = rawResultsObj?.config?.metadata?.runId;
  if (embeddedRunId && embeddedRunId !== manifest.runId) {
    errors.push(
      `[Stale Results Blocked] results.json metadata.runId (${embeddedRunId}) != latest Ledger runId (${manifest.runId}).`
    );
  }

  if (manifest.worktreeHash && typeof options.currentWorktreeHash === 'string') {
    if (options.currentWorktreeHash !== manifest.worktreeHash) {
      errors.push(
        `[Stale Results Blocked] Workspace source/spec files changed since runId=${manifest.runId} completed (worktreeHash mismatch). Re-run "aitest run" so green results match current code.`
      );
    }
  }

  return {
    ok: errors.length === 0,
    enforced: true,
    runId: manifest.runId,
    errors,
    warnings,
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint of code + specs under test (excluding generated report directories).
 */
export function computeWorkspaceInputHash(qaDir, repoDir = path.dirname(qaDir)) {
  const hash = crypto.createHash('sha256');
  const ignoreDirs = new Set([
    '.git',
    'node_modules',
    'reports',
    'playwright-report',
    'test-results',
    'knowledge',
    '.aitest',
    'dist',
    'build',
    '.next',
    'coverage',
  ]);

  const walk = (dir, prefix, maxFilesState) => {
    if (!dir || !fs.existsSync(dir) || maxFilesState.count > 2500) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (ignoreDirs.has(entry.name)) continue;
      if (entry.name === '.env' || entry.name.endsWith('.log')) continue;
      const full = path.join(dir, entry.name);
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, rel, maxFilesState);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|json|vue|py|java|go|sql|prisma)$/i.test(entry.name)) {
        try {
          const stat = fs.statSync(full);
          if (stat.size <= 512 * 1024) {
            maxFilesState.count += 1;
            hash.update(`${rel}:`);
            hash.update(fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n'));
            hash.update('\n');
          }
        } catch {
          // ignore transient file
        }
      }
    }
  };

  const state = { count: 0 };
  const resolvedQa = path.resolve(qaDir);
  const resolvedRepo = path.resolve(repoDir);
  walk(resolvedQa, 'qa', state);

  const looksLikeRealHostRepo =
    resolvedRepo !== resolvedQa &&
    resolvedQa.startsWith(resolvedRepo) &&
    (path.basename(resolvedQa) === 'qa' ||
      fs.existsSync(path.join(resolvedRepo, '.git')) ||
      fs.existsSync(path.join(resolvedRepo, 'package.json')));

  if (looksLikeRealHostRepo) {
    // Also hash host business repo files outside qaDir (never walk raw os.tmpdir() parent!)
    const qaFolderName = path.relative(resolvedRepo, resolvedQa).split(/[\\/]/)[0];
    ignoreDirs.add(qaFolderName);
    walk(resolvedRepo, 'repo', state);
  }

  return `sha256:${hash.digest('hex')}`;
}

function loadActiveQuarantine(qaDir, nowMs = Date.now()) {
  const qPath = path.join(qaDir, '.aitest', 'quarantine.json');
  if (!fs.existsSync(qPath)) return { ok: true, entries: [], errors: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(qPath, 'utf8'));
    const list = Array.isArray(parsed.entries) ? parsed.entries : [];
    const errors = [];
    const active = [];
    for (const item of list) {
      const exp = Date.parse(item.expiresAt || '');
      if (Number.isNaN(exp) || exp <= nowMs) {
        errors.push(`[Quarantine Expired] Quarantined flaky test "${item.title}" expired at ${item.expiresAt}; fix or escalate.`);
      } else {
        active.push(item);
      }
    }
    return { ok: errors.length === 0, entries: active, errors };
  } catch (err) {
    return { ok: false, entries: [], errors: [`Invalid JSON in .aitest/quarantine.json: ${err.message}`] };
  }
}

/**
 * Full 4-Layer Quality Gate Audit for `<qaDir>`:
 * - Layer 0: Governance Lock Integrity (`.aitest/governance.lock`) + Strict Waiver Policy
 * - Layer 1: Runtime `results.json` Audit + Run Ledger Result Binding + Quarantine Enforcement
 * - Layer 2: Static `tsc --noEmit` + `eslint-plugin-playwright` + Semantic AST Checks
 * - Layer 3: Semantic AST Diff Guard (`--diff-base`)
 */
export function runAuditForQaDir(qaDir, options = {}) {
  const resultsPath = options.resultsPath
    ? path.resolve(qaDir, options.resultsPath)
    : path.join(qaDir, 'reports', 'results.json');
  const waiversPath = options.waiversPath
    ? path.resolve(qaDir, options.waiversPath)
    : path.join(qaDir, 'waivers.json');

  const cfg = loadAitestConfig(qaDir);
  const maxFlaky = options.maxFlaky !== undefined ? Number(options.maxFlaky) : cfg.maxFlaky;
  const maxSkipped = options.maxSkipped !== undefined ? Number(options.maxSkipped) : Infinity;
  const checkSpecs = Boolean(options.checkSpecs);
  const requireE2e = Boolean(options.requireE2e);
  const staticOnly = Boolean(options.staticOnly);
  const diffBase = options.diffBase || null;
  const allowMutation =
    options.allowMutation !== undefined
      ? Boolean(options.allowMutation)
      : process.env.TEST_ALLOW_MUTATION === '1' || process.env.TEST_ALLOW_MUTATION === 'true';

  const allErrors = [];
  const allWarnings = [];
  let stats = null;
  let policyExcludedTitles = [];
  let boundRunId = null;

  // Layer 0: Governance Integrity
  let governanceStatus = 'skipped';
  if (options.skipGovernanceCheck !== true) {
    const govRes = verifyGovernanceLockInQaDir(qaDir);
    if (govRes.enforced) {
      governanceStatus = govRes.ok ? 'pass' : 'fail';
      allErrors.push(...govRes.errors);
      allWarnings.push(...govRes.warnings);
    }
  }

  const waiverCheck = loadAndValidateWaivers(waiversPath, Date.now(), {
    maxWaiverDays: cfg.maxWaiverDays,
    maxWaivers: cfg.maxWaivers,
    legacyCompat: Boolean(options.legacyWaiverCompat),
  });
  if (!waiverCheck.ok) {
    allErrors.push(...waiverCheck.errors);
  }

  const quarantineCheck = loadActiveQuarantine(qaDir);
  if (!quarantineCheck.ok) {
    allErrors.push(...quarantineCheck.errors);
  }

  // Layer 1: Runtime Results + Ledger Binding
  let runtimeStatus = staticOnly ? 'skipped' : 'pass';
  if (!staticOnly) {
    if (!fs.existsSync(resultsPath)) {
      allErrors.push(`Missing test results JSON: ${resultsPath}`);
      runtimeStatus = 'fail';
    } else {
      try {
        const rawResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        const currentWorktreeHash = computeWorkspaceInputHash(qaDir);
        const binding = verifyLedgerBindingInQaDir(qaDir, resultsPath, rawResults, {
          allowUnboundResults: Boolean(options.allowUnboundResults),
          expectedRunId: options.expectedRunId,
          currentWorktreeHash,
        });
        boundRunId = binding.runId;
        if (!binding.ok) {
          allErrors.push(...binding.errors);
          runtimeStatus = 'fail';
        }
        allWarnings.push(...binding.warnings);

        const mutationFileHints = !allowMutation ? countMutationSpecsInFiles(path.join(qaDir, 'tests')) : [];
        const resAudit = auditResultsJson(rawResults, {
          activeWaivers: waiverCheck.activeWaivers,
          requireE2e,
          maxFlaky,
          maxSkipped,
          allowMutation,
          excludedMutationHints: mutationFileHints,
          quarantinedTests: quarantineCheck.entries,
        });
        stats = resAudit.stats;
        policyExcludedTitles = resAudit.policyExcludedTitles;
        if (!resAudit.ok) runtimeStatus = 'fail';
        allErrors.push(...resAudit.errors);
        allWarnings.push(...resAudit.warnings);
      } catch (err) {
        allErrors.push(`Failed to parse ${resultsPath}: ${err.message}`);
        runtimeStatus = 'fail';
      }
    }
  }

  // Layer 2: Static Spec Checks
  let staticStatus = checkSpecs ? 'pass' : 'skipped';
  if (checkSpecs) {
    const staticRes = runStaticSpecChecks(qaDir, { activeWaivers: waiverCheck.activeWaivers });
    if (!staticRes.ok) staticStatus = 'fail';
    allErrors.push(...staticRes.errors);
    allWarnings.push(...staticRes.warnings);
  }

  // Layer 3: Semantic Diff Guard
  let diffStatus = diffBase ? 'pass' : 'skipped';
  if (diffBase) {
    const diffRes = runGitDiffGuard(qaDir, diffBase, { activeWaivers: waiverCheck.activeWaivers });
    if (!diffRes.ok) diffStatus = 'fail';
    allErrors.push(...diffRes.violations);
  }

  return {
    ok: allErrors.length === 0,
    gateKernelVersion: GATE_KERNEL_VERSION,
    runId: boundRunId,
    gates: {
      governance: governanceStatus,
      runtime: runtimeStatus,
      static: staticStatus,
      semanticDiff: diffStatus,
    },
    errors: allErrors,
    warnings: allWarnings,
    stats,
    policyExcludedTitles,
  };
}
