// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { compileGlob } from '../core/glob.mjs';
import { runProcess } from '../core/proc.mjs';
import { canonicalFsPath, resolveGitRoot } from '../kernel/gate-kernel.mjs';
import {
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
        if (!targetRelPrefix.startsWith('..')) {
          aliases.push({ prefix, targetRelPrefix });
        }
      }
    } catch {
      // ignore non-standard tsconfig
    }
  }
  return aliases;
}

/**
 * Builds a static reverse import graph (`targetRel -> Set<importerRel>`) across TS/JS/Vue files.
 * Uses a single-pass in-memory source index (zero per-import `fs.existsSync`/`statSync` storms)
 * and strips comments before scanning imports.
 * @param {string} repoDir
 * @param {{ includeQa?: boolean, maxFiles?: number }} [options]
 */
export function buildReverseImportGraph(repoDir, options = {}) {
  /** @type {Map<string, Set<string>> & { truncated?: boolean }} */
  const reverse = new Map();
  reverse.truncated = false;
  if (!repoDir || !fs.existsSync(repoDir)) return reverse;

  const pathAliases = loadTsConfigPathAliases(repoDir);
  const index = buildRepoSourceIndex(repoDir, {
    includeQa: Boolean(options.includeQa),
    maxFiles: options.maxFiles ?? MAX_GRAPH_FILES,
  });
  reverse.truncated = index.truncated;

  const importRe =
    /(?:import\s+(?:[^'"`;]{0,200}\s+from\s+)?['"`]([^'"`]+)['"`]|export\s+[^'"`;]{0,200}\s+from\s+['"`]([^'"`]+)['"`]|import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)|require\s*\(\s*['"`]([^'"`]+)['"`]\s*\))/g;

  for (const { full, rel: fromRel } of index.files) {
    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    if (stat.size > 512 * 1024) continue;
    const rawText = fs.readFileSync(full, 'utf8');
    const text = stripJsCommentsPreserveStrings(rawText);
    for (const m of text.matchAll(importRe)) {
      const spec = m[1] || m[2] || m[3] || m[4];
      if (!spec) continue;
      const targetRel = resolveRepoImportFromIndex(fromRel, spec, pathAliases, index);
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
 * Segment-aligned stem match (`I-03`).
 * @param {string} specRel
 * @param {string} stem
 * @returns {boolean}
 */
export function specMatchesStemExactSegment(specRel, stem) {
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
 * Loads and validates rules from an impact JSON file (`impact-map.json` or `knowledge/impact-map.auto.json`).
 * Rejects invalid JSON and un-flagged catch-all globs (`I-01`).
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
    return {
      ok: false,
      rules: [],
      errorReason: `Invalid JSON in ${path.basename(filePath)} — falling back to full suite.`,
    };
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
 * Collects changed & untracked files via `git -c core.quotePath=off ... -z` (handles Chinese/Unicode paths & monorepo subdirs, `G-07`).
 * @param {string} repoDir
 * @param {string} [baseRef]
 */
export async function collectGitChangedFiles(repoDir, baseRef = 'HEAD~1') {
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
      if (rel && !rel.startsWith('..')) {
        files.add(rel);
      }
    }
  };

  const [verifyRes, branchDiff, headCheck, wtDiffHead, untracked] = await Promise.all([
    baseRef
      ? runProcess('git', ['-c', 'core.quotePath=off', 'rev-parse', '--verify', baseRef], {
          cwd: gitRoot,
          timeoutMs: 5000,
        })
      : Promise.resolve(null),
    baseRef
      ? runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z', `${baseRef}...HEAD`], {
          cwd: gitRoot,
          timeoutMs: 8000,
        })
      : Promise.resolve(null),
    runProcess('git', ['-c', 'core.quotePath=off', 'rev-parse', '--verify', 'HEAD'], {
      cwd: gitRoot,
      timeoutMs: 5000,
    }),
    runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z', 'HEAD'], {
      cwd: gitRoot,
      timeoutMs: 8000,
    }),
    runProcess('git', ['-c', 'core.quotePath=off', 'ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: gitRoot,
      timeoutMs: 8000,
    }),
  ]);

  const validBaseRef = Boolean(verifyRes && verifyRes.code === 0);
  if (validBaseRef && branchDiff && branchDiff.code === 0) {
    addNulOutput(branchDiff.stdout);
  }

  if (headCheck.code === 0) {
    if (wtDiffHead.code === 0) addNulOutput(wtDiffHead.stdout);
  } else {
    const wtDiff = await runProcess('git', ['-c', 'core.quotePath=off', 'diff', '--name-only', '-z'], {
      cwd: gitRoot,
      timeoutMs: 8000,
    });
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
 * Indexes `REQ-*` requirement identifiers to spec files & spec markdown documents so changes in
 * `specs/*.md` or `REQ-*`-tagged files automatically select covering tests (`WU-04`).
 * @param {string} qaDir
 * @param {string} repoDir
 * @param {string[]} allSpecs
 */
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
      if (!set) {
        set = new Set();
        reqToSpecs.set(id, set);
      }
      set.add(spRel);
    }
  }
  return reqToSpecs;
}

/**
 * Extracts `REQ-*` IDs mentioned in a changed file (e.g., `qa/specs/auth.md` or source comment).
 * @param {string} absFilePath
 * @returns {string[]}
 */
export function extractReqIdsFromFile(absFilePath) {
  if (!fs.existsSync(absFilePath)) return [];
  try {
    const text = fs.readFileSync(absFilePath, 'utf8');
    return [...new Set([...text.matchAll(/\bREQ-[A-Za-z0-9_-]+\b/g)].map((m) => m[0].toUpperCase()))];
  } catch {
    return [];
  }
}
