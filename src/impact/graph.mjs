// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../core/proc.mjs';
import { canonicalFsPath, resolveGitRoot } from '../kernel/gate-kernel.mjs';
import { addJavaAndXmlReverseEdges, isIgnoredWorkbenchArtifactPath } from './java-support.mjs';
import {
  DEFAULT_PER_REPO_GRAPH_FILES,
  MAX_GRAPH_FILES,
  buildRepoSourceIndex,
  extractPythonImportTargets,
  resolveRepoImportFromIndex,
  stripJsCommentsPreserveStrings,
  stripPythonComments,
} from './scanner.mjs';

export { MAX_GRAPH_FILES, stripJsCommentsPreserveStrings, stripPythonComments };

export const GLOBAL_INFRA_PATTERNS = [
  /(^|\/)package\.json$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/i,
  /(^|\/)(pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$/i,
  /(^|\/)(pyproject\.toml|requirements\.txt|Cargo\.(toml|lock)|go\.(mod|sum))$/i,
  /(^|\/)playwright\.config\.[jt]s$/i,
  /(^|\/)eslint\.config\.[mc]?[jt]s$/i,
  /(^|\/)aitest\.config\.json$/i,
  /(^|\/)impact-map\.json$/i,
  /(^|\/)waivers\.json$/i,
  /(^|\/)tsconfig\.json$/i,
  /(^|\/)support\//i,
  /^(?:qa\/)?tests\/fixtures\//i,
  /(^|\/)[^/]+\.setup\.[jt]s$/i,
  /(^|\/)(?:styles?|themes?|i18n|locales)\//i,
  /(^|\/)(?:global|globals|app|index|main|theme|tokens)\.(?:css|scss|less|json)$/i,
  /(^|\/)tailwind\.config\.[mc]?[jt]s$/i,
  /(^|\/)(?:src\/)?(router|interceptor|interceptors|middleware|store|auth|permission|gateway)(\/|\.(?:[jt]sx?|mjs|vue)$)/i,
];

const ROUTER_FILE_RE = /(?:^|\/)(?:[a-z0-9_-]*-)?(?:router|routes)(?:\/|\.|-[a-z])/i;

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
  const pyRelFiles = index.files.filter((f) => f.rel.endsWith('.py')).map((f) => f.rel);

  /** @type {Map<string, Set<string>>} */
  const localReverse = new Map();
  const addEdge = (/** @type {Map<string, Set<string>>} */ bucket, /** @type {string} */ targetRel, /** @type {string} */ fromRel) => {
    const pTarget = options.prefix ? `${options.prefix}/${targetRel}` : targetRel;
    const pFrom = options.prefix ? `${options.prefix}/${fromRel}` : fromRel;
    let importers = bucket.get(pTarget);
    if (!importers) { importers = new Set(); bucket.set(pTarget, importers); }
    importers.add(pFrom);
  };
  const importRe =
    /(?:import\s+(?:[^'"`;]{0,200}\s+from\s+)?['"`]([^'"`]+)['"`]|export\s+[^'"`;]{0,200}\s+from\s+['"`]([^'"`]+)['"`]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

  for (const { full, rel: fromRel } of index.files) {
    if (fromRel.endsWith('.java') || fromRel.endsWith('.xml')) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 512 * 1024) continue;
    const rawText = fs.readFileSync(full, 'utf8');
    if (fromRel.endsWith('.py')) {
      for (const targetRel of extractPythonImportTargets(fromRel, rawText, index, pyRelFiles)) {
        addEdge(localReverse, targetRel, fromRel);
      }
      continue;
    }
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
      addEdge(isLazyRouterImport ? routeRegEdges : localReverse, targetRel, fromRel);
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

  for (const { root, label } of assignRepoLabels(validRepos)) {
    const truncated = populateRepoIntoReverseGraph(root, reverse, routeRegEdges, {
      includeQa: options.includeQa,
      maxFiles: options.maxFiles,
      prefix: label,
    });
    if (truncated) reverse.truncated = true;
  }

  return reverse;
}

/** @param {string[]} repos */
function assignRepoLabels(repos) {
  const multi = repos.length > 1;
  const used = new Set();
  return repos.map((root) => {
    const resolved = path.resolve(root);
    if (!multi) return { root: resolved, realRoot: canonicalFsPath(resolved), label: '' };
    const base = path.basename(resolved) || 'repo';
    let label = base;
    for (let n = 2; used.has(label); n += 1) label = `${base}-${n}`;
    used.add(label);
    return { root: resolved, realRoot: canonicalFsPath(resolved), label };
  });
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
 * Queries changed & untracked paths relative to `gitRoot` once via `git -c core.quotePath=off ... -z`.
 * @param {string} gitRoot
 * @param {string} [baseRef]
 * @returns {Promise<{ ok: boolean, reason: string | null, rawFiles: string[], validBaseRef: boolean }>}
 */
async function queryGitRootChangedPaths(gitRoot, baseRef = 'HEAD~1') {
  /** @type {Set<string>} */
  const rawFiles = new Set();
  const collectNul = (/** @type {string} */ stdout) => {
    for (const raw of String(stdout || '').split('\0')) {
      const trimmed = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      if (trimmed) rawFiles.add(trimmed);
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
  if (validBaseRef && branchDiff && branchDiff.code === 0) collectNul(branchDiff.stdout);
  if (headCheck.code === 0) {
    if (wtDiffHead.code === 0) collectNul(wtDiffHead.stdout);
  } else {
    const wtDiff = await runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z'], { cwd: gitRoot, timeoutMs: 8000 });
    if (wtDiff.code === 0) collectNul(wtDiff.stdout);
  }
  if (untracked.code === 0) collectNul(untracked.stdout);

  if (!validBaseRef && rawFiles.size === 0) {
    return {
      ok: false,
      reason: `Cannot resolve base ref "${baseRef}" (e.g. shallow clone or initial commit) and working tree is clean.`,
      rawFiles: [],
      validBaseRef: false,
    };
  }
  return { ok: true, reason: null, rawFiles: [...rawFiles], validBaseRef };
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
  const queried = await queryGitRootChangedPaths(gitRoot, baseRef);
  if (!queried.ok) {
    return { ok: false, reason: queried.reason, files: [], validBaseRef: false };
  }
  const realRepoDir = canonicalFsPath(repoDir);
  /** @type {Set<string>} */
  const files = new Set();
  for (const trimmed of queried.rawFiles) {
    const abs = path.join(gitRoot, trimmed);
    const rel = path.relative(realRepoDir, abs).replace(/\\/g, '/');
    if (rel && !rel.startsWith('..') && !isIgnoredWorkbenchArtifactPath(rel, options.qaRelPrefix || '')) {
      files.add(rel);
    }
  }
  return { ok: true, reason: null, files: [...files].sort(), validBaseRef: queried.validBaseRef };
}

/**
 * Collects git diffs across multiple repositories, prefixing paths with `<repoBasename>/` when `repos.length > 1`.
 * When multiple sub-repos share ONE parent `.git` monorepo root, queries git once per `gitRoot` and
 * remaps `<subRelPrefix>/<innerPath>` -> `<repoLabel>/<innerPath>`, while preserving files outside
 * any sub-repo (such as `qa/**` or root manifests) relative to `gitRoot`.
 * @param {string[]} repos
 * @param {string} [baseRef]
 * @param {{ qaRelPrefix?: string }} [options]
 */
export async function collectMultiRepoGitChangedFiles(repos, baseRef = 'HEAD~1', options = {}) {
  if (repos.length <= 1) return collectGitChangedFiles(repos[0], baseRef, options);

  const labeled = assignRepoLabels(repos);

  /** @type {Map<string, Array<{ root: string, realRoot: string, label: string, relSubPrefix: string }>>} */
  const byGitRoot = new Map();
  for (const item of labeled) {
    const gitRoot = resolveGitRoot(item.root);
    if (!gitRoot) {
      return { ok: false, reason: 'Target is not a git repository.', files: [], validBaseRef: false };
    }
    const rawRel = path.relative(gitRoot, item.realRoot).replace(/\\/g, '/').replace(/\/+$/, '');
    const relSubPrefix = rawRel && !rawRel.startsWith('..') ? rawRel : '';
    const arr = byGitRoot.get(gitRoot) || [];
    arr.push({ ...item, relSubPrefix });
    byGitRoot.set(gitRoot, arr);
  }

  const rootEntries = [...byGitRoot.entries()];
  const rootResults = await Promise.all(rootEntries.map(([gitRoot]) => queryGitRootChangedPaths(gitRoot, baseRef)));
  if (rootResults.some((r) => !r.ok)) {
    const firstErr = rootResults.find((r) => !r.ok);
    return { ok: false, reason: firstErr?.reason || 'One or more source repos are not git repositories.', files: [], validBaseRef: false };
  }

  const qaRelPrefix = options.qaRelPrefix || '';
  /** @type {string[]} */
  const merged = [];

  rootEntries.forEach(([, repoEntries], idx) => {
    const nested = repoEntries
      .filter((e) => e.relSubPrefix.length > 0)
      .sort((a, b) => b.relSubPrefix.length - a.relSubPrefix.length);
    const nonNested = repoEntries.filter((e) => e.relSubPrefix.length === 0);

    for (const gitRel of rootResults[idx].rawFiles) {
      const hit = nested.find((e) => gitRel === e.relSubPrefix || gitRel.startsWith(`${e.relSubPrefix}/`));
      if (hit) {
        const innerRel = gitRel === hit.relSubPrefix ? '' : gitRel.slice(hit.relSubPrefix.length + 1);
        if (!innerRel) continue;
        const remapped = `${hit.label}/${innerRel}`;
        if (!isIgnoredWorkbenchArtifactPath(gitRel, qaRelPrefix) && !isIgnoredWorkbenchArtifactPath(remapped, qaRelPrefix)) {
          merged.push(remapped);
        }
      } else if (nonNested.length > 0) {
        if (isIgnoredWorkbenchArtifactPath(gitRel, qaRelPrefix)) continue;
        for (const entry of nonNested) merged.push(`${entry.label}/${gitRel}`);
      } else if (!isIgnoredWorkbenchArtifactPath(gitRel, qaRelPrefix)) {
        merged.push(gitRel);
      }
    }
  });

  return {
    ok: true,
    reason: null,
    files: [...new Set(merged)].sort(),
    validBaseRef: rootResults.every((r) => r.validBaseRef),
  };
}

/**
 * Remaps explicit `--files` / `options.files` paths for multi-repo / shared-`.git` monorepo workspaces
 * into `<repoLabel>/<innerPath>` (matching `collectMultiRepoGitChangedFiles` / `buildReverseImportGraph`).
 * @param {string[] | undefined | null} rawFiles
 * @param {string[] | undefined | null} repos
 * @param {string} [effectiveRepoDir]
 * @returns {string[]}
 */
export function remapMultiRepoFilePaths(rawFiles, repos, effectiveRepoDir = '') {
  const input = Array.isArray(rawFiles) ? rawFiles : [];
  if (!Array.isArray(repos) || repos.length <= 1) return [...input];
  const uniqueRepos = [...new Set(repos.filter(Boolean).map((r) => path.resolve(r)))];
  if (uniqueRepos.length <= 1) return [...input];

  const realEffective = effectiveRepoDir ? canonicalFsPath(effectiveRepoDir) : '';
  const baseDirsSet = new Set(realEffective ? [realEffective] : []);
  const entries = assignRepoLabels(uniqueRepos).map(({ root, realRoot, label }) => {
    const gitRoot = resolveGitRoot(root);
    const realGitRoot = gitRoot ? canonicalFsPath(gitRoot) : '';
    if (realGitRoot) baseDirsSet.add(realGitRoot);
    /** @type {string[]} */
    const relPrefixes = [];
    for (const baseDir of [realEffective, realGitRoot]) {
      if (!baseDir) continue;
      const rel = path.relative(baseDir, realRoot).replace(/\\/g, '/').replace(/\/+$/, '');
      if (rel && !rel.startsWith('..') && !path.isAbsolute(rel) && !relPrefixes.includes(rel)) relPrefixes.push(rel);
    }
    return { realRoot: realRoot.replace(/\\/g, '/').replace(/\/+$/, ''), label, relPrefixes };
  });

  const knownLabels = new Set(entries.map((e) => e.label));
  const entriesByRealRoot = [...entries].sort((a, b) => b.realRoot.length - a.realRoot.length);
  const prefixRules = entries
    .flatMap((e) => e.relPrefixes.map((prefix) => ({ prefix, label: e.label })))
    .sort((a, b) => b.prefix.length - a.prefix.length);
  const baseDirs = [...baseDirsSet];
  const isWin = process.platform === 'win32';
  const eqOrStarts = (/** @type {string} */ a, /** @type {string} */ b) =>
    isWin ? a.toLowerCase() === b.toLowerCase() || a.toLowerCase().startsWith(`${b.toLowerCase()}/`) : a === b || a.startsWith(`${b}/`);
  const remapRel = (/** @type {string} */ relNorm) => {
    const hit = prefixRules.find((r) => eqOrStarts(relNorm, r.prefix));
    if (!hit) return relNorm;
    const inner = relNorm.length === hit.prefix.length ? '' : relNorm.slice(hit.prefix.length + 1);
    return inner ? `${hit.label}/${inner}` : hit.label;
  };

  /** @type {string[]} */
  const out = [];
  for (const raw of input) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) continue;
    const norm = trimmed.replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm) continue;
    const slashIdx = norm.indexOf('/');
    if (slashIdx > 0 && knownLabels.has(norm.slice(0, slashIdx))) { out.push(norm); continue; }
    if (path.isAbsolute(trimmed)) {
      const realRaw = canonicalFsPath(trimmed).replace(/\\/g, '/');
      const rootHit = entriesByRealRoot.find((e) => eqOrStarts(realRaw, e.realRoot));
      if (rootHit) {
        const inner = realRaw.length === rootHit.realRoot.length ? '' : realRaw.slice(rootHit.realRoot.length + 1);
        out.push(inner ? `${rootHit.label}/${inner}` : rootHit.label);
        continue;
      }
      const baseHit = baseDirs
        .map((b) => path.relative(b, realRaw).replace(/\\/g, '/').replace(/^\.\//, ''))
        .find((rel) => rel && !rel.startsWith('..') && !path.isAbsolute(rel));
      out.push(baseHit ? remapRel(baseHit) : norm);
      continue;
    }
    out.push(remapRel(norm));
  }
  return out;
}
