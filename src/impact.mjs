import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { runProcess } from './proc.mjs';

const GLOBAL_INFRA_PATTERNS = [
  /(^|\/)package\.json$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$/i,
  /(^|\/)playwright\.config\.[jt]s$/i,
  /(^|\/)tsconfig\.json$/i,
  /(^|\/)support\//i,
  /(^|\/)tests\/fixtures\//i,
  /(^|\/)auth\.setup\.[jt]s$/i,
  /(^|\/)(router|interceptor|interceptors|middleware|store|auth|permission|gateway)(\/|\.|[A-Z_-])/i,
];

function globToRegex(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*' && glob[i + 1] === '*') {
      out += '.*';
      i += 1;
      if (glob[i + 1] === '/') i += 1;
    } else if (ch === '*') {
      out += '[^/]*';
    } else if ('.+^${}()|[]\\'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function listAllSpecFiles(testsDir, qaDir) {
  const results = [];
  if (!fs.existsSync(testsDir)) return results;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        /\.spec\.[jt]s$/.test(entry.name) &&
        entry.name !== 'seed.spec.ts' &&
        !entry.name.endsWith('.official.example.ts')
      ) {
        results.push(path.relative(qaDir, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(testsDir);
  return results;
}

/**
 * Pure deterministic impact evaluator (testable with synthetic changedFiles lists).
 */
export function evaluateImpactForFiles(changedFiles, qaDir, repoDir, options = {}) {
  const normalized = [...new Set((changedFiles || []).map((f) => f.replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean))];
  if (normalized.length === 0) {
    return {
      mode: 'full',
      reason: 'No changed files detected or diff empty — falling back to full suite for safety.',
      specs: [],
      useOnlyChanged: false,
      changedFiles: [],
    };
  }

  // Docs-only fast check? Even if docs changed alongside nothing else, fallback to smoke or full; keep safe:
  for (const file of normalized) {
    if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(file))) {
      return {
        mode: 'full',
        reason: `Shared/infrastructure file changed ("${file}") — running full regression suite.`,
        specs: [],
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  const qaRelPrefix = path.relative(repoDir, qaDir).replace(/\\/g, '/');
  const allSpecs = listAllSpecFiles(path.join(qaDir, 'tests'), qaDir);
  if (allSpecs.length === 0) {
    return {
      mode: 'full',
      reason: 'No spec files found in QA directory — falling back to full suite.',
      specs: [],
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  const impactMapPath = path.join(qaDir, 'impact-map.json');
  let rules = [];
  if (fs.existsSync(impactMapPath)) {
    try {
      const rawMap = JSON.parse(fs.readFileSync(impactMapPath, 'utf8'));
      rules = Array.isArray(rawMap.rules) ? rawMap.rules : [];
    } catch {
      return {
        mode: 'full',
        reason: 'Invalid JSON in impact-map.json — falling back to full suite.',
        specs: [],
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  const compiledRules = rules.map((r) => ({
    patterns: (Array.isArray(r.match) ? r.match : [r.source || r.match]).filter(Boolean).map(globToRegex),
    specs: Array.isArray(r.specs) ? r.specs : [],
    fullSuite: Boolean(r.fullSuite),
  }));

  const selectedSpecs = new Set();
  let allInsideQa = true;

  for (const file of normalized) {
    // Ignore pure markdown/doc edits when paired with real mapped code, or map docs safely
    if (/\.(md|txt)$/i.test(file) && !file.includes('specs/')) {
      continue;
    }

    const isInsideQa = qaRelPrefix ? file === qaRelPrefix || file.startsWith(`${qaRelPrefix}/`) : file.startsWith('tests/');
    if (isInsideQa) {
      const relInsideQa = qaRelPrefix ? file.slice(qaRelPrefix.length + 1) : file;
      if (/^tests\/.*\.spec\.[jt]s$/.test(relInsideQa) && allSpecs.includes(relInsideQa)) {
        selectedSpecs.add(relInsideQa);
        continue;
      }
      // Non-spec file inside qa/ (e.g. page object or helper) -> let Playwright --only-changed handle if baseRef exists, else full
      if (!options.canUseOnlyChanged) {
        return {
          mode: 'full',
          reason: `QA helper/config changed ("${file}") without valid git base ref — running full suite.`,
          specs: [],
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      continue;
    }

    allInsideQa = false;
    let matchedThisFile = false;

    // 1. Check explicit impact-map.json rules
    for (const rule of compiledRules) {
      if (rule.patterns.some((re) => re.test(file))) {
        if (rule.fullSuite) {
          return {
            mode: 'full',
            reason: `Impact rule for "${file}" requires full suite.`,
            specs: [],
            useOnlyChanged: false,
            changedFiles: normalized,
          };
        }
        for (const sp of rule.specs) {
          if (allSpecs.includes(sp)) {
            selectedSpecs.add(sp);
            matchedThisFile = true;
          }
        }
      }
    }

    // 2. Heuristic stem match (e.g. src/views/courses.vue -> tests/e2e/courses.spec.ts or api/courses.spec.ts)
    if (!matchedThisFile) {
      const stem = path
        .basename(file)
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .replace(/\.(controller|service|view|page|component|route|routes)$/i, '')
        .toLowerCase();
      if (stem.length >= 3 && !['index', 'main', 'app', 'utils', 'common', 'base', 'config'].includes(stem)) {
        for (const sp of allSpecs) {
          if (sp.toLowerCase().includes(stem)) {
            selectedSpecs.add(sp);
            matchedThisFile = true;
          }
        }
      }
    }

    // 3. Conservative fallback: any unmapped business file forces full regression!
    if (!matchedThisFile) {
      return {
        mode: 'full',
        reason: `Unmapped source file "${file}" has unknown blast radius — falling back to full regression suite.`,
        specs: [],
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  if (allInsideQa && selectedSpecs.size === 0 && options.canUseOnlyChanged) {
    return {
      mode: 'only-changed',
      reason: 'Only internal QA files changed — delegating to Playwright --only-changed dependency graph.',
      specs: [],
      useOnlyChanged: true,
      changedFiles: normalized,
    };
  }

  if (selectedSpecs.size === 0) {
    return {
      mode: 'full',
      reason: 'Zero specific specs resolved from diff — falling back to full regression suite.',
      specs: [],
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  return {
    mode: 'targeted',
    reason: `Mapped ${normalized.length} changed file(s) to ${selectedSpecs.size} targeted spec(s) (+ smoke).`,
    specs: [...selectedSpecs].sort(),
    useOnlyChanged: false,
    changedFiles: normalized,
  };
}

export async function collectGitChangedFiles(repoDir, baseRef = 'HEAD~1') {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return { ok: false, reason: 'Target is not a git repository.', files: [], validBaseRef: false };
  }

  const files = new Set();
  let validBaseRef = false;

  if (baseRef) {
    const verifyRes = await runProcess('git', ['rev-parse', '--verify', baseRef], { cwd: repoDir, timeoutMs: 5000 });
    if (verifyRes.code === 0) {
      validBaseRef = true;
      const branchDiff = await runProcess('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
        cwd: repoDir,
        timeoutMs: 8000,
      });
      if (branchDiff.code === 0) {
        branchDiff.stdout
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
          .forEach((f) => files.add(f));
      }
    }
  }

  // Uncommitted staged + unstaged against HEAD (or index if unborn HEAD)
  const headCheck = await runProcess('git', ['rev-parse', '--verify', 'HEAD'], { cwd: repoDir, timeoutMs: 5000 });
  const wtDiff =
    headCheck.code === 0
      ? await runProcess('git', ['diff', '--name-only', 'HEAD'], { cwd: repoDir, timeoutMs: 8000 })
      : await runProcess('git', ['diff', '--name-only'], { cwd: repoDir, timeoutMs: 8000 });

  if (wtDiff.code === 0) {
    wtDiff.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => files.add(f));
  }

  // Untracked files
  const untracked = await runProcess('git', ['ls-files', '--others', '--exclude-standard'], {
    cwd: repoDir,
    timeoutMs: 8000,
  });
  if (untracked.code === 0) {
    untracked.stdout
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)
      .forEach((f) => files.add(f));
  }

  if (!validBaseRef && files.size === 0) {
    return {
      ok: false,
      reason: `Cannot resolve base ref "${baseRef}" (e.g. shallow clone or initial commit) and working tree is clean.`,
      files: [],
      validBaseRef: false,
    };
  }

  return { ok: true, reason: null, files: [...files], validBaseRef };
}

export async function computeImpact(targetDir, options = {}) {
  const repoDir = path.resolve(targetDir);
  const qaDir = resolveQaDirectory(repoDir, options.qaDir);
  if (!qaDir) {
    throw new Error(`QA directory not found under ${repoDir}`);
  }

  const baseRef = options.base || 'HEAD~1';
  if (Array.isArray(options.files) && options.files.length > 0) {
    return evaluateImpactForFiles(options.files, qaDir, repoDir, { canUseOnlyChanged: false });
  }

  const gitInfo = await collectGitChangedFiles(repoDir, baseRef);
  if (!gitInfo.ok) {
    return {
      mode: 'full',
      reason: `${gitInfo.reason} Falling back to full regression suite.`,
      specs: [],
      useOnlyChanged: false,
      baseRef,
      changedFiles: [],
    };
  }

  const evaluated = evaluateImpactForFiles(gitInfo.files, qaDir, repoDir, {
    canUseOnlyChanged: gitInfo.validBaseRef,
  });
  return { ...evaluated, baseRef };
}

export async function runImpactCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const explicitFiles = options.files
    ? String(options.files)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const impact = await computeImpact(options.target, {
    qaDir: options.qaDir,
    base: options.base,
    files: explicitFiles,
  });

  if (options.json) {
    console.log(JSON.stringify(impact, null, 2));
    return 0;
  }

  console.log(`\n=== ${lang === 'zh' ? 'Diff-Impact 受影响测试分析' : 'Diff-Impact Test Selection'} ===`);
  console.log(`Mode: ${impact.mode.toUpperCase()}`);
  console.log(`Reason: ${impact.reason}`);
  if (impact.changedFiles.length > 0) {
    console.log(`Changed Files (${impact.changedFiles.length}): ${impact.changedFiles.join(', ')}`);
  }
  if (impact.specs.length > 0) {
    console.log(`Selected Specs (${impact.specs.length}):`);
    for (const s of impact.specs) console.log(`  - ${s}`);
  }
  console.log(
    `\nNote: ${
      lang === 'zh'
        ? 'impact 仅用于本地与 PR 快速反馈；合入主干、Nightly 与正式发版门禁必须执行全量套件。'
        : 'Impact mode is for fast local/PR feedback only; merge, nightly, and release gates must run the full suite.'
    }\n`
  );
  return 0;
}
