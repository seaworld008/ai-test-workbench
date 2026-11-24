// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { compileGlob } from './core/glob.mjs';
import { runProcess } from './core/proc.mjs';
import { readLedgerHistory } from './ledger.mjs';
import { resolveGitRoot } from './kernel/gate-kernel.mjs';

const GLOBAL_INFRA_PATTERNS = [
  /(^|\/)package\.json$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$/i,
  /(^|\/)playwright\.config\.[jt]s$/i,
  /(^|\/)eslint\.config\.[mc]?[jt]s$/i,
  /(^|\/)aitest\.config\.json$/i,
  /(^|\/)impact-map\.json$/i,
  /(^|\/)waivers\.json$/i,
  /(^|\/)tsconfig\.json$/i,
  /(^|\/)support\//i,
  /(^|\/)tests\/fixtures\//i,
  /(^|\/)[^/]+\.setup\.[jt]s$/i,
  /(^|\/)(?:src\/)?(router|interceptor|interceptors|middleware|store|auth|permission|gateway)(\/|\.(?:[jt]sx?|mjs|vue)$)/i,
];

const GRAPH_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '/index.ts', '/index.tsx', '/index.js', '/index.vue'];
const GRAPH_IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'reports', 'playwright-report', 'test-results', '.aitest']);
const MAX_GRAPH_FILES = 3000;

function isOverbroadCatchAllGlob(pattern) {
  const clean = String(pattern || '').trim().replace(/^\.\//, '');
  return clean === '**' || clean === '*' || clean === '**/*' || clean === 'src/**' || clean === 'src/**/*';
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
        /\.(?:spec|test)\.[jt]s$/.test(entry.name) &&
        path.relative(testsDir, full).replace(/\\/g, '/') !== 'seed.spec.ts' &&
        !entry.name.endsWith('.official.example.ts')
      ) {
        results.push(path.relative(qaDir, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(testsDir);
  return results.sort();
}

function loadTsConfigPathAliases(repoDir) {
  /** @type {Array<{ prefix: string, targetPrefix: string }>} */
  const aliases = [];
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = path.join(repoDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const stripped = fs
        .readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      const parsed = JSON.parse(stripped);
      const baseUrl = parsed?.compilerOptions?.baseUrl ? path.resolve(repoDir, parsed.compilerOptions.baseUrl) : repoDir;
      const pathsObj = parsed?.compilerOptions?.paths || {};
      for (const [key, targets] of Object.entries(pathsObj)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const prefix = key.endsWith('*') ? key.slice(0, -1) : key;
        const t0 = String(targets[0] || '');
        const tPrefix = t0.endsWith('*') ? t0.slice(0, -1) : t0;
        aliases.push({ prefix, targetPrefix: path.resolve(baseUrl, tPrefix) });
      }
    } catch {
      // ignore non-standard tsconfig
    }
  }
  return aliases;
}

function resolveRepoImport(fromFileAbs, specifier, repoDir, pathAliases = []) {
  let baseAbs = null;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    baseAbs = path.resolve(path.dirname(fromFileAbs), specifier);
  } else if (specifier.startsWith('@/') || specifier.startsWith('~/')) {
    const sub = specifier.slice(2);
    baseAbs = fs.existsSync(path.join(repoDir, 'src')) ? path.join(repoDir, 'src', sub) : path.join(repoDir, sub);
  } else {
    for (const al of pathAliases) {
      if (al.prefix && specifier.startsWith(al.prefix)) {
        baseAbs = path.resolve(al.targetPrefix, specifier.slice(al.prefix.length));
        break;
      }
    }
  }
  if (!baseAbs) return null;

  for (const ext of GRAPH_EXTS) {
    const candidate = `${baseAbs}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return path.relative(repoDir, candidate).replace(/\\/g, '/');
    }
  }
  return null;
}

/**
 * Builds a static reverse import graph (`targetRel -> Set<importerRel>`) across TS/JS/Vue files
 * including `import`, `export ... from`, dynamic `import()`, `require()`, `~/`, `@/`, and `tsconfig.json` `paths` (`I-04`).
 * Also flags `reverse.truncated = true` if file limit was reached so callers fail-closed to full suite!
 * @param {string} repoDir
 * @param {{ includeQa?: boolean }} [options]
 */
export function buildReverseImportGraph(repoDir, options = {}) {
  /** @type {Map<string, Set<string>> & { truncated?: boolean }} */
  const reverse = new Map();
  reverse.truncated = false;
  if (!repoDir || !fs.existsSync(repoDir)) return reverse;

  const pathAliases = loadTsConfigPathAliases(repoDir);
  let scanned = 0;
  const importRe =
    /(?:import\s+(?:[\s\S]*?\s+from\s+)?['"`]([^'"`]+)['"`]|export\s+[\s\S]*?\s+from\s+['"`]([^'"`]+)['"`]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

  const walk = (dir) => {
    if (scanned >= MAX_GRAPH_FILES) {
      reverse.truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (scanned >= MAX_GRAPH_FILES) {
        reverse.truncated = true;
        break;
      }
      if (GRAPH_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      if (!options.includeQa && entry.name === 'qa') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && /\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(entry.name)) {
        let stat;
        try {
          stat = fs.statSync(full);
        } catch {
          continue;
        }
        if (stat.size > 512 * 1024) continue;
        scanned += 1;
        const fromRel = path.relative(repoDir, full).replace(/\\/g, '/');
        const text = fs.readFileSync(full, 'utf8');
        for (const m of text.matchAll(importRe)) {
          const spec = m[1] || m[2] || m[3] || m[4];
          if (!spec) continue;
          const targetRel = resolveRepoImport(full, spec, repoDir, pathAliases);
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
 * Segment-aligned stem match (`I-03`): prevents `src/lib/user.ts` from weakly matching `user-profile.spec.ts`
 * via arbitrary substring while allowing exact segment/basename match (`courses.spec.ts` <-> `courses`).
 */
function specMatchesStemExactSegment(specRel, stem) {
  const baseNoExt = path
    .basename(specRel)
    .replace(/\.(?:spec|test)\.[jt]s$/i, '')
    .toLowerCase();
  const dirSegments = specRel
    .toLowerCase()
    .split('/')
    .slice(0, -1);
  if (baseNoExt === stem || dirSegments.includes(stem)) return true;
  const tokens = baseNoExt.split(/[-_.]+/).filter(Boolean);
  return tokens.length === 1 && tokens[0] === stem;
}

/**
 * Hardened Impact v2 selector (`I-01..I-04`):
 * - Any edit to `impact-map.json` or catch-all wildcard (`**`) without `fullSuite: true` forces `full`.
 * - Any Page Object / helper change inside `qa/` traces QA reverse imports or falls back to `only-changed`/`full`
 *   (never silently dropped when edited alongside a spec!).
 * - Every transitive dependent of a changed source file must map cleanly, else forces `full`!
 * - Graph truncation forces `full` with explicit warning.
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
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: [],
    };
  }

  for (const file of normalized) {
    if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(file))) {
      return {
        mode: 'full',
        reason: `Shared/infrastructure or policy file changed ("${file}") — running full regression suite.`,
        specs: [],
        why: [{ spec: '*', via: `infra-guard: ${file}` }],
        recallEstimate: null,
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
      recallEstimate: null,
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
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  // Reject overbroad catch-all rules (`**`, `*`) that aren't `fullSuite: true` (`I-01` anti-manipulation!)
  for (const r of rules) {
    const rawPatterns = (Array.isArray(r.match) ? r.match : [r.source || r.match]).filter(Boolean);
    if (!r.fullSuite && rawPatterns.some(isOverbroadCatchAllGlob)) {
      return {
        mode: 'full',
        reason: `Overbroad wildcard rule (${rawPatterns.join(', ')}) in impact-map.json without fullSuite:true rejected — falling back to full suite.`,
        specs: [],
        why: [{ spec: '*', via: `overbroad-impact-rule-blocked: ${rawPatterns.join(', ')}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  const compiledRules = rules.map((r) => ({
    rawMatch: Array.isArray(r.match) ? r.match.join(', ') : String(r.source || r.match || ''),
    patterns: (Array.isArray(r.match) ? r.match : [r.source || r.match]).filter(Boolean).map(compileGlob),
    specs: Array.isArray(r.specs) ? r.specs : [],
    fullSuite: Boolean(r.fullSuite),
  }));

  const reverseGraph = buildReverseImportGraph(repoDir, { includeQa: false });
  if (reverseGraph.truncated) {
    return {
      mode: 'full',
      reason: `Import graph exceeded ${MAX_GRAPH_FILES}-file scan budget (truncated) — falling back to full suite for recall safety.`,
      specs: [],
      why: [{ spec: '*', via: `graph-truncated(${MAX_GRAPH_FILES})` }],
      recallEstimate: null,
      useOnlyChanged: false,
      changedFiles: normalized,
    };
  }

  /** @type {Map<string, string[]>} */
  const whyBySpec = new Map();
  const addSpecReason = (specRel, reasonStr) => {
    const arr = whyBySpec.get(specRel) || [];
    if (!arr.includes(reasonStr)) arr.push(reasonStr);
    whyBySpec.set(specRel, arr);
  };

  let allInsideQa = true;
  let qaNonSpecFiles = [];

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
          if (specMatchesStemExactSegment(sp, stem)) {
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
      if (/^tests\/.*\.(?:spec|test)\.[jt]s$/.test(relInsideQa) && allSpecs.includes(relInsideQa)) {
        addSpecReason(relInsideQa, `direct-spec-edit: ${relInsideQa}`);
        continue;
      }
      qaNonSpecFiles.push(relInsideQa);
      continue;
    }

    allInsideQa = false;

    const direct = matchCandidateFileToSpecs(file, null);
    if (direct.forceFull) {
      return {
        mode: 'full',
        reason: `Impact rule for "${file}" requires full suite.`,
        specs: [],
        why: [{ spec: '*', via: `fullSuite-rule: ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }

    const dependents = findTransitiveDependents(file, reverseGraph);
    if (dependents.length >= 8) {
      return {
        mode: 'full',
        reason: `High-fan-in module "${file}" is imported by ${dependents.length} files — running full suite.`,
        specs: [],
        why: [{ spec: '*', via: `high-fan-in(${dependents.length}): ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }

    let transitiveMatched = false;
    for (const dep of dependents) {
      if (GLOBAL_INFRA_PATTERNS.some((re) => re.test(dep.file))) {
        return {
          mode: 'full',
          reason: `Changed file "${file}" is imported by shared infrastructure "${dep.file}" — running full suite.`,
          specs: [],
          why: [{ spec: '*', via: `import-graph-infra: ${dep.chain.join(' -> ')}` }],
          recallEstimate: null,
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
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      if (depMatch.matchedAny) {
        transitiveMatched = true;
      } else {
        // Every transitive dependent MUST map cleanly; any unmapped dependent forces full suite (`I-03`)!
        return {
          mode: 'full',
          reason: `Transitive dependent "${dep.file}" of "${file}" is unmapped — falling back to full suite to prevent missed regressions.`,
          specs: [],
          why: [{ spec: '*', via: `unmapped-transitive: ${dep.chain.join(' -> ')}` }],
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
    }

    if (!direct.matchedAny && !transitiveMatched) {
      return {
        mode: 'full',
        reason: `Unmapped source file "${file}" has unknown blast radius — falling back to full regression suite.`,
        specs: [],
        why: [{ spec: '*', via: `unmapped-fallback: ${file}` }],
        recallEstimate: null,
        useOnlyChanged: false,
        changedFiles: normalized,
      };
    }
  }

  // Handle Page Object / helper edits inside `qa/` (`I-02`) — NEVER drop their dependent specs!
  if (qaNonSpecFiles.length > 0) {
    if (allInsideQa && whyBySpec.size === 0 && options.canUseOnlyChanged) {
      return {
        mode: 'only-changed',
        reason: 'Only internal QA helper files changed — delegating to Playwright --only-changed dependency graph.',
        specs: [],
        why: [{ spec: '--only-changed', via: 'playwright-ts-dependency-graph' }],
        recallEstimate: null,
        useOnlyChanged: true,
        changedFiles: normalized,
      };
    }

    // Trace reverse imports inside `qaDir` for modified Page Objects / helpers!
    const qaGraph = buildReverseImportGraph(qaDir, { includeQa: true });
    for (const qaRel of qaNonSpecFiles) {
      const qaDeps = findTransitiveDependents(qaRel, qaGraph);
      const depSpecs = qaDeps.filter((d) => allSpecs.includes(d.file));
      if (depSpecs.length === 0) {
        return {
          mode: 'full',
          reason: `QA helper/Page Object changed ("${qaRel}") with unresolved spec dependents — running full suite.`,
          specs: [],
          why: [{ spec: '*', via: `qa-helper-fallback: ${qaRel}` }],
          recallEstimate: null,
          useOnlyChanged: false,
          changedFiles: normalized,
        };
      }
      for (const ds of depSpecs) {
        addSpecReason(ds.file, `qa-import-graph: ${ds.chain.join(' -> ')}`);
      }
    }
  }

  // Boost with recently failing specs from Run Ledger
  const recentRuns = readLedgerHistory(qaDir, 5);
  for (const r of recentRuns) {
    for (const ft of r.failedTests || []) {
      const normFailFile = String(ft.file || '').startsWith('tests/') ? ft.file : `tests/${ft.file}`;
      if (allSpecs.includes(normFailFile) && whyBySpec.size > 0) {
        addSpecReason(normFailFile, `ledger-recent-failure: runId=${r.runId}`);
      }
    }
  }

  if (whyBySpec.size === 0) {
    return {
      mode: 'full',
      reason: 'Zero specific specs resolved from diff — falling back to full regression suite.',
      specs: [],
      why: [],
      recallEstimate: null,
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
    recallEstimate: null,
    useOnlyChanged: false,
    changedFiles: normalized,
  };
}

/**
 * Collects changed & untracked files via `git -c core.quotePath=off ... -z` (handles Chinese/Unicode paths & monorepo subdirs, `G-07`).
 */
export async function collectGitChangedFiles(repoDir, baseRef = 'HEAD~1') {
  const gitRoot = resolveGitRoot(repoDir);
  if (!gitRoot) {
    return { ok: false, reason: 'Target is not a git repository.', files: [], validBaseRef: false };
  }

  const files = new Set();
  const addNulOutput = (stdout) => {
    for (const raw of String(stdout || '').split('\0')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      // Convert git-root relative path to repoDir relative path for monorepo subpackages
      const abs = path.join(gitRoot, trimmed);
      const rel = path.relative(repoDir, abs).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..')) {
        files.add(rel);
      }
    }
  };

  let validBaseRef = false;
  if (baseRef) {
    const verifyRes = await runProcess('git', ['-c', 'core.quotePath=off', 'rev-parse', '--verify', baseRef], {
      cwd: gitRoot,
      timeoutMs: 5000,
    });
    if (verifyRes.code === 0) {
      validBaseRef = true;
      const branchDiff = await runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z', `${baseRef}...HEAD`], {
        cwd: gitRoot,
        timeoutMs: 8000,
      });
      if (branchDiff.code === 0) addNulOutput(branchDiff.stdout);
    }
  }

  const headCheck = await runProcess('git', ['-c', 'core.quotePath=off', 'rev-parse', '--verify', 'HEAD'], {
    cwd: gitRoot,
    timeoutMs: 5000,
  });
  const wtDiff =
    headCheck.code === 0
      ? await runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z', 'HEAD'], { cwd: gitRoot, timeoutMs: 8000 })
      : await runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z'], { cwd: gitRoot, timeoutMs: 8000 });
  if (wtDiff.code === 0) addNulOutput(wtDiff.stdout);

  const untracked = await runProcess('git', ['-c', 'core.quotePath=off', 'ls-files', '--others', '--exclude-standard', '-z'], {
    cwd: gitRoot,
    timeoutMs: 8000,
  });
  if (untracked.code === 0) addNulOutput(untracked.stdout);

  if (!validBaseRef && files.size === 0) {
    return {
      ok: false,
      reason: `Cannot resolve base ref "${baseRef}" (e.g. shallow clone or initial commit) and working tree is clean.`,
      files: [],
      validBaseRef: false,
    };
  }

  return { ok: true, reason: null, files: [...files].sort(), validBaseRef };
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
      recallEstimate: null,
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
  console.log(`Mode: ${impact.mode.toUpperCase()}`);
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
