// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {
  getCodeMapAdapters,
  listCodeMapAdapters,
  registerCodeMapAdapter,
  unregisterCodeMapAdapter,
} from './registry.mjs';
import {
  convertBracketSegment,
  createRoutePatternMatcher,
  matchRuntimeRouteToPattern,
  normalizeRoutePath,
  normalizeSlash,
} from './route-matcher.mjs';
import {
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_PER_REPO_SCAN_FILES,
  SPRING_CFG_FILE_RE,
  detectMultiRepoRoots,
  indexQaSpecs,
  walkSourceFiles,
} from './spec-indexer.mjs';
import { attachSpringPackagePrefixes, extractSpringPrefixRulesFromFile } from './spring-extractor.mjs';

export {
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_PER_REPO_SCAN_FILES,
  convertBracketSegment,
  createRoutePatternMatcher,
  detectMultiRepoRoots,
  indexQaSpecs,
  listCodeMapAdapters,
  matchRuntimeRouteToPattern,
  normalizeRoutePath,
  normalizeSlash,
  registerCodeMapAdapter,
  unregisterCodeMapAdapter,
  walkSourceFiles,
};

const VIEW_FILE_RE = /^(?:src\/)?(?:views|pages)\/.+\.(?:vue|tsx|jsx|svelte|astro)$/i;
const MAX_FILE_BYTES = 256 * 1024;

/**
 * @param {string} filePath
 * @param {string} relFile
 * @param {string} text
 * @param {string} repoDir
 * @param {import('./registry.mjs').SourceFileIndex} [fileIndex]
 */
export function extractFrontendData(filePath, relFile, text, repoDir, fileIndex) {
  /** @type {import('./registry.mjs').FrontendRouteEntry[]} */
  const routes = [];
  /** @type {import('./registry.mjs').BrokenRouteImport[]} */
  const brokenImports = [];
  /** @type {import('./registry.mjs').FrontendApiCall[]} */
  const apiCalls = [];
  /** @type {string[]} */
  const imports = [];
  /** @type {string[]} */
  const axiosPrefixes = [];
  const ext = path.extname(relFile).toLowerCase();
  const ctx = { filePath, relFile, ext, text, repoDir, fileIndex };

  for (const adapter of getCodeMapAdapters().frontend) {
    const out = adapter.extract(ctx);
    if (!out) continue;
    if (out.routes?.length) routes.push(...out.routes);
    if (out.brokenImports?.length) brokenImports.push(...out.brokenImports);
    if (out.apiCalls?.length) apiCalls.push(...out.apiCalls);
    if (out.imports?.length) imports.push(...out.imports);
    if (out.axiosPrefixes?.length) axiosPrefixes.push(...out.axiosPrefixes);
  }
  return { routes, brokenImports, apiCalls, imports: [...new Set(imports)], axiosPrefixes: [...new Set(axiosPrefixes)] };
}

/** @param {string} relFile @param {string} text */
export function extractBackendAndDbData(relFile, text) {
  /** @type {import('./registry.mjs').BackendEndpoint[]} */
  const endpoints = [];
  /** @type {import('./registry.mjs').DbEntity[]} */
  const entities = [];
  /** @type {import('./backend-adapters.mjs').JavaFileMeta | null} */
  let javaMeta = null;
  /** @type {import('./backend-adapters.mjs').MybatisMapperMeta | null} */
  let mybatisMapper = null;
  const ext = path.extname(relFile).toLowerCase();
  const ctx = { relFile, ext, text };

  for (const adapter of getCodeMapAdapters().backend) {
    const out = adapter.extract(ctx);
    if (!out) continue;
    if (out.endpoints?.length) endpoints.push(...out.endpoints);
    if (out.entities?.length) entities.push(...out.entities);
    if (out.javaMeta) javaMeta = out.javaMeta;
    if (out.mybatisMapper) mybatisMapper = out.mybatisMapper;
  }
  return { endpoints, entities, javaMeta, mybatisMapper };
}

/** @param {string} prefix @param {string | null | undefined} rel @returns {string} */
function applyPrefix(prefix, rel) {
  if (!prefix || !rel) return String(rel || '');
  return `${prefix}/${rel}`;
}

/**
 * Indexes a single repository root with its own fair scan budget and optional path prefix.
 * @param {string} repoDir
 * @param {number} maxScanFiles
 * @param {string} repoPrefix
 */
function scanSingleRepo(repoDir, maxScanFiles, repoPrefix) {
  const walked = walkSourceFiles(repoDir, maxScanFiles);
  const warnings = walked.truncated
    ? [`Source scan${repoPrefix ? ` [${repoPrefix}]` : ''} reached maxScanFiles=${maxScanFiles}; configure a narrower --repo or higher limit.`]
    : [];
  const relList = walked.files.map((fp) => normalizeSlash(path.relative(repoDir, fp)));
  const fileIndex = {
    relSet: new Set(relList),
    lowerToRel: new Map(relList.map((r) => [r.toLowerCase(), r])),
    hasSrcDir: fs.existsSync(path.join(repoDir, 'src')),
    truncated: walked.truncated,
  };

  /** @type {import('./registry.mjs').FrontendRouteEntry[]} */
  const frontendRoutes = [];
  /** @type {import('./registry.mjs').BrokenRouteImport[]} */
  const brokenRouteImports = [];
  /** @type {import('./registry.mjs').FrontendApiCall[]} */
  const frontendApiCalls = [];
  /** @type {import('./backend-adapters.mjs').BackendEndpoint[]} */
  const backendEndpoints = [];
  /** @type {import('./backend-adapters.mjs').DbEntity[]} */
  const dbEntities = [];
  /** @type {Record<string, string>} */
  const backendFileTexts = {};
  /** @type {string[]} */
  const viewFiles = [];
  /** @type {Record<string, string[]>} */
  const frontendImports = {};
  /** @type {Record<string, string[]>} */
  const wrapperPrefixesByFile = {};
  /** @type {Set<string>} */
  const axiosPrefixes = new Set();
  /** @type {Array<{ packagePattern: string, prefixes: string[] }>} */
  const springPackagePrefixes = [];
  /** @type {Record<string, import('./backend-adapters.mjs').JavaFileMeta>} */
  const javaFileInfos = {};
  /** @type {import('./backend-adapters.mjs').MybatisMapperMeta[]} */
  const mybatisMappers = [];

  for (const filePath of walked.files) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    const bareRel = normalizeSlash(path.relative(repoDir, filePath));
    const relFile = applyPrefix(repoPrefix, bareRel);

    if (VIEW_FILE_RE.test(bareRel)) viewFiles.push(relFile);

    const ext = path.extname(bareRel).toLowerCase();
    if (ext === '.java' || ext === '.kt' || SPRING_CFG_FILE_RE.test(path.basename(bareRel))) {
      springPackagePrefixes.push(...extractSpringPrefixRulesFromFile(bareRel, text));
    }

    const fe = extractFrontendData(filePath, bareRel, text, repoDir, fileIndex);
    for (const r of fe.routes) frontendRoutes.push({ ...r, file: applyPrefix(repoPrefix, r.file) });
    for (const b of fe.brokenImports) {
      brokenRouteImports.push({
        ...b,
        routerFile: applyPrefix(repoPrefix, b.routerFile),
        expectedFile: b.expectedFile ? applyPrefix(repoPrefix, b.expectedFile) : null,
      });
    }
    for (const c of fe.apiCalls) frontendApiCalls.push({ ...c, file: relFile });
    if (fe.imports.length > 0) frontendImports[relFile] = fe.imports.map((imp) => applyPrefix(repoPrefix, imp));
    if (fe.axiosPrefixes.length > 0) {
      wrapperPrefixesByFile[relFile] = fe.axiosPrefixes;
      for (const p of fe.axiosPrefixes) axiosPrefixes.add(p);
    }

    const be = extractBackendAndDbData(bareRel, text);
    for (const ep of be.endpoints) backendEndpoints.push({ ...ep, file: applyPrefix(repoPrefix, ep.file) });
    for (const ent of be.entities) dbEntities.push({ ...ent, file: applyPrefix(repoPrefix, ent.file) });
    if (be.endpoints.length > 0) backendFileTexts[relFile] = text;
    if (be.javaMeta) javaFileInfos[relFile] = { ...be.javaMeta, relFile };
    if (be.mybatisMapper) mybatisMappers.push({ ...be.mybatisMapper, file: relFile });
  }

  /** @type {Record<string, string>} */
  const axiosPrefixByFile = {};
  const singleRepoPrefix = axiosPrefixes.size === 1 ? [...axiosPrefixes][0] : '';
  for (const [f, imps] of Object.entries(frontendImports)) {
    const matched = imps.flatMap((imp) => wrapperPrefixesByFile[imp] || []);
    const unique = [...new Set(matched)];
    if (unique.length === 1) axiosPrefixByFile[f] = unique[0];
    else if (singleRepoPrefix && /(?:^|\/)api\//.test(f)) axiosPrefixByFile[f] = singleRepoPrefix;
  }

  return {
    fileCount: walked.files.length,
    truncated: walked.truncated,
    warnings,
    frontendRoutes,
    brokenRouteImports,
    frontendApiCalls,
    backendEndpoints,
    dbEntities,
    backendFileTexts,
    viewFiles,
    frontendImports,
    axiosPrefixes: [...axiosPrefixes],
    axiosPrefixByFile,
    springPackagePrefixes,
    javaFileInfos,
    mybatisMappers,
  };
}

/**
 * Indexes multiple repositories fairly (each gets its own `maxScanFiles` budget) and merges source graphs.
 * @param {string[]} repos
 * @param {{ maxScanFiles?: number, apiPrefixes?: string[], prefixSingleRepo?: boolean }} [options]
 */
export function indexRepositoriesSource(repos, options = {}) {
  const maxScanFiles = options.maxScanFiles || DEFAULT_PER_REPO_SCAN_FILES;
  const resolved = [...new Set((repos || []).filter(Boolean).map((r) => path.resolve(r)))].filter((r) => fs.existsSync(r));
  const effectiveRepos = resolved.length === 1 ? (detectMultiRepoRoots(resolved[0]).length >= 2 ? detectMultiRepoRoots(resolved[0]) : resolved) : resolved;
  const multiMode = effectiveRepos.length > 1 || Boolean(options.prefixSingleRepo);

  const usedLabels = new Set();
  const repoLabels = effectiveRepos.map((r) => {
    if (!multiMode) return '';
    const base = path.basename(r) || 'repo';
    let label = base;
    let idx = 2;
    while (usedLabels.has(label)) { label = `${base}-${idx}`; idx += 1; }
    usedLabels.add(label);
    return label;
  });

  const acc = {
    repoDir: normalizeSlash(resolved[0] || ''),
    repos: effectiveRepos.map((r) => normalizeSlash(r)),
    fileCount: 0,
    truncated: false,
    warnings: /** @type {string[]} */ ([]),
    frontendRoutes: /** @type {import('./registry.mjs').FrontendRouteEntry[]} */ ([]),
    brokenRouteImports: /** @type {import('./registry.mjs').BrokenRouteImport[]} */ ([]),
    frontendApiCalls: /** @type {import('./registry.mjs').FrontendApiCall[]} */ ([]),
    backendEndpoints: /** @type {import('./backend-adapters.mjs').BackendEndpoint[]} */ ([]),
    dbEntities: /** @type {import('./backend-adapters.mjs').DbEntity[]} */ ([]),
    backendFileTexts: /** @type {Record<string, string>} */ ({}),
    viewFiles: /** @type {string[]} */ ([]),
    frontendImports: /** @type {Record<string, string[]>} */ ({}),
    axiosPrefixes: /** @type {string[]} */ ([]),
    axiosPrefixByFile: /** @type {Record<string, string>} */ ({}),
    springPackagePrefixes: /** @type {Array<{ packagePattern: string, prefixes: string[] }>} */ ([]),
    javaFileInfos: /** @type {Record<string, import('./backend-adapters.mjs').JavaFileMeta>} */ ({}),
    mybatisMappers: /** @type {import('./backend-adapters.mjs').MybatisMapperMeta[]} */ ([]),
  };

  /** @type {Set<string>} */
  const axiosSet = new Set((options.apiPrefixes || []).map(normalizeRoutePath));

  effectiveRepos.forEach((repoRoot, idx) => {
    const part = scanSingleRepo(repoRoot, maxScanFiles, repoLabels[idx]);
    acc.fileCount += part.fileCount;
    acc.truncated = acc.truncated || part.truncated;
    acc.warnings.push(...part.warnings);
    acc.frontendRoutes.push(...part.frontendRoutes);
    acc.brokenRouteImports.push(...part.brokenRouteImports);
    acc.frontendApiCalls.push(...part.frontendApiCalls);
    acc.backendEndpoints.push(...part.backendEndpoints);
    acc.dbEntities.push(...part.dbEntities);
    Object.assign(acc.backendFileTexts, part.backendFileTexts);
    acc.viewFiles.push(...part.viewFiles);
    Object.assign(acc.frontendImports, part.frontendImports);
    Object.assign(acc.axiosPrefixByFile, part.axiosPrefixByFile);
    for (const p of part.axiosPrefixes) axiosSet.add(p);
    acc.springPackagePrefixes.push(...part.springPackagePrefixes);
    Object.assign(acc.javaFileInfos, part.javaFileInfos);
    acc.mybatisMappers.push(...part.mybatisMappers);
  });

  acc.axiosPrefixes = [...axiosSet];
  attachSpringPackagePrefixes(acc.backendEndpoints, acc.springPackagePrefixes);
  return acc;
}

/**
 * Indexes static routes, API calls, backend endpoints, and DB entities from host repository files (`K-05`).
 * Backward-compatible single-repo API; auto-expands multi-repo parents and supports `options.repos`.
 * @param {string} repoDir
 * @param {{ maxScanFiles?: number, repos?: string[], apiPrefixes?: string[] }} [options]
 */
export function indexRepositorySource(repoDir, options = {}) {
  const repos = Array.isArray(options.repos) && options.repos.length > 0 ? options.repos : repoDir ? [repoDir] : [];
  if (repos.length === 0 || (!options.repos && (!repoDir || !fs.existsSync(repoDir)))) {
    return {
      repoDir: normalizeSlash(repoDir || ''),
      repos: [],
      fileCount: 0,
      truncated: false,
      warnings: /** @type {string[]} */ ([]),
      frontendRoutes: /** @type {import('./registry.mjs').FrontendRouteEntry[]} */ ([]),
      brokenRouteImports: /** @type {import('./registry.mjs').BrokenRouteImport[]} */ ([]),
      frontendApiCalls: /** @type {import('./registry.mjs').FrontendApiCall[]} */ ([]),
      backendEndpoints: /** @type {import('./backend-adapters.mjs').BackendEndpoint[]} */ ([]),
      dbEntities: /** @type {import('./backend-adapters.mjs').DbEntity[]} */ ([]),
      backendFileTexts: /** @type {Record<string, string>} */ ({}),
      viewFiles: /** @type {string[]} */ ([]),
      frontendImports: /** @type {Record<string, string[]>} */ ({}),
      axiosPrefixes: /** @type {string[]} */ ([]),
      axiosPrefixByFile: /** @type {Record<string, string>} */ ({}),
      springPackagePrefixes: /** @type {Array<{ packagePattern: string, prefixes: string[] }>} */ ([]),
      javaFileInfos: /** @type {Record<string, import('./backend-adapters.mjs').JavaFileMeta>} */ ({}),
      mybatisMappers: /** @type {import('./backend-adapters.mjs').MybatisMapperMeta[]} */ ([]),
    };
  }
  return indexRepositoriesSource(repos, options);
}
