// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { loadAndValidateAitestConfigFile } from '../core/config.mjs';
import { canonicalFsPath } from '../kernel/gate-kernel.mjs';

const WORKBENCH_ARTIFACT_PREFIX_RE = /^(?:\.aitest|reports|knowledge|test-results|playwright-report)(?:\/|$)/i;
const JAVA_STEM_SUFFIX_RE = /(?:Controller|ServiceImpl|Service|Mapper|Manager|DO|Entity|PO|ReqVO|RespVO|VO|DTO)$/i;
const JS_STEM_SUFFIX_RE = /\.(?:controller|service|view|page|component|route|routes)$/i;
const REPO_MARKERS = ['.git', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'pyproject.toml'];
const UNIVERSAL_JAVA_BASE_TYPES = new Set([
  'BaseDO', 'TenantBaseDO', 'BaseEntity', 'BaseVO', 'BaseDTO', 'BaseReqVO', 'BaseRespVO',
  'BaseMapper', 'BaseMapperX', 'MPJBaseMapper', 'BaseController', 'ServiceImpl', 'IService',
  'PageParam', 'SortablePageParam', 'Object', 'Serializable', 'Exception', 'RuntimeException',
]);

/**
 * Returns true if `relPath` is workbench state or report output (`.aitest/**`, `reports/**`,
 * `knowledge/**`, `test-results/**`, `playwright-report/**` at repo root or under `<qaRel>/`).
 * @param {string} relPath
 * @param {string} [qaRelPrefix]
 * @returns {boolean}
 */
export function isIgnoredWorkbenchArtifactPath(relPath, qaRelPrefix = '') {
  const clean = String(relPath || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!clean) return false;
  if (/(?:^|\/)\.aitest(?:\/|$)/i.test(clean)) return true;
  if (WORKBENCH_ARTIFACT_PREFIX_RE.test(clean)) return true;
  if (qaRelPrefix && clean.startsWith(`${qaRelPrefix}/`)) {
    if (WORKBENCH_ARTIFACT_PREFIX_RE.test(clean.slice(qaRelPrefix.length + 1))) return true;
  }
  if (clean.startsWith('qa/') && WORKBENCH_ARTIFACT_PREFIX_RE.test(clean.slice(3))) return true;
  return false;
}

/**
 * Extracts normalized file stem after stripping extensions and JS/TS/Java architectural suffixes.
 * @param {string} filePath
 * @returns {string}
 */
export function extractCandidateStem(filePath) {
  let base = path
    .basename(String(filePath || ''))
    .replace(/\.[a-zA-Z0-9]+$/, '')
    .replace(JS_STEM_SUFFIX_RE, '');
  for (let i = 0; i < 2; i += 1) {
    const next = base.replace(JAVA_STEM_SUFFIX_RE, '');
    if (next === base || !next) break;
    base = next;
  }
  return base.toLowerCase();
}

/**
 * Loads `knowledge/code-map.json` as an authoritative file -> coveringSpecs lookup table.
 * @param {string} qaDir
 * @param {string[]} allSpecs
 * @returns {Map<string, Array<{ spec: string, via: string }>>}
 */
export function buildCodeMapFileToSpecMap(qaDir, allSpecs) {
  /** @type {Map<string, Array<{ spec: string, via: string }>>} */
  const map = new Map();
  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (!fs.existsSync(cmPath)) return map;
  let cm;
  try {
    cm = JSON.parse(fs.readFileSync(cmPath, 'utf8'));
  } catch {
    return map;
  }
  const allSpecSet = new Set(allSpecs);
  const addLink = (/** @type {string} */ fileRel, /** @type {string} */ spec, /** @type {string} */ via) => {
    const norm = String(fileRel || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!norm || !allSpecSet.has(spec)) return;
    const list = map.get(norm) || [];
    if (!list.some((item) => item.spec === spec && item.via === via)) {
      list.push({ spec, via });
      map.set(norm, list);
    }
  };

  for (const r of Object.values(cm?.routes || {})) {
    const specs = Array.isArray(r?.coveringSpecs) ? r.coveringSpecs : [];
    for (const sp of specs) {
      if (r.frontendFile) addLink(r.frontendFile, sp, `code-map(${r.route})`);
      for (const bf of r.linkedBackendFiles || []) addLink(bf, sp, `code-map-be(${r.route})`);
      for (const af of r.linkedApiFiles || []) addLink(af, sp, `code-map-fe-api(${r.route})`);
      for (const sf of [...(r.linkedServiceFiles || []), ...(r.linkedMapperFiles || []), ...(r.linkedXmlFiles || [])]) {
        addLink(sf, sp, `code-map-be(${r.route})`);
      }
    }
  }
  const apisEntries = Array.isArray(cm?.apis)
    ? cm.apis.map((/** @type {any} */ api) => [api?.path || api?.route || '', api])
    : Object.entries(cm?.apis || {});
  for (const [apiKey, api] of apisEntries) {
    const label = api?.path || api?.route || apiKey || '';
    const routeSpecs = Array.isArray(api?.linkedRoutes)
      ? api.linkedRoutes.flatMap((/** @type {string} */ rk) => cm?.routes?.[rk]?.coveringSpecs || [])
      : [];
    const specs = [...new Set([...(Array.isArray(api?.coveringSpecs) ? api.coveringSpecs : []), ...routeSpecs])];
    const beFiles = [
      ...(Array.isArray(api?.backendFiles) ? api.backendFiles : []),
      ...(api?.backendFile ? [api.backendFile] : []),
      ...(api?.controllerFile ? [api.controllerFile] : []),
    ];
    const feFiles = [
      ...(Array.isArray(api?.frontendFiles) ? api.frontendFiles : []),
      ...(Array.isArray(api?.frontendApiFiles) ? api.frontendApiFiles : []),
      ...(api?.frontendApiFile ? [api.frontendApiFile] : []),
    ];
    for (const sp of specs) {
      for (const bf of beFiles) addLink(bf, sp, `code-map-api(${label})`);
      for (const ff of feFiles) addLink(ff, sp, `code-map-api-fe(${label})`);
    }
  }
  const chainsList = Array.isArray(cm?.serviceChains) ? cm.serviceChains : Object.values(cm?.serviceChains || {});
  for (const ch of chainsList) {
    if (!ch || typeof ch !== 'object') continue;
    const routeSpecs = ch.route && cm?.routes?.[ch.route]?.coveringSpecs ? cm.routes[ch.route].coveringSpecs : [];
    const specs = [...new Set([...(Array.isArray(ch.coveringSpecs) ? ch.coveringSpecs : []), ...routeSpecs])];
    const label = ch.apiPath || ch.route || '';
    const files = [
      ch.viewFile, ch.frontendFile, ch.apiFile, ch.frontendApiFile, ch.controllerFile,
      ...(Array.isArray(ch.serviceFiles) ? ch.serviceFiles : []),
      ...(Array.isArray(ch.feignFiles) ? ch.feignFiles : []),
      ...(Array.isArray(ch.mapperFiles) ? ch.mapperFiles : []),
      ...(Array.isArray(ch.xmlFiles) ? ch.xmlFiles : []),
    ].filter(Boolean);
    for (const sp of specs) {
      for (const f of files) addLink(f, sp, `code-map-chain(${label})`);
    }
  }
  return map;
}

/** @param {string} dir @returns {string[]} */
export function detectSiblingRepoRoots(dir) {
  if (!dir || !fs.existsSync(dir) || REPO_MARKERS.some((m) => fs.existsSync(path.join(dir, m)))) return [];
  /** @type {string[]} */
  const childRoots = [];
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'qa' || entry.name === 'node_modules') continue;
      const sub = path.join(dir, entry.name);
      if (REPO_MARKERS.some((m) => fs.existsSync(path.join(sub, m)))) childRoots.push(sub);
    }
  } catch {
    return [];
  }
  return childRoots.length >= 2 ? childRoots : [];
}

/**
 * Resolves configured multi-repo roots for `computeImpact` without mutating locked config.
 * @param {string} repoDir
 * @param {string} qaDir
 * @param {{ repos?: string[], repo?: string | string[] }} [options]
 * @returns {string[]}
 */
export function resolveImpactRepos(repoDir, qaDir, options = {}) {
  const explicit = [
    ...(Array.isArray(options.repos) ? options.repos : []),
    ...(Array.isArray(options.repo) ? options.repo : options.repo ? String(options.repo).split(',') : []),
  ]
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => path.resolve(s));
  if (explicit.length > 0) return [...new Set(explicit)];

  const cfgRes = loadAndValidateAitestConfigFile(qaDir);
  const parentOfQa = path.dirname(qaDir);
  if (cfgRes.config?.sourceRepos?.length > 0) {
    const cfgRepos = cfgRes.config.sourceRepos
      .map((entry) => {
        if (path.isAbsolute(entry)) return entry;
        const fromParent = path.resolve(parentOfQa, entry);
        return fs.existsSync(fromParent) ? fromParent : path.resolve(qaDir, entry);
      })
      .filter((p) => fs.existsSync(p));
    if (cfgRepos.length > 0) return [...new Set(cfgRepos)];
  }

  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (fs.existsSync(cmPath)) {
    try {
      const cm = JSON.parse(fs.readFileSync(cmPath, 'utf8'));
      const metaRepos = Array.isArray(cm?.meta?.sourceRepos)
        ? cm.meta.sourceRepos.filter((/** @type {string} */ p) => typeof p === 'string' && fs.existsSync(p))
        : [];
      if (metaRepos.length > 0) return [...new Set(metaRepos)];
    } catch {
      // ignore invalid code-map
    }
  }

  const effectiveRoot = canonicalFsPath(repoDir) === canonicalFsPath(qaDir) ? parentOfQa : repoDir;
  const siblings = detectSiblingRepoRoots(effectiveRoot);
  return siblings.length >= 2 ? siblings : [effectiveRoot];
}

/**
 * Adds Java `import`, `Impl -> Interface`, and MyBatis `Mapper.xml -> Mapper.java` reverse edges.
 * @param {Array<{ full: string, rel: string }>} files
 * @param {Map<string, Set<string>>} reverseGraph
 * @param {(s: string) => string} stripCommentsFn
 */
export function addJavaAndXmlReverseEdges(files, reverseGraph, stripCommentsFn) {
  /** @type {Map<string, string>} */
  const fqcnToRel = new Map();
  /** @type {Map<string, Array<{ rel: string, className: string }>>} */
  const pkgToEntries = new Map();
  /** @type {Map<string, string[]>} */
  const simpleToRels = new Map();
  /** @type {Array<{ rel: string, pkg: string, className: string, imports: string[], implNames: string[], extendsNames: string[], stripped: string }>} */
  const javaRecords = [];
  /** @type {Array<{ rel: string, text: string }>} */
  const xmlRecords = [];

  const stripGenericArgs = (/** @type {string} */ s) => {
    let out = '';
    let depth = 0;
    for (let i = 0; i < s.length; i += 1) {
      const ch = s[i];
      if (ch === '<') depth += 1;
      else if (ch === '>') depth = Math.max(0, depth - 1);
      else if (depth === 0) out += ch;
    }
    return out;
  };

  for (const { full, rel } of files) {
    if (!rel.endsWith('.java') && !rel.endsWith('.xml')) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.size > 512 * 1024) continue;
    const raw = fs.readFileSync(full, 'utf8');
    if (rel.endsWith('.xml')) {
      if (/<mapper\b/i.test(raw)) xmlRecords.push({ rel, text: raw });
      continue;
    }
    const stripped = stripCommentsFn(raw);
    const pkgMatch = stripped.match(/^\s*package\s+([a-zA-Z0-9_.]+)\s*;/m);
    const pkg = pkgMatch ? pkgMatch[1] : '';
    const decl = stripped.match(/\b(?:class|interface|record)\s+([A-Za-z0-9_$]+)(?:<[^>]*>)?([^;{]*)\{/);
    const className = decl ? decl[1] : path.basename(rel, '.java');
    const fqcn = pkg ? `${pkg}.${className}` : className;
    fqcnToRel.set(fqcn, rel);
    const pkgArr = pkgToEntries.get(pkg) || [];
    pkgArr.push({ rel, className });
    pkgToEntries.set(pkg, pkgArr);
    const simArr = simpleToRels.get(className) || [];
    if (!simArr.includes(rel)) simArr.push(rel);
    simpleToRels.set(className, simArr);

    const imports = [...stripped.matchAll(/^\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*$]+)\s*;/gm)].map((m) => m[1]);
    /** @type {string[]} */
    const implNames = [];
    /** @type {string[]} */
    const extendsNames = [];
    if (decl?.[2]) {
      const headerClause = stripGenericArgs(decl[2]);
      const extPart = headerClause.match(/\bextends\s+(.+?)(?=\bimplements\b|$)/);
      if (extPart) {
        for (const m of extPart[1].matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) extendsNames.push(m[1]);
      }
      const implPart = headerClause.match(/\bimplements\s+([^{]+)/);
      if (implPart) {
        for (const m of implPart[1].matchAll(/\b([A-Z][A-Za-z0-9_$]*)\b/g)) implNames.push(m[1]);
      }
    }
    javaRecords.push({ rel, pkg, className, imports, implNames, extendsNames, stripped });
  }

  const addEdge = (/** @type {string} */ targetRel, /** @type {string} */ importerRel) => {
    if (!targetRel || !importerRel || targetRel === importerRel) return;
    let set = reverseGraph.get(targetRel);
    if (!set) { set = new Set(); reverseGraph.set(targetRel, set); }
    set.add(importerRel);
  };

  /** @type {Array<{ subRel: string, superRel: string, superName: string }>} */
  const extendsEdges = [];
  /** @type {Map<string, number>} */
  const subclassCounts = new Map();

  for (const rec of javaRecords) {
    /** @type {Map<string, string>} */
    const importedSimpleToRel = new Map();
    for (const imp of rec.imports) {
      const exact = fqcnToRel.get(imp);
      if (exact) {
        addEdge(exact, rec.rel);
        const simple = imp.split('.').pop();
        if (simple) importedSimpleToRel.set(simple, exact);
      } else if (imp.endsWith('.*')) {
        const wPkg = imp.slice(0, -2);
        for (const cand of pkgToEntries.get(wPkg) || []) {
          if (new RegExp(`\\b${cand.className}\\b`).test(rec.stripped)) {
            addEdge(cand.rel, rec.rel);
            importedSimpleToRel.set(cand.className, cand.rel);
          }
        }
      }
    }
    for (const cand of pkgToEntries.get(rec.pkg) || []) {
      if (cand.rel !== rec.rel && new RegExp(`\\b${cand.className}\\b`).test(rec.stripped)) {
        addEdge(cand.rel, rec.rel);
        importedSimpleToRel.set(cand.className, cand.rel);
      }
    }
    const resolveTypeRel = (/** @type {string} */ name) =>
      importedSimpleToRel.get(name) || (simpleToRels.get(name)?.length === 1 ? simpleToRels.get(name)?.[0] : undefined);
    // Bridge `Impl -> Interface` so editing `*ServiceImpl.java` propagates to `*Controller.java` injecting `*Service`!
    for (const ifaceName of rec.implNames) {
      const ifaceRel = resolveTypeRel(ifaceName);
      if (ifaceRel) addEdge(rec.rel, ifaceRel);
    }
    // Bridge Java `extends` inheritance (Super -> Sub always; polymorphic Sub -> Super for non-universal base types)
    for (const superName of rec.extendsNames) {
      const superRel = resolveTypeRel(superName);
      if (!superRel || superRel === rec.rel) continue;
      addEdge(superRel, rec.rel);
      extendsEdges.push({ subRel: rec.rel, superRel, superName });
      subclassCounts.set(superRel, (subclassCounts.get(superRel) || 0) + 1);
    }
  }

  for (const { subRel, superRel, superName } of extendsEdges) {
    if (!UNIVERSAL_JAVA_BASE_TYPES.has(superName) && (subclassCounts.get(superRel) || 0) <= 6) {
      addEdge(subRel, superRel);
    }
  }

  for (const xr of xmlRecords) {
    const ns = xr.text.match(/<mapper\b[^>]*\bnamespace\s*=\s*["']([^"']+)["']/i)?.[1]?.trim();
    const mapperRel = ns ? fqcnToRel.get(ns) : undefined;
    if (mapperRel) addEdge(xr.rel, mapperRel);
  }
}

/**
 * Evaluates reverse dependent closure with intermediate-component upward aggregation:
 * unmapped intermediate nodes continue walking upward; only unmapped terminal ancestors force `full`.
 * @param {{
 *   file: string,
 *   reverseGraph: Map<string, Set<string>>,
 *   dependents: Array<{ file: string, chain: string[] }>,
 *   matchCandidateFileToSpecs: (candidateFile: string, chainPrefix: string | null) => { forceFull: boolean, matchedAny: boolean },
 * }} params
 * @returns {{ ok: boolean, reason?: string, via?: string }}
 */
export function evaluateUpwardDependentClosure({ file, reverseGraph, dependents, matchCandidateFileToSpecs }) {
  const direct = matchCandidateFileToSpecs(file, null);
  if (direct.forceFull) {
    return { ok: false, reason: `Impact rule for "${file}" requires full suite.`, via: `fullSuite-rule: ${file}` };
  }

  /** @type {Map<string, boolean>} */
  const matchedNodes = new Map([[file, direct.matchedAny]]);
  for (const dep of dependents) {
    const res = matchCandidateFileToSpecs(dep.file, dep.chain.join(' -> '));
    if (res.forceFull) {
      return { ok: false, reason: `Transitive dependent "${dep.file}" of "${file}" requires full suite.`, via: `import-graph: ${dep.chain.join(' -> ')}` };
    }
    matchedNodes.set(dep.file, res.matchedAny);
  }

  /** @param {string} node @param {string[]} chain @param {Set<string>} onStack @returns {{ ok: boolean, reason?: string, via?: string }} */
  const verifyCovered = (node, chain, onStack) => {
    const importers = [...(reverseGraph.get(node) || [])].filter((imp) => !onStack.has(imp));
    if (importers.length === 0) {
      if (matchedNodes.get(node)) return { ok: true };
      return node === file
        ? { ok: false, reason: `Unmapped source file "${file}" has unknown blast radius — falling back to full regression suite.`, via: `unmapped-fallback: ${file}` }
        : { ok: false, reason: `Transitive dependent "${node}" of "${file}" is unmapped — falling back to full suite to prevent missed regressions.`, via: `unmapped-transitive: ${chain.join(' -> ')}` };
    }
    /** @type {Array<{ ok: boolean, reason?: string, via?: string }>} */
    const unmappedBranches = [];
    for (const imp of importers) {
      const nextStack = new Set(onStack);
      nextStack.add(imp);
      const res = verifyCovered(imp, [...chain, imp], nextStack);
      if (!res.ok) {
        const impParents = reverseGraph.get(imp);
        const isOrphanRootWrapper =
          matchedNodes.get(node) === true &&
          /(?:^|\/)src\/views\/index\.vue$/i.test(imp) &&
          (!impParents || impParents.size === 0);
        if (!isOrphanRootWrapper) unmappedBranches.push(res);
      }
    }
    if (unmappedBranches.length > 0) return unmappedBranches[0];
    return { ok: true };
  };

  return verifyCovered(file, [file], new Set([file]));
}
