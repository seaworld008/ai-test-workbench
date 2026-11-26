// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { compileGlob } from '../core/glob.mjs';
import { runProcess } from '../core/proc.mjs';
import { canonicalFsPath, resolveGitRoot } from '../kernel/gate-kernel.mjs';
import { addJavaAndXmlReverseEdges, isIgnoredWorkbenchArtifactPath } from './java-support.mjs';
import {
  DEFAULT_PER_REPO_GRAPH_FILES,
  MAX_GRAPH_FILES,
  buildRepoSourceIndex,
  resolveRepoImportFromIndex,
  stripJsCommentsPreserveStrings,
} from './scanner.mjs';

export { MAX_GRAPH_FILES, stripJsCommentsPreserveStrings };

export const GLOBAL_INFRA_PATTERNS = [
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
  /(^|\/)(?:styles?|themes?|i18n|locales)\//i,
  /(^|\/)(?:global|globals|app|index|main|theme|tokens)\.(?:css|scss|less|json)$/i,
  /(^|\/)tailwind\.config\.[mc]?[jt]s$/i,
  /(^|\/)(?:src\/)?(router|interceptor|interceptors|middleware|store|auth|permission|gateway)(\/|\.(?:[jt]sx?|mjs|vue)$)/i,
];

const ROUTER_FILE_RE = /(?:^|\/)(?:[a-z0-9_-]*-)?(?:router|routes)(?:\/|\.|-[a-z])/i;

/** @param {string} pattern @returns {boolean} */
export function isOverbroadCatchAllGlob(pattern) {
  const clean = String(pattern || '').trim().replace(/^\.\//, '');
  return clean === '**' || clean === '*' || clean === '**/*' || clean === 'src/**' || clean === 'src/**/*';
}

/**
 * @param {string} testsDir
 * @param {string} qaDir
 * @returns {string[]}
 */
export function listAllSpecFiles(testsDir, qaDir) {
  /** @type {string[]} */
  const results = [];
  if (!fs.existsSync(testsDir)) return results;
  const walk = (/** @type {string} */ dir) => {
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

/** @param {string} repoDir */
function loadTsConfigPathAliases(repoDir) {
  /** @type {Array<{ prefix: string, targetRelPrefix: string }>} */
  const aliases = [];
  const realRepoDir = canonicalFsPath(repoDir);
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    const p = path.join(realRepoDir, name);
    if (!fs.existsSync(p)) continue;
    try {
      const stripped = stripJsCommentsPreserveStrings(fs.readFileSync(p, 'utf8'));
      const parsed = JSON.parse(stripped);
      const baseUrl = parsed?.compilerOptions?.baseUrl
        ? path.resolve(realRepoDir, parsed.compilerOptions.baseUrl)
        : realRepoDir;
      const pathsObj = parsed?.compilerOptions?.paths || {};
      for (const [key, targets] of Object.entries(pathsObj)) {
        if (!Array.isArray(targets) || targets.length === 0) continue;
        const prefix = key.endsWith('*') ? key.slice(0, -1) : key;
        const t0 = String(targets[0] || '');
        const tPrefix = t0.endsWith('*') ? t0.slice(0, -1) : t0;
        const absTarget = canonicalFsPath(path.resolve(baseUrl, tPrefix));
        const targetRelPrefix = path.relative(realRepoDir, absTarget).replace(/\\/g, '/').replace(/\/+$/, '');
        if (!targetRelPrefix.startsWith('..')) aliases.push({ prefix, targetRelPrefix });
      }
    } catch {
      // ignore non-standard tsconfig
    }
  }
  return aliases;
}

/**
 * Indexes a single repository into `reverse` + `routeRegistrationEdges` (without router hub reverse explosion).
 * @param {string} repoDir
 * @param {Map<string, Set<string>>} reverse
 * @param {Map<string, Set<string>>} routeRegEdges
 * @param {{ includeQa?: boolean, maxFiles?: number, prefix?: string }} options
 */
function populateRepoIntoReverseGraph(repoDir, reverse, routeRegEdges, options) {
  const pathAliases = loadTsConfigPathAliases(repoDir);
  const index = buildRepoSourceIndex(repoDir, {
    includeQa: Boolean(options.includeQa),
    maxFiles: options.maxFiles ?? DEFAULT_PER_REPO_GRAPH_FILES,
  });

  /** @type {Map<string, Set<string>>} */
  const localReverse = new Map();
  const importRe =
    /(?:import\s+(?:[^'"`;]{0,200}\s+from\s+)?['"`]([^'"`]+)['"`]|export\s+[^'"`;]{0,200}\s+from\s+['"`]([^'"`]+)['"`]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

  for (const { full, rel: fromRel } of index.files) {
    if (fromRel.endsWith('.java') || fromRel.endsWith('.xml')) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 512 * 1024) continue;
    const rawText = fs.readFileSync(full, 'utf8');
    let jsSource = rawText;
    if (fromRel.endsWith('.vue')) {
      const blocks = [...rawText.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
      jsSource = blocks.length > 0 ? blocks.join('\n') : rawText;
    }
    const text = stripJsCommentsPreserveStrings(jsSource);
    const isRouterFile = ROUTER_FILE_RE.test(fromRel);

    for (const m of text.matchAll(importRe)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec) continue;
      const isLazyRouterImport = isRouterFile && Boolean(m[3]);
      const targetRel = resolveRepoImportFromIndex(fromRel, spec, pathAliases, index);
      if (!targetRel || targetRel === fromRel) continue;
      const bucket = isLazyRouterImport ? routeRegEdges : localReverse;
      const pTarget = options.prefix ? `${options.prefix}/${targetRel}` : targetRel;
      const pFrom = options.prefix ? `${options.prefix}/${fromRel}` : fromRel;
      let importers = bucket.get(pTarget);
      if (!importers) { importers = new Set(); bucket.set(pTarget, importers); }
      importers.add(pFrom);
    }
  }

  for (const [k, set] of localReverse.entries()) {
    let dest = reverse.get(k);
    if (!dest) { dest = new Set(); reverse.set(k, dest); }
    for (const v of set) dest.add(v);
  }

  /** @type {Map<string, Set<string>>} */
  const javaReverse = new Map();
  addJavaAndXmlReverseEdges(index.files, javaReverse, stripJsCommentsPreserveStrings);
  for (const [k, set] of javaReverse.entries()) {
    const pk = options.prefix ? `${options.prefix}/${k}` : k;
    let dest = reverse.get(pk);
    if (!dest) { dest = new Set(); reverse.set(pk, dest); }
    for (const v of set) dest.add(options.prefix ? `${options.prefix}/${v}` : v);
  }

  return index.truncated;
}

/**
 * Builds a static reverse import graph (`targetRel -> Set<importerRel>`) across TS/JS/Vue/Java/XML files.
 * Prevents router hub explosion by separating lazy `import(...)` route registrations into `routeRegistrationEdges`.
 * @param {string} repoDir
 * @param {{ includeQa?: boolean, maxFiles?: number, repos?: string[] }} [options]
 */
export function buildReverseImportGraph(repoDir, options = {}) {
  /** @type {Map<string, Set<string>> & { truncated?: boolean, routeRegistrationEdges?: Map<string, Set<string>> }} */
  const reverse = new Map();
  /** @type {Map<string, Set<string>>} */
  const routeRegEdges = new Map();
  reverse.truncated = false;
  reverse.routeRegistrationEdges = routeRegEdges;

  const repos = Array.isArray(options.repos) && options.repos.length > 0 ? options.repos : repoDir ? [repoDir] : [];
  const validRepos = [...new Set(repos.filter((r) => r && fs.existsSync(r)).map((r) => path.resolve(r)))];
  if (validRepos.length === 0) return reverse;

  const multi = validRepos.length > 1;
  const usedLabels = new Set();
  for (const root of validRepos) {
    let prefix = '';
    if (multi) {
      const base = path.basename(root) || 'repo';
      prefix = base;
      let idx = 2;
      while (usedLabels.has(prefix)) { prefix = `${base}-${idx}`; idx += 1; }
      usedLabels.add(prefix);
    }
    const truncated = populateRepoIntoReverseGraph(root, reverse, routeRegEdges, {
      includeQa: options.includeQa,
      maxFiles: options.maxFiles,
      prefix,
    });
    if (truncated) reverse.truncated = true;
  }

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
  if (uniqueFailed.length === 0) return { totalFailures: 0, coveredFailures: 0, missedSpecs: [], recall: 1 };
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

/** @param {string} specRel @param {string} stem @returns {boolean} */
export function specMatchesStemExactSegment(specRel, stem) {
  const baseNoExt = path.basename(specRel).replace(/\.(?:spec|test)\.[jt]s$/i, '').toLowerCase();
  const dirSegments = specRel.toLowerCase().split('/').slice(0, -1);
  if (baseNoExt === stem || dirSegments.includes(stem)) return true;
  const tokens = baseNoExt.split(/[-_.]+/).filter(Boolean);
  return tokens.length === 1 && tokens[0] === stem;
}

/**
 * Loads and validates rules from an impact JSON file.
 * @param {string} filePath
 */
export function loadAndValidateImpactRules(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: true, rules: /** @type {Array<{ rawMatch: string, patterns: RegExp[], specs: string[], fullSuite: boolean }>} */ ([]), errorReason: null };
  }
  /** @type {Array<{ match?: string | string[], source?: string, specs?: string[], fullSuite?: boolean }>} */
  let rawRules = [];
  try {
    const rawMap = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    rawRules = Array.isArray(rawMap.rules) ? rawMap.rules : [];
  } catch {
    return { ok: false, rules: [], errorReason: `Invalid JSON in ${path.basename(filePath)} — falling back to full suite.` };
  }
  for (const r of rawRules) {
    const rawPatterns = /** @type {string[]} */ ((Array.isArray(r.match) ? r.match : [r.source || r.match]).filter(Boolean));
    if (!r.fullSuite && rawPatterns.some(isOverbroadCatchAllGlob)) {
      return {
        ok: false,
        rules: [],
        errorReason: `Overbroad wildcard rule (${rawPatterns.join(', ')}) in ${path.basename(filePath)} without fullSuite:true rejected — falling back to full suite.`,
        via: `overbroad-impact-rule-blocked: ${rawPatterns.join(', ')}`,
      };
    }
  }
  return {
    ok: true,
    errorReason: null,
    rules: rawRules.map((r) => ({
      rawMatch: Array.isArray(r.match) ? r.match.join(', ') : String(r.source || r.match || ''),
      patterns: /** @type {string[]} */ ((Array.isArray(r.match) ? r.match : [r.source || r.match]).filter(Boolean)).map(compileGlob),
      specs: Array.isArray(r.specs) ? r.specs : [],
      fullSuite: Boolean(r.fullSuite),
    })),
  };
}

/**
 * Collects changed & untracked files via `git -c core.quotePath=off ... -z`, filtering workbench state & report artifacts.
 * @param {string} repoDir
 * @param {string} [baseRef]
 * @param {{ qaRelPrefix?: string }} [options]
 */
export async function collectGitChangedFiles(repoDir, baseRef = 'HEAD~1', options = {}) {
  const gitRoot = resolveGitRoot(repoDir);
  if (!gitRoot) {
    return { ok: false, reason: 'Target is not a git repository.', files: /** @type {string[]} */ ([]), validBaseRef: false };
  }
  const realRepoDir = canonicalFsPath(repoDir);
  /** @type {Set<string>} */
  const files = new Set();
  const addNulOutput = (/** @type {string} */ stdout) => {
    for (const raw of String(stdout || '').split('\0')) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const abs = path.join(gitRoot, trimmed);
      const rel = path.relative(realRepoDir, abs).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..') && !isIgnoredWorkbenchArtifactPath(rel, options.qaRelPrefix || '')) {
        files.add(rel);
      }
    }
  };

  const [verifyRes, branchDiff, headCheck, wtDiffHead, untracked] = await Promise.all([
    baseRef ? runProcess('git', ['-c', 'core.quotePath=off', 'rev-parse', '--verify', baseRef], { cwd: gitRoot, timeoutMs: 5000 }) : Promise.resolve(null),
    baseRef ? runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z', `${baseRef}...HEAD`], { cwd: gitRoot, timeoutMs: 8000 }) : Promise.resolve(null),
    runProcess('git', ['-c', 'core.quotePath=off', 'rev-parse', '--verify', 'HEAD'], { cwd: gitRoot, timeoutMs: 5000 }),
    runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z', 'HEAD'], { cwd: gitRoot, timeoutMs: 8000 }),
    runProcess('git', ['-c', 'core.quotePath=off', 'ls-files', '--others', '--exclude-standard', '-z'], { cwd: gitRoot, timeoutMs: 8000 }),
  ]);

  const validBaseRef = Boolean(verifyRes && verifyRes.code === 0);
  if (validBaseRef && branchDiff && branchDiff.code === 0) addNulOutput(branchDiff.stdout);
  if (headCheck.code === 0) {
    if (wtDiffHead.code === 0) addNulOutput(wtDiffHead.stdout);
  } else {
    const wtDiff = await runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z'], { cwd: gitRoot, timeoutMs: 8000 });
    if (wtDiff.code === 0) addNulOutput(wtDiff.stdout);
  }
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

/**
 * Collects git diffs across multiple repositories, prefixing paths with `<repoBasename>/` when `repos.length > 1`.
 * @param {string[]} repos
 * @param {string} [baseRef]
 * @param {{ qaRelPrefix?: string }} [options]
 */
export async function collectMultiRepoGitChangedFiles(repos, baseRef = 'HEAD~1', options = {}) {
  if (repos.length <= 1) return collectGitChangedFiles(repos[0], baseRef, options);
  const results = await Promise.all(repos.map((r) => collectGitChangedFiles(r, baseRef, options)));
  if (results.some((r) => !r.ok)) {
    const firstErr = results.find((r) => !r.ok);
    return { ok: false, reason: firstErr?.reason || 'One or more source repos are not git repositories.', files: [], validBaseRef: false };
  }
  const usedLabels = new Set();
  /** @type {string[]} */
  const merged = [];
  repos.forEach((root, idx) => {
    const base = path.basename(root) || 'repo';
    let label = base;
    let n = 2;
    while (usedLabels.has(label)) { label = `${base}-${n}`; n += 1; }
    usedLabels.add(label);
    for (const f of results[idx].files) merged.push(`${label}/${f}`);
  });
  return {
    ok: true,
    reason: null,
    files: [...new Set(merged)].sort(),
    validBaseRef: results.every((r) => r.validBaseRef),
  };
}

/** @param {string} qaDir @param {string} repoDir @param {string[]} allSpecs */
export function buildReqIdToSpecMap(qaDir, repoDir, allSpecs) {
  /** @type {Map<string, Set<string>>} */
  const reqToSpecs = new Map();
  const reqRe = /\bREQ-[A-Za-z0-9_-]+\b/g;
  for (const spRel of allSpecs) {
    const abs = path.join(qaDir, spRel);
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    for (const m of text.matchAll(reqRe)) {
      const id = m[0].toUpperCase();
      let set = reqToSpecs.get(id);
      if (!set) { set = new Set(); reqToSpecs.set(id, set); }
      set.add(spRel);
    }
  }
  return reqToSpecs;
}

/** @param {string} absFilePath @returns {string[]} */
export function extractReqIdsFromFile(absFilePath) {
  if (!fs.existsSync(absFilePath)) return [];
  try {
    const text = fs.readFileSync(absFilePath, 'utf8');
    return [...new Set([...text.matchAll(/\bREQ-[A-Za-z0-9_-]+\b/g)].map((m) => m[0].toUpperCase()))];
  } catch {
    return [];
  }
}
