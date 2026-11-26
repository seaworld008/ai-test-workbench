// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { redactSecrets } from '../core/redact.mjs';
import {
  compileDeclarativeRuleSpecs,
  loadAitestConfig,
  loadVerifiedProjectGateRules,
  matchesRuleFileGlobs,
  openTrustContext,
  verifyGovernanceLockInQaDir,
} from '../kernel/gate-kernel.mjs';

const SKIP_SWEEP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'reports',
  'playwright-report',
  'test-results',
  '.aitest',
  '.next',
  '.svelte-kit',
  'target',
]);

const SWEEP_TEXT_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|rb|php|vue|svelte|astro)$/i;
const MAX_SWEEP_FILE_BYTES = 512 * 1024;
const MAX_SWEEP_FILES = 5000;

/**
 * Recursively collects scan-eligible source files under `rootDir`.
 * @param {string} rootDir
 * @param {string} baseDir
 * @param {string | null} excludeAbsDir
 * @param {Array<{ abs: string, rel: string }>} out
 */
function walkSweepFiles(rootDir, baseDir, excludeAbsDir, out) {
  if (!fs.existsSync(rootDir) || out.length >= MAX_SWEEP_FILES) return;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_SWEEP_FILES) return;
    const abs = path.join(rootDir, entry.name);
    if (excludeAbsDir && path.resolve(abs) === excludeAbsDir) continue;
    if (entry.isDirectory()) {
      if (SKIP_SWEEP_DIRS.has(entry.name)) continue;
      walkSweepFiles(abs, baseDir, excludeAbsDir, out);
    } else if (entry.isFile() && SWEEP_TEXT_EXT_RE.test(entry.name)) {
      const rel = path.relative(baseDir, abs).replace(/\\/g, '/');
      out.push({ abs, rel });
    }
  }
}

/**
 * Formats retroactive sweep findings to Markdown (`learn-sweep.md`).
 * @param {Record<string, any>} report
 * @param {'zh' | 'en'} [lang]
 */
export function buildSweepMarkdown(report, lang = 'en') {
  const isZh = lang === 'zh';
  const lines = [
    isZh
      ? '# AI Test Workbench — 全仓回溯清扫报告 (Retroactive Memory Sweep)'
      : '# AI Test Workbench — Whole-Repo Retroactive Memory Sweep',
    '',
    `> Generated at: ${report.generatedAt}`,
    `- Active governance-locked rules: \`${report.activeRuleCount}\` · Files scanned: \`${report.scannedFiles}\` · Findings: \`${report.sweepFindings.length}\``,
    '',
  ];
  if (report.sweepFindings.length === 0) {
    lines.push(isZh ? '未检出同类潜伏反模式。' : 'Zero latent anti-pattern occurrences found across the repository.', '');
  } else {
    lines.push('| Rule | Scope | Location | Snippet | Remediation |', '|---|---|---|---|---|');
    for (const f of report.sweepFindings) {
      const snip = String(f.snippet || '').replace(/\|/g, '\\|').slice(0, 80);
      const rem = String(f.remediation || '-').replace(/\|/g, '\\|').slice(0, 80);
      lines.push(`| \`${f.code}\` | \`${f.scope}\` | \`${f.file}:${f.line}\` | \`${snip}\` | ${rem} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Single-correction whole-repository retroactive sweeper (`WU-D`, `aitw learn --action sweep`).
 * Loads ONLY governance-locked `qa/support/project-rules.json` plus `aitest.config.json#memoryPatterns`,
 * then scans both host product source files and `qa/tests/**` for latent occurrences.
 *
 * @param {string} qaDir
 * @param {{ repoDir?: string, dryRun?: boolean, lang?: 'zh' | 'en' }} [options]
 */
export function runRetroactiveSweep(qaDir, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const repoDir = path.resolve(options.repoDir || path.dirname(qaDir));
  const trustContext = openTrustContext({ qaDir, repoDir, createKeyIfMissing: false });

  // 1. Load governance-locked `qa/support/project-rules.json` (fail-closed if unapproved!)
  const projRulesRes = loadVerifiedProjectGateRules(qaDir, { trustContext });
  if (!projRulesRes.ok) {
    return {
      ok: false,
      outcome: /** @type {const} */ ('blocked'),
      exitCode: 2,
      blockerKind: 'GOVERNANCE_TAMPER_BLOCKED',
      error: projRulesRes.errors[0] || 'Unapproved project-rules.json cannot be swept',
      errors: projRulesRes.errors,
      activeRuleCount: 0,
      scannedFiles: 0,
      sweepFindings: [],
    };
  }

  /** @type {import('../kernel/gate/project-rules.mjs').CompiledProjectRuleSpec[]} */
  const allSpecs = [...projRulesRes.specs];

  // 2. Also load optional `aitest.config.json#memoryPatterns` (also governance-locked!)
  const cfg = loadAitestConfig(qaDir);
  const rawMemoryPatterns = Array.isArray(cfg.memoryPatterns) ? cfg.memoryPatterns : [];
  if (rawMemoryPatterns.length > 0) {
    const govRes = verifyGovernanceLockInQaDir(qaDir, { trustContext });
    if (!govRes.ok) {
      return {
        ok: false,
        outcome: /** @type {const} */ ('blocked'),
        exitCode: 2,
        blockerKind: 'GOVERNANCE_TAMPER_BLOCKED',
        error: govRes.errors[0] || 'aitest.config.json governance lock check failed',
        errors: govRes.errors,
        activeRuleCount: 0,
        scannedFiles: 0,
        sweepFindings: [],
      };
    }
    const compiledMem = compileDeclarativeRuleSpecs(rawMemoryPatterns);
    if (!compiledMem.ok) {
      return {
        ok: false,
        outcome: /** @type {const} */ ('blocked'),
        exitCode: 2,
        blockerKind: 'CONFIG_BLOCKED',
        error: compiledMem.errors[0] || 'Invalid memoryPatterns in aitest.config.json',
        errors: compiledMem.errors,
        activeRuleCount: 0,
        scannedFiles: 0,
        sweepFindings: [],
      };
    }
    const seenCodes = new Set(allSpecs.map((s) => s.code));
    for (const sp of compiledMem.specs) {
      if (!seenCodes.has(sp.code)) {
        seenCodes.add(sp.code);
        allSpecs.push(sp);
      }
    }
  }

  // 3. Collect target files (host product source outside qa/ + qa/tests/**)
  /** @type {Array<{ abs: string, rel: string, area: 'product' | 'specs' }>} */
  const targets = [];
  const absQa = path.resolve(qaDir);
  if (repoDir !== absQa) {
    /** @type {Array<{ abs: string, rel: string }>} */
    const prodFiles = [];
    walkSweepFiles(repoDir, repoDir, absQa, prodFiles);
    for (const f of prodFiles) {
      targets.push({ ...f, area: 'product' });
    }
  }
  const qaTestsDir = path.join(absQa, 'tests');
  if (fs.existsSync(qaTestsDir)) {
    /** @type {Array<{ abs: string, rel: string }>} */
    const specFiles = [];
    walkSweepFiles(qaTestsDir, repoDir, null, specFiles);
    for (const f of specFiles) {
      targets.push({ ...f, area: 'specs' });
    }
  }

  /** @type {Array<{ ruleId: string, code: string, title: string, file: string, line: number, snippet: string, scope: 'product' | 'specs', remediation: string }>} */
  const sweepFindings = [];
  let scannedFiles = 0;

  if (allSpecs.length > 0) {
    for (const fileItem of targets) {
      const eligibleRules = allSpecs.filter((rule) => {
        if (rule.scope === 'product' && fileItem.area !== 'product') return false;
        if (rule.scope === 'specs' && fileItem.area !== 'specs') return false;
        return matchesRuleFileGlobs(fileItem.rel, rule.fileGlobs);
      });
      if (eligibleRules.length === 0) continue;

      let stat;
      try {
        stat = fs.statSync(fileItem.abs);
      } catch {
        continue;
      }
      if (!stat.isFile() || stat.size > MAX_SWEEP_FILE_BYTES) continue;

      let text = '';
      try {
        text = fs.readFileSync(fileItem.abs, 'utf8');
      } catch {
        continue;
      }
      scannedFiles += 1;
      const lines = text.split(/\r?\n/);
      for (const rule of eligibleRules) {
        for (let i = 0; i < lines.length; i += 1) {
          if (rule.regex.test(lines[i])) {
            sweepFindings.push({
              ruleId: rule.id,
              code: rule.code,
              title: rule.title,
              file: fileItem.rel,
              line: i + 1,
              snippet: redactSecrets(lines[i].trim()).slice(0, 140),
              scope: fileItem.area,
              remediation: rule.remediation,
            });
          }
        }
      }
    }
  }

  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    activeRuleCount: allSpecs.length,
    activeRuleCodes: allSpecs.map((s) => s.code),
    scannedFiles,
    findingCount: sweepFindings.length,
    sweepFindings,
  };

  let sweepJsonPath = null;
  let sweepMdPath = null;
  if (!options.dryRun) {
    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    sweepJsonPath = path.join(reportsDir, 'learn-sweep.json');
    sweepMdPath = path.join(reportsDir, 'learn-sweep.md');
    fs.writeFileSync(sweepJsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(sweepMdPath, buildSweepMarkdown(report, lang), 'utf8');
  }

  return {
    ok: true,
    outcome: /** @type {const} */ ('pass'),
    exitCode: 0,
    ...report,
    sweepJsonPath,
    sweepMdPath,
  };
}
