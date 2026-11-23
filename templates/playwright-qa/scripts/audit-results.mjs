#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Standalone zero-dependency 3-Layer Anti-Fake-Green Quality Gate for AI Test Workbench.
 * Can be executed directly in CI (`node scripts/audit-results.mjs reports/results.json --check-specs`)
 * or imported by the `ai-test-workbench` CLI.
 */

export function loadAitestConfig(qaDir) {
  const cfgPath = path.join(qaDir, 'aitest.config.json');
  const defaults = {
    assertFunctionNames: ['expect*', 'assert*', 'verify*'],
    criticalTags: ['@critical', '@smoke'],
    maxFlaky: 0,
  };
  if (!fs.existsSync(cfgPath)) return defaults;
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return {
      ...defaults,
      ...parsed,
      assertFunctionNames: Array.isArray(parsed.assertFunctionNames)
        ? parsed.assertFunctionNames
        : defaults.assertFunctionNames,
    };
  } catch {
    return defaults;
  }
}

export function loadAndValidateWaivers(waiversPath, nowMs = Date.now()) {
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
    const inlineTags = (fullTitle.match(/@[a-zA-Z0-9_-]+/g) || []);
    const allTags = [...new Set([...specTags, ...inlineTags])];

    for (const testEntry of spec.tests || []) {
      collected.push({
        title: fullTitle,
        file: spec.file || currentFile || '',
        line: spec.line || 0,
        projectName: testEntry.projectName || '',
        status: testEntry.status || 'unknown', // 'expected' | 'unexpected' | 'flaky' | 'skipped'
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
        for (const line of txt.split(/\r?\n/)) {
          if (/@mutation\b/.test(line) && /\btest(?:\.describe)?\s*\(/.test(line)) {
            found.push(`${path.relative(testsDir, full).replace(/\\/g, '/')}: ${line.trim()}`);
          }
        }
      }
    }
  };
  walk(testsDir);
  return found;
}

/**
 * Layer 1: Audits Playwright JSON results (`reports/results.json`).
 */
export function auditResultsJson(resultsObj, options = {}) {
  const {
    activeWaivers = [],
    requireE2e = false,
    maxFlaky = 0,
    maxSkipped = Infinity,
    allowMutation = false,
    excludedMutationHints = [],
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
  let policyExcludedMutations = excludedMutationHints.length;
  let e2eExecuted = 0;

  const failedList = [];
  const flakyList = [];
  const unwaivedCriticalSkips = [];
  const waivedSkips = [];
  const policyExcludedTitles = [...excludedMutationHints];

  for (const t of allTests) {
    const isMutation = t.tags.includes('@mutation');
    const isCritical = t.tags.includes('@critical') || t.tags.includes('@smoke');
    const isE2e = t.projectName === 'e2e' || String(t.file).replace(/\\/g, '/').includes('e2e/');

    if (t.status === 'expected') {
      passed += 1;
      if (isE2e) e2eExecuted += 1;
    } else if (t.status === 'unexpected') {
      failed += 1;
      failedList.push(`${t.file}:${t.line} — ${t.title}`);
      if (isE2e) e2eExecuted += 1;
    } else if (t.status === 'flaky') {
      flaky += 1;
      flakyList.push(`${t.file}:${t.line} — ${t.title}`);
      if (isE2e) e2eExecuted += 1;
    } else if (t.status === 'skipped') {
      if (isMutation && !allowMutation) {
        policyExcludedMutations += 1;
        policyExcludedTitles.push(`${t.file}:${t.line} — ${t.title}`);
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

  // Also check top-level Playwright config errors (e.g. syntax error in test file)
  const topErrors = Array.isArray(resultsObj.errors) ? resultsObj.errors : [];
  if (topErrors.length > 0) {
    for (const e of topErrors) {
      errors.push(`Runner error: ${(e.message || JSON.stringify(e)).split('\n')[0]}`);
    }
  }

  const executed = passed + failed + flaky;
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
      skipped,
      policyExcludedMutations,
      e2eExecuted,
    },
    policyExcludedTitles,
    waivedSkips,
  };
}

function buildAssertRegex(assertPatterns) {
  const parts = assertPatterns.map((pat) => {
    const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-zA-Z0-9_$]*');
    return `\\b${escaped}\\s*\\(`;
  });
  return new RegExp(parts.join('|'));
}

/**
 * Fallback regex spec scanner used when ESLint is unavailable (or in unit tests).
 */
export function scanSpecFilesFallback(testsDir, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [] } = options;
  const assertRegex = buildAssertRegex(assertFunctionNames);
  const errors = [];
  if (!fs.existsSync(testsDir)) return { ok: true, errors };

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
      // Strip single-line and block comments for cleaner static check
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
      const hasTestCall = /\b(?:test|it)\s*\(/.test(stripped);
      if (hasTestCall && !assertRegex.test(stripped)) {
        errors.push(
          `[Static Check] Spec ${rel} contains test() without any recognized assertion (${assertFunctionNames.join(', ')})`
        );
      }
    }
  };

  walk(testsDir);
  return { ok: errors.length === 0, errors };
}

/**
 * Layer 2: Runs `tsc --noEmit` + `eslint` (or fallback regex scanner with WARN if eslint is not installed).
 */
export function runStaticSpecChecks(qaDir, options = {}) {
  const cfg = loadAitestConfig(qaDir);
  const activeWaivers = options.activeWaivers || [];
  const errors = [];
  const warnings = [];

  // 1. TypeScript typecheck (tsc --noEmit)
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

  // 2. ESLint with eslint-plugin-playwright (preferred) + regex fallback
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
  } else {
    warnings.push('[Static Check] eslint not found in node_modules; falling back to built-in regex scanner.');
    const fallback = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
    });
    errors.push(...fallback.errors);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Layer 3: Healer Diff Guard — analyzes unified git diff of `tests/**` to block AI Healer cheating:
 * - Net deletion of assertions (`expect*` / `assert*` / `verify*`)
 * - Newly added `test.skip` / `test.fixme` / `.only`
 * - Newly added `force: true`
 * - Swallowed errors via empty `.catch(() => {})`
 * - Inflated timeouts (`>= 60000` ms)
 */
export function analyzeHealerDiffText(diffText, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [] } = options;
  const assertGlobalRegex = new RegExp(buildAssertRegex(assertFunctionNames).source, 'g');
  const violations = [];

  if (!diffText || !diffText.trim()) {
    return { ok: true, violations };
  }

  let currentFile = 'unknown';
  let addedAsserts = 0;
  let removedAsserts = 0;

  const flushFileAssertionBalance = () => {
    if (removedAsserts > addedAsserts) {
      const covered = isCoveredByWaiver({ file: currentFile, title: 'assertion-deletion' }, activeWaivers, 'diff');
      if (!covered) {
        violations.push(
          `[Healer Diff Guard] ${currentFile}: net assertion reduction detected (removed ${removedAsserts}, added ${addedAsserts}).`
        );
      }
    }
    addedAsserts = 0;
    removedAsserts = 0;
  };

  for (const line of diffText.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushFileAssertionBalance();
      const match = line.match(/ b\/(.+)$/);
      currentFile = match ? match[1] : 'unknown';
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) continue;

    if (line.startsWith('-')) {
      const body = line.slice(1);
      if (!/^\s*\/\//.test(body)) {
        const matches = body.match(assertGlobalRegex);
        if (matches) removedAsserts += matches.length;
      }
      continue;
    }

    if (line.startsWith('+')) {
      const body = line.slice(1);
      if (/^\s*\/\//.test(body)) continue;

      const matches = body.match(assertGlobalRegex);
      if (matches) addedAsserts += matches.length;

      if (/\b(?:test|it|describe)\.(?:skip|fixme|only)\s*\(/.test(body)) {
        if (!isCoveredByWaiver({ file: currentFile, title: body }, activeWaivers, 'diff')) {
          violations.push(`[Healer Diff Guard] ${currentFile}: added skip/fixme/only ("${body.trim()}").`);
        }
      }
      if (/\bforce\s*:\s*true\b/.test(body)) {
        if (!isCoveredByWaiver({ file: currentFile, title: body }, activeWaivers, 'diff')) {
          violations.push(`[Healer Diff Guard] ${currentFile}: added { force: true } ("${body.trim()}").`);
        }
      }
      if (/\.catch\s*\(\s*\([^)]*\)\s*=>\s*\{\s*\}\s*\)/.test(body)) {
        if (!isCoveredByWaiver({ file: currentFile, title: body }, activeWaivers, 'diff')) {
          violations.push(`[Healer Diff Guard] ${currentFile}: swallowed exception with empty .catch(() => {}) ("${body.trim()}").`);
        }
      }
      const timeoutMatch = body.match(/\b(?:setTimeout\s*\(\s*|timeout\s*:\s*)(\d[\d_]*)/);
      if (timeoutMatch) {
        const ms = Number(timeoutMatch[1].replace(/_/g, ''));
        if (ms >= 60_000 && !isCoveredByWaiver({ file: currentFile, title: body }, activeWaivers, 'diff')) {
          violations.push(`[Healer Diff Guard] ${currentFile}: excessive timeout (${ms}ms >= 60000ms) ("${body.trim()}").`);
        }
      }
    }
  }

  flushFileAssertionBalance();
  return { ok: violations.length === 0, violations };
}

export function runGitDiffGuard(qaDir, diffBase, options = {}) {
  const testsPath = path.join(qaDir, 'tests');
  const gitRes = spawnSync('git', ['diff', diffBase, '--', testsPath], {
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
  return analyzeHealerDiffText(gitRes.stdout || '', {
    assertFunctionNames: cfg.assertFunctionNames,
    activeWaivers: options.activeWaivers || [],
  });
}

/**
 * Full CLI runner when invoked directly as `node scripts/audit-results.mjs [results.json] [flags]`.
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

  const waiverCheck = loadAndValidateWaivers(waiversPath);
  if (!waiverCheck.ok) {
    allErrors.push(...waiverCheck.errors);
  }

  if (!staticOnly) {
    if (!fs.existsSync(resultsPath)) {
      allErrors.push(`Missing test results JSON: ${resultsPath}`);
    } else {
      try {
        const rawResults = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
        const mutationFileHints = !allowMutation ? countMutationSpecsInFiles(path.join(qaDir, 'tests')) : [];
        const resAudit = auditResultsJson(rawResults, {
          activeWaivers: waiverCheck.activeWaivers,
          requireE2e,
          maxFlaky,
          maxSkipped,
          allowMutation,
          excludedMutationHints: mutationFileHints,
        });
        stats = resAudit.stats;
        policyExcludedTitles = resAudit.policyExcludedTitles;
        allErrors.push(...resAudit.errors);
        allWarnings.push(...resAudit.warnings);
      } catch (err) {
        allErrors.push(`Failed to parse ${resultsPath}: ${err.message}`);
      }
    }
  }

  if (checkSpecs) {
    const staticRes = runStaticSpecChecks(qaDir, { activeWaivers: waiverCheck.activeWaivers });
    allErrors.push(...staticRes.errors);
    allWarnings.push(...staticRes.warnings);
  }

  if (diffBase) {
    const diffRes = runGitDiffGuard(qaDir, diffBase, { activeWaivers: waiverCheck.activeWaivers });
    allErrors.push(...diffRes.violations);
  }

  return {
    ok: allErrors.length === 0,
    errors: allErrors,
    warnings: allWarnings,
    stats,
    policyExcludedTitles,
  };
}

const isDirectMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isDirectMain) {
  const qaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const argv = process.argv.slice(2);
  let resultsArg = 'reports/results.json';
  let checkSpecs = false;
  let requireE2e = false;
  let staticOnly = false;
  let maxFlaky;
  let maxSkipped;
  let diffBase = null;

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check-specs') checkSpecs = true;
    else if (a === '--require-e2e') requireE2e = true;
    else if (a === '--static-only') staticOnly = true;
    else if (a === '--max-flaky') maxFlaky = Number(argv[++i]);
    else if (a === '--max-skipped') maxSkipped = Number(argv[++i]);
    else if (a === '--diff-base') diffBase = argv[++i];
    else if (!a.startsWith('-')) resultsArg = a;
  }

  const out = runAuditForQaDir(qaRoot, {
    resultsPath: resultsArg,
    checkSpecs,
    requireE2e,
    staticOnly,
    maxFlaky,
    maxSkipped,
    diffBase,
  });

  if (out.stats) {
    console.log(
      `[Audit Stats] passed=${out.stats.passed} failed=${out.stats.failed} flaky=${out.stats.flaky} skipped=${out.stats.skipped} policyExcludedMutation=${out.stats.policyExcludedMutations}`
    );
  }
  for (const p of out.policyExcludedTitles) {
    console.log(`  [Policy Excluded @mutation] ${p}`);
  }
  for (const w of out.warnings) {
    console.warn(`[WARN] ${w}`);
  }
  if (!out.ok) {
    for (const e of out.errors) {
      console.error(`[FAIL] ${e}`);
    }
    process.exit(1);
  }
  console.log('[OK] Quality gate passed.');
}
