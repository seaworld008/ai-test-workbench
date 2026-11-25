import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isCiEnvironment } from '../../core/outcome.mjs';
import { buildAssertRegex } from './lattice.mjs';
import { analyzeSourceAst } from './parser.mjs';
import { isCoveredByWaiver, loadAitestConfig, validateAssertFunctionNames } from './policy.mjs';
import { getGateRuleByCode, isRuleEnabled } from './rules/index.mjs';
import { resolveTypeScriptCompiler } from './ts-loader.mjs';

/** @param {string[]} args @param {string} cwd */
function execNodeSync(args, cwd) {
  return spawnSync(process.execPath, args, {
    cwd,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90_000,
  });
}

const STATIC_SPEC_RULE_CODES = new Set([
  'AITEST-G104',
  'AITEST-G105',
  'AITEST-G106',
  'AITEST-G107',
  'AITEST-G108',
  'AITEST-G110',
  'AITEST-G113',
  'AITEST-G114',
]);

const FORBIDDEN_TEST_IMPORT_RE =
  /(?:from\s+|require\s*\(\s*)['"](?:(?:node:)?(?:http|https|http2|net|tls|dgram|dns|child_process|worker_threads)|undici|axios|node-fetch|got)['"]/;
const DIRECT_PW_IMPORT_RE = /(?:from\s+|require\s*\(\s*)['"]@playwright\/test['"]/;
const RAW_GLOBAL_FETCH_RE =
  /(?:(?<![.\w$])fetch\s*\(|\b(?:globalThis|window|self|global)\s*(?:\.\s*fetch|\[\s*['"]fetch['"]\s*\]))/;
const RAW_WS_OR_DYN_IMPORT_RE = /\bnew\s+WebSocket\s*\(|\bimport\s*\(/;

/**
 * Checks universal safety prohibitions across ALL `tests` TS/JS/MJS files (excluding locked `fixtures/base.ts`):
 * direct `@playwright/test` import (when workspace defines `fixtures/base.ts`), raw `fetch`/`globalThis.fetch`,
 * `new WebSocket`, dynamic `import()`, raw `request.newContext()`, and Node network/exec imports (`VULN-05`, v6.2.1).
 * @param {string} rel
 * @param {string} stripped
 * @param {string[]} errors
 * @param {boolean} hasGuardedBaseFixture
 */
function checkUniversalTestSafety(rel, stripped, errors, hasGuardedBaseFixture) {
  if (hasGuardedBaseFixture && DIRECT_PW_IMPORT_RE.test(stripped)) {
    errors.push(
      `[Static Check] File ${rel} MUST import test/expect from fixtures/base (direct '@playwright/test' import bypasses workbench guards).`
    );
  }
  if (/\brequest\.newContext\s*\(/.test(stripped)) {
    errors.push(`[Static Check] Raw request.newContext() bypasses API safety guard in ${rel}; use { request } fixture from base.ts.`);
  }
  if (FORBIDDEN_TEST_IMPORT_RE.test(stripped) || RAW_GLOBAL_FETCH_RE.test(stripped)) {
    errors.push(`[Static Check] Raw Node HTTP/network/exec or global fetch bypasses target/egress safety guard in ${rel}; use { request } fixture from base.ts.`);
  }
  if (RAW_WS_OR_DYN_IMPORT_RE.test(stripped)) {
    errors.push(`[Static Check] Raw WebSocket or dynamic import() is forbidden in ${rel} (prevents egress/static guard bypass).`);
  }
  if (/\bexpect\.extend\s*\(/.test(stripped)) {
    errors.push(`[Static Check] Custom expect.extend() in unlocked test/fixture file ${rel} is forbidden (prevents always-true matcher bypass).`);
  }
}

/**
 * AST + Structural Static Spec Scanner (`Layer 2`).
 * Scans ALL `tests` TS/JS/MJS files (except locked `fixtures/base.ts`) for egress/import safety,
 * and runs full AST semantic rules on executable `*.spec.*` / `*.test.*` specs.
 * @param {string} testsDir
 * @param {{ assertFunctionNames?: string[], activeWaivers?: Array<Record<string, any>>, qaDir?: string, rulesConfig?: Record<string, any> }} [options]
 */
export function scanSpecFilesFallback(testsDir, options = {}) {
  const { assertFunctionNames = ['expect*', 'assert*', 'verify*'], activeWaivers = [], qaDir, rulesConfig = {} } = options;
  const errors = [...validateAssertFunctionNames(assertFunctionNames)];
  if (!fs.existsSync(testsDir)) return { ok: errors.length === 0, errors };

  const assertRegex = buildAssertRegex(assertFunctionNames);
  const ts = resolveTypeScriptCompiler(qaDir || path.dirname(testsDir));
  const hasGuardedBaseFixture = fs.existsSync(path.join(testsDir, 'fixtures', 'base.ts'));

  /** @param {string} dir */
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const rel = path.relative(testsDir, full).replace(/\\/g, '/');
      if (!/\.(?:ts|tsx|js|jsx|mjs)$/i.test(entry.name)) continue;
      if (rel === 'fixtures/base.ts' || entry.name.endsWith('.official.example.ts')) continue;

      const raw = fs.readFileSync(full, 'utf8');
      const stripped = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

      // Enforce universal guardrails on ALL files under tests/ (including fixtures/custom/** and *.setup.ts)
      checkUniversalTestSafety(rel, stripped, errors, hasGuardedBaseFixture);

      if (!/\.(?:spec|test)\.[jt]s$/.test(entry.name)) continue;
      if (rel === 'seed.spec.ts') continue;

      if (/\bwaitForTimeout\s*\(/.test(stripped)) {
        errors.push(`[Static Check] Hardcoded waitForTimeout() forbidden in ${rel}`);
      }

      if (ts) {
        const astSum = analyzeSourceAst(rel, raw, { assertFunctionNames, qaDir: qaDir || path.dirname(testsDir) });
        const emptyBaseSum = {
          file: rel,
          usedAst: true,
          compilerUnavailable: false,
          assertions: [],
          customAssertCalls: 0,
          semanticLocators: 0,
          genericLocators: 0,
          successStatuses: 0,
          serverErrorStatuses: 0,
          criticalTags: [],
          testBlocks: [],
          events: {
            configTamper: [], tautologies: [], skips: [], softAssertions: [], swallowedCatches: [],
            forceTrue: [], timeoutOrRetry: [], conditionalAssertions: [], emptyHelpers: [], routeFulfills: [],
          },
          violations: [],
        };
        const canWaive = (/** @type {string} */ key) =>
          Boolean(isCoveredByWaiver({ file: rel, title: key }, activeWaivers, 'spec'));
        for (const code of STATIC_SPEC_RULE_CODES) {
          if (!isRuleEnabled(code, rulesConfig)) continue;
          const rule = getGateRuleByCode(code);
          if (!rule) continue;
          const ruleFindings = rule.evaluate({
            file: rel,
            baseSum: emptyBaseSum,
            headSum: astSum,
            baseSource: '',
            headSource: raw,
            assertFunctionNames,
            canWaive,
            rulesConfig,
            isDiffTextMode: false,
          });
          for (const f of ruleFindings) {
            errors.push(`[Static Check][${f.code}] ${f.message}`);
          }
        }
        const hasTestCall = /\b(?:test|it)\s*\(/.test(stripped);
        if (hasTestCall && astSum.assertions.length === 0 && !assertRegex.test(stripped)) {
          errors.push(
            `[Static Check] Spec ${rel} contains test() without any recognized assertion (${assertFunctionNames.join(', ')})`
          );
        }
      } else {
        if (/\b(?:test|it|describe)\.only\s*\(/.test(stripped)) {
          errors.push(`[Static Check] Focused test (.only) forbidden in ${rel}`);
        }
        if (/\b(?:test|it|describe|testInfo)\.(?:skip|fixme)\s*\(/.test(stripped)) {
          const covered = isCoveredByWaiver({ file: rel, title: raw }, activeWaivers, 'spec');
          if (!covered) errors.push(`[Static Check] Unwaived test.skip/test.fixme forbidden in ${rel}`);
        }
        if (/\b(?:test|it|describe|testInfo)\.fail\s*\(/.test(stripped)) {
          const covered = isCoveredByWaiver({ file: rel, title: raw }, activeWaivers, 'spec');
          if (!covered) errors.push(`[Static Check] Expectation-inverting test.fail() forbidden in ${rel}`);
        }
        const hasTestCall = /\b(?:test|it)\s*\(/.test(stripped);
        if (hasTestCall && !assertRegex.test(stripped)) {
          errors.push(
            `[Static Check] Spec ${rel} contains test() without any recognized assertion (${assertFunctionNames.join(', ')})`
          );
        }
      }
    }
  };

  walk(testsDir);
  return { ok: errors.length === 0, errors: [...new Set(errors)] };
}

/**
 * Layer 2 Static Check runner (`tsc --noEmit` + `eslint` + AST semantic scanner).
 * Fail-closed when `requireCompilers` or CI environment is detected and compilers are missing.
 * @param {string} qaDir
 * @param {{ activeWaivers?: Array<Record<string, any>>, requireCompilers?: boolean, env?: Record<string, string | undefined> }} [options]
 * @returns {{ ok: boolean, status: 'pass' | 'fail' | 'blocked', errors: string[], warnings: string[] }}
 */
export function runStaticSpecChecks(qaDir, options = {}) {
  const cfg = loadAitestConfig(qaDir);
  const activeWaivers = options.activeWaivers || [];
  const requireCompilers =
    options.requireCompilers !== undefined
      ? Boolean(options.requireCompilers)
      : isCiEnvironment(options.env) ||
        (fs.existsSync(path.join(qaDir, '.aitest', 'governance.lock')) &&
          fs.existsSync(path.join(qaDir, 'node_modules')));
  const errors = [...validateAssertFunctionNames(cfg.assertFunctionNames)];
  /** @type {string[]} */
  const warnings = [];
  let blocked = false;

  const tscBin = path.join(qaDir, 'node_modules', 'typescript', 'bin', 'tsc');
  const tsconfigPath = path.join(qaDir, 'tsconfig.json');
  if (fs.existsSync(tscBin) && fs.existsSync(tsconfigPath)) {
    const tscRes = execNodeSync([tscBin, '--noEmit', '-p', tsconfigPath], qaDir);
    if (tscRes.status !== 0) {
      const msg = (tscRes.stdout || tscRes.stderr || '').trim();
      errors.push(`[TypeCheck] tsc --noEmit failed:\n${msg}`);
    }
  } else if (requireCompilers) {
    blocked = true;
    errors.push('[TypeCheck Blocked] typescript compiler not installed locally; fail-closed in CI/strict mode.');
  } else {
    warnings.push('[TypeCheck] typescript compiler not installed locally; skipped tsc --noEmit.');
  }

  const eslintBin = path.join(qaDir, 'node_modules', 'eslint', 'bin', 'eslint.js');
  const eslintCfg = path.join(qaDir, 'eslint.config.mjs');
  const testsDir = path.join(qaDir, 'tests');

  if (fs.existsSync(eslintBin) && fs.existsSync(eslintCfg) && fs.existsSync(testsDir)) {
    const eslintRes = execNodeSync([eslintBin, 'tests'], qaDir);
    if (eslintRes.status !== 0) {
      const msg = (eslintRes.stdout || eslintRes.stderr || '').trim();
      errors.push(`[ESLint] Playwright anti-fake-green lint failed:\n${msg}`);
    }
    const semanticScan = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
      qaDir,
      rulesConfig: cfg.rules || {},
    });
    for (const e of semanticScan.errors) {
      if (!errors.includes(e)) errors.push(e);
    }
  } else {
    if (requireCompilers) {
      blocked = true;
      errors.push('[Static Check Blocked] eslint not found in node_modules; fail-closed in CI/strict mode.');
    } else {
      warnings.push('[Static Check] eslint not found in node_modules; running built-in AST/semantic spec scanner.');
    }
    const fallback = scanSpecFilesFallback(testsDir, {
      assertFunctionNames: cfg.assertFunctionNames,
      activeWaivers,
      qaDir,
      rulesConfig: cfg.rules || {},
    });
    errors.push(...fallback.errors);
  }

  return {
    ok: errors.length === 0,
    status: blocked ? 'blocked' : errors.length === 0 ? 'pass' : 'fail',
    errors,
    warnings,
  };
}
