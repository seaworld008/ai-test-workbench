// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { readLedgerHistory } from './ledger.mjs';
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
  /(^|\/)(?:src\/)?(router|interceptor|interceptors|middleware|store|auth|permission|gateway)(\/|\.(?:[jt]sx?|mjs|vue)$)/i,
];

const GRAPH_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '/index.ts', '/index.tsx', '/index.js', '/index.vue'];
const GRAPH_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'qa', 'reports', 'playwright-report', 'test-results', '.aitest']);

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

function resolveRepoImport(fromFileAbs, specifier, repoDir) {
  let baseAbs = null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    baseAbs = path.resolve(path.dirname(fromFileAbs), specifier);
  } else if (specifier.startsWith('@/')) {
    const sub = specifier.slice(2);
    baseAbs = fs.existsSync(path.join(repoDir, 'src')) ? path.join(repoDir, 'src', sub) : path.join(repoDir, sub);
  } else {
    return null;
  }

  for (const ext of GRAPH_EXTS) {
    const candidate = `${baseAbs}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(repoDir, candidate).replace(/\\/g, '/');
    }
  }
  return null;
}

/**
 * Builds a lightweight static reverse import graph (`targetRel -> Set<importerRel>`) across TS/JS/Vue files (`I-01`).
 * @param {string} repoDir
 */
export function buildReverseImportGraph(repoDir) {
  /** @type {Map<string, Set<string>>} */
  const reverse = new Map();
  if (!repoDir || !fs.existsSync(repoDir)) return reverse;

  let scanned = 0;
  const importRe =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"`]([^'"`]+)['"`]|export\s+[\s\S]*?\s+from\s+['"`]([^'"`]+)['"`]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

  const walk = (dir) => {
    if (scanned >= 1500) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= 1500) break;
      if (GRAPH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|vue)$/i.test(entry.name)) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > 256 * 1024) continue;
        scanned += 1;
        const fromRel = path.relative(repoDir, full).replace(/\\/g, '/');
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(importRe)) {
          const spec = m[1] || m[2] || m[3];
          if (!spec) continue;
          const targetRel = resolveRepoImport(full, spec, repoDir);
          if (targetRel && targetRel !== fromRel) {
            let importers = reverse.get(targetRel);
            if (!importers) {
              importers = new Set();
              reverse.set(targetRel, importers);
            }
            importers.add(fromRel);
          }
        }
      }
    }
  };

  walk(repoDir);
  return reverse;
}

/**
 * Computes reverse transitive dependents for `startFile`, returning `Array<{ file, chain }>`.
 * @param {string} startFile
 * @param {Map<string, Set<string>>} reverseGraph
 */
export function findTransitiveDependents(startFile, reverseGraph, maxDepth = 6) {
  /** @type {Array<{ file: string, chain: string[] }>} */
  const out = [];
  const visited = new Set([startFile]);
  /** @type {Array<{ file: string, chain: string[], depth: number }>} */
  const queue = [{ file: startFile, chain: [startFile], depth: 0 }];

  while (queue.length > 0) {
    const cur = queue.shift();
    if (!cur || cur.depth >= maxDepth) continue;
    const importers = reverseGraph.get(cur.file);
    if (!importers) continue;
    for (const imp of importers) {
      if (visited.has(imp)) continue;
      visited.add(imp);
      const nextChain = [...cur.chain, imp];
      out.push({ file: imp, chain: nextChain });
      queue.push({ file: imp, chain: nextChain, depth: cur.depth + 1 });
    }
  }
  return out;
}

/**
 * Evaluates Nightly Impact Recall (`coveredFailures / totalFailures`, `I-03`).
 * @param {{ mode: string, specs: string[] }} impactResult
 * @param {string[]} failedSpecFiles
 */
export function evaluateImpactRecall(impactResult, failedSpecFiles = []) {
  const uniqueFailed = [...new Set(failedSpecFiles.map((f) => f.replace(/\\/g, '/')))];
  if (uniqueFailed.length === 0) {
    return { totalFailures: 0, coveredFailures: 0, missedSpecs: [], recall: 1 };
  }
  if (impactResult.mode === 'full') {
    return { totalFailures: uniqueFailed.length, coveredFailures: uniqueFailed.length, missedSpecs: [], recall: 1 };
  }
  const selected = new Set([
    ...impactResult.specs.map((s) => s.replace(/\\/g, '/')),
    ...uniqueFailed.filter((f) => f.startsWith('tests/smoke/')),
  ]);
  const missedSpecs = uniqueFailed.filter((f) => !selected.has(f));
  const covered = uniqueFailed.length - missedSpecs.length;
  return {
    totalFailures: uniqueFailed.length,
    coveredFailures: covered,
    missedSpecs,
    recall: Number((covered / uniqueFailed.length).toFixed(4)),
  };
}

/**
 * Impact v2 deterministic + dependency-graph + Ledger-weighted test selector (`I-01..I-04`).
 */
export function evaluateImpactForFiles(changedFiles, qaDir, repoDir, options = {}) {
  const normalized = [
    ...new Set(
      (changedFiles || [])
        .map((f) => f.replace(/\\/g, '/').replace(/^\.\//, ''))
        .filter(Boolean)
    ),
  ];

  if (normalized.length === 0) {
    return {
      mode: 'full',
      reason: 'No changed files detected or diff empty — falling back to full suite for safety.',
      specs: [],
      why: [],
      recallEstimate: 1.0,
      useOnlyChanged: false,
      changedFiles: [],
    };
  }

  for (const file of normalized) {
    if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(file))) {
      return {
        mode: 'full',
        reason: `Shared/infrastructure file changed ("${file}") — running full regression suite.`,
        specs: [],
        why: [{ spec: '*', via: `infra-guard: ${file}` }],
        recallEstimate: 1.0,
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
      why: [],
      recallEstimate: 1.0,
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
        why: [],
        recallEstimate: 1.0,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  const compiledRules = rules.map((r) => ({
    rawMatch: Array.isArray(r.match) ? r.match.join(', ') : String(r.source || r.match || ''),
    patterns: (Array.isArray(r.match) ? r.match : [r.source || r.match]).filter(Boolean).map(globToRegex),
    specs: Array.isArray(r.specs) ? r.specs : [],
    fullSuite: Boolean(r.fullSuite),
  }));

  const reverseGraph = buildReverseImportGraph(repoDir);
  /** @type {Map<string, string[]>} */
  const whyBySpec = new Map();
  const addSpecReason = (specRel, reasonStr) => {
    const arr = whyBySpec.get(specRel) || [];
    if (!arr.includes(reasonStr)) arr.push(reasonStr);
    whyBySpec.set(specRel, arr);
  };

  let allInsideQa = true;

  const matchCandidateFileToSpecs = (candidateFile, chainPrefix = null) => {
    let matchedAny = false;
    for (const rule of compiledRules) {
      if (rule.patterns.some((re) => re.test(candidateFile))) {
        if (rule.fullSuite) return { forceFull: true, matchedAny: true };
        for (const sp of rule.specs) {
          if (allSpecs.includes(sp)) {
            addSpecReason(
              sp,
              chainPrefix
                ? `import-graph: ${chainPrefix} -> rule(${rule.rawMatch})`
                : `impact-rule: ${candidateFile} (${rule.rawMatch})`
            );
            matchedAny = true;
          }
        }
      }
    }

    if (!matchedAny) {
      const stem = path
        .basename(candidateFile)
        .replace(/\.[a-zA-Z0-9]+$/, '')
        .replace(/\.(controller|service|view|page|component|route|routes)$/i, '')
        .toLowerCase();
      if (stem.length >= 3 && !['index', 'main', 'app', 'utils', 'common', 'base', 'config'].includes(stem)) {
        for (const sp of allSpecs) {
          if (sp.toLowerCase().includes(stem)) {
            addSpecReason(sp, chainPrefix ? `import-graph: ${chainPrefix} -> stem(${stem})` : `stem-match: ${candidateFile}`);
            matchedAny = true;
          }
        }
      }
    }

    return { forceFull: false, matchedAny };
  };

  for (const file of normalized) {
    if (/\.(md|txt)$/i.test(file) && !file.includes('specs/')) {
      continue;
    }

    const isInsideQa = qaRelPrefix ? file === qaRelPrefix || file.startsWith(`${qaRelPrefix}/`) : file.startsWith('tests/');
    if (isInsideQa) {
      const relInsideQa = qaRelPrefix ? file.slice(qaRelPrefix.length + 1) : file;
      if (/^tests\/.*\.spec\.[jt]s$/.test(relInsideQa) && allSpecs.includes(relInsideQa)) {
        addSpecReason(relInsideQa, `direct-spec-edit: ${relInsideQa}`);
        continue;
      }
      if (!options.canUseOnlyChanged) {
        return {
          mode: 'full',
          reason: `QA helper/config changed ("${file}") without valid git base ref — running full suite.`,
          specs: [],
          why: [{ spec: '*', via: `qa-helper: ${file}` }],
          recallEstimate: 1.0,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      continue;
    }

    allInsideQa = false;

    // 1. Direct match on changed file
    const direct = matchCandidateFileToSpecs(file, null);
    if (direct.forceFull) {
      return {
        mode: 'full',
        reason: `Impact rule for "${file}" requires full suite.`,
        specs: [],
        why: [{ spec: '*', via: `fullSuite-rule: ${file}` }],
        recallEstimate: 1.0,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }

    // 2. Transitive reverse import graph match (`I-01`: e.g. shared component -> multiple importing views -> specs!)
    let transitiveMatched = false;
    const dependents = findTransitiveDependents(file, reverseGraph);
    // High fan-in shared utility safety check (`I-04`): if >= 8 files depend on it, run full suite!
    if (dependents.length >= 8) {
      return {
        mode: 'full',
        reason: `High-fan-in module "${file}" is imported by ${dependents.length} files — running full suite.`,
        specs: [],
        why: [{ spec: '*', via: `high-fan-in(${dependents.length}): ${file}` }],
        recallEstimate: 1.0,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }

    for (const dep of dependents) {
      if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(dep.file))) {
        return {
          mode: 'full',
          reason: `Changed file "${file}" is imported by shared infrastructure "${dep.file}" — running full suite.`,
          specs: [],
          why: [{ spec: '*', via: `import-graph-infra: ${dep.chain.join(' -> ')}` }],
          recallEstimate: 1.0,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      const depMatch = matchCandidateFileToSpecs(dep.file, dep.chain.join(' -> '));
      if (depMatch.forceFull) {
        return {
          mode: 'full',
          reason: `Transitive dependent "${dep.file}" of "${file}" requires full suite.`,
          specs: [],
          why: [{ spec: '*', via: `import-graph: ${dep.chain.join(' -> ')}` }],
          recallEstimate: 1.0,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      if (depMatch.matchedAny) transitiveMatched = true;
    }

    // 3. Conservative fallback: any unmapped business file forces full regression!
    if (!direct.matchedAny && !transitiveMatched) {
      return {
        mode: 'full',
        reason: `Unmapped source file "${file}" has unknown blast radius — falling back to full regression suite.`,
        specs: [],
        why: [{ spec: '*', via: `unmapped-fallback: ${file}` }],
        recallEstimate: 1.0,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  // 4. Boost with recently failing specs from Run Ledger (`R2-2` historical failure weighting)
  const recentRuns = readLedgerHistory(qaDir, 5);
  for (const r of recentRuns) {
    for (const ft of r.failedTests || []) {
      const normFailFile = String(ft.file || '').startsWith('tests/') ? ft.file : `tests/${ft.file}`;
      if (allSpecs.includes(normFailFile) && whyBySpec.size > 0) {
        addSpecReason(normFailFile, `ledger-recent-failure: runId=${r.runId}`);
      }
    }
  }

  if (allInsideQa && whyBySpec.size === 0 && options.canUseOnlyChanged) {
    return {
      mode: 'only-changed',
      reason: 'Only internal QA files changed — delegating to Playwright --only-changed dependency graph.',
      specs: [],
      why: [{ spec: '--only-changed', via: 'playwright-ts-dependency-graph' }],
      recallEstimate: 0.99,
      useOnlyChanged: true,
      changedFiles: normalized,
    };
  }

  if (whyBySpec.size === 0) {
    return {
      mode: 'full',
      reason: 'Zero specific specs resolved from diff — falling back to full regression suite.',
      specs: [],
      why: [],
      recallEstimate: 1.0,
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  const sortedSpecs = [...whyBySpec.keys()].sort();
  const whyList = sortedSpecs.map((sp) => ({
    spec: sp,
    via: (whyBySpec.get(sp) || []).join('; '),
  }));

  return {
    mode: 'targeted',
    reason: `Mapped ${normalized.length} changed file(s) to ${sortedSpecs.length} targeted spec(s) (+ smoke).`,
    specs: sortedSpecs,
    totalSpecsCount: allSpecs.length,
    reductionRatio: Number((sortedSpecs.length / allSpecs.length).toFixed(4)),
    why: whyList,
    recallEstimate: 0.98,
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
      why: [],
      recallEstimate: 1.0,
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

  console.log(`\n=== ${lang === 'zh' ? 'Diff-Impact v2 受影响测试分析 (含依赖图)' : 'Diff-Impact v2 Test Selection (Import Graph)'} ===`);
  console.log(`Mode: ${impact.mode.toUpperCase()} (recallEst=${impact.recallEstimate ?? 1})`);
  console.log(`Reason: ${impact.reason}`);
  if (impact.changedFiles.length > 0) {
    console.log(`Changed Files (${impact.changedFiles.length}): ${impact.changedFiles.join(', ')}`);
  }
  if (impact.why && impact.why.length > 0 && impact.specs.length > 0) {
    console.log(`Selected Specs (${impact.specs.length}):`);
    for (const item of impact.why) console.log(`  - ${item.spec}  <- [${item.via}]`);
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
