// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { buildJavaDbChainIndex } from './correlator.mjs';
import {
  getCodeMapAdapters,
  listCodeMapAdapters,
  registerCodeMapAdapter,
  resolveImportCandidate,
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
  buildFeignAndDubboBridges,
  buildMqEdges,
  buildMybatisXmlLinks,
  extractFeignClientFromFile,
  extractFeignMethodCallers,
  extractRpcAndJobSignals,
} from './rpc-mybatis-extractor.mjs';
import {
  DEFAULT_MAX_SCAN_FILES,
  DEFAULT_PER_REPO_SCAN_FILES,
  SPRING_CFG_FILE_RE,
  detectMultiRepoRoots,
  indexQaSpecs,
  walkSourceFiles,
} from './spec-indexer.mjs';
import {
  attachSpringPackagePrefixes,
  buildJavaConstantTable,
  extractJavaStringConstants,
  extractSpringPrefixRulesFromFile,
  stripJavaComments,
} from './spring-prefix-resolver.mjs';
import { parseStaticImports, stripJsComments } from './vue-extractor.mjs';
import {
  extractAxiosWrapperInfo,
  extractCrudFactoryApiCalls,
  extractCrudFactoryDefinition,
  extractGlobalVueComponents,
  extractVueTemplateComponents,
  resolveChainedAxiosPrefixes,
  resolveVueTemplateRefs,
} from './vue-template-factory.mjs';

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
const FRONTEND_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.svelte', '.astro']);
const SPRING_PREFIX_HINT_RE = /(?:WebConfiguration|WebAutoConfiguration|WebMvcConfig|WebProperties|configurePathMatch|PathMatchConfigurer|addPathPrefix|@ConfigurationProperties)/;
const RPC_SIGNAL_HINT_RE = /@DubboService\b|@DubboReference\b|@RocketMQMessageListener\b|@XxlJob\b|\.(?:syncSend|asyncSend|sendOneWay|convertAndSend|syncSendOrderly|asyncSendOrderly)\s*\(/;
const MAX_FILE_BYTES = 256 * 1024;

/** @param {string} prefix @param {string | null | undefined} rel @returns {string} */
const applyPrefix = (prefix, rel) => (!prefix || !rel ? String(rel || '') : `${prefix}/${rel}`);

/** @param {string} repoDir @param {string[]} repos */
function createEmptySourceIndex(repoDir, repos) {
  return {
    repoDir: normalizeSlash(repoDir || ''),
    repos,
    fileCount: 0,
    truncated: false,
    warnings: /** @type {string[]} */ ([]),
    frontendRoutes: /** @type {import('./registry.mjs').FrontendRouteEntry[]} */ ([]),
    brokenRouteImports: /** @type {import('./registry.mjs').BrokenRouteImport[]} */ ([]),
    frontendApiCalls: /** @type {Array<import('./registry.mjs').FrontendApiCall & { rawPath?: string, clientFile?: string, clientPrefix?: string, generatedBy?: string }>} */ ([]),
    backendEndpoints: /** @type {import('./backend-adapters.mjs').BackendEndpoint[]} */ ([]),
    dbEntities: /** @type {import('./backend-adapters.mjs').DbEntity[]} */ ([]),
    backendFileTexts: /** @type {Record<string, string>} */ ({}),
    viewFiles: /** @type {string[]} */ ([]),
    frontendImports: /** @type {Record<string, string[]>} */ ({}),
    frontendNamedImports: /** @type {Record<string, Record<string, string[]>>} */ ({}),
    axiosPrefixes: /** @type {string[]} */ ([]),
    axiosPrefixByFile: /** @type {Record<string, string>} */ ({}),
    springPackagePrefixes: /** @type {import('./spring-prefix-resolver.mjs').SpringPrefixRule[]} */ ([]),
    springPrefixRules: /** @type {import('./spring-prefix-resolver.mjs').SpringPrefixRule[]} */ ([]),
    javaFileInfos: /** @type {Record<string, import('./correlator.mjs').ExtendedJavaFileMeta>} */ ({}),
    mybatisMappers: /** @type {Array<import('./backend-adapters.mjs').MybatisMapperMeta & { statements?: any[] }>} */ ([]),
    mybatisXmlLinks: /** @type {import('./rpc-mybatis-extractor.mjs').MybatisXmlLink[]} */ ([]),
    feignBridges: /** @type {import('./rpc-mybatis-extractor.mjs').FeignBridgeEntry[]} */ ([]),
    feignMethodCallers: /** @type {import('./rpc-mybatis-extractor.mjs').FeignMethodCallerEntry[]} */ ([]),
    dubboServices: /** @type {import('./rpc-mybatis-extractor.mjs').DubboServiceEntry[]} */ ([]),
    dubboReferences: /** @type {import('./rpc-mybatis-extractor.mjs').DubboReferenceEntry[]} */ ([]),
    mqEdges: /** @type {Array<{ topic: string, producerFile: string | null, producerClass: string | null, consumerFile: string, consumerClass: string, consumerGroup: string }>} */ ([]),
    xxlJobs: /** @type {import('./rpc-mybatis-extractor.mjs').XxlJobEntry[]} */ ([]),
    globalComponents: /** @type {import('./vue-template-factory.mjs').GlobalVueComponent[]} */ ([]),
    vueTemplateRefs: /** @type {Record<string, string[]>} */ ({}),
    layoutRoutes: /** @type {Record<string, string>} */ ({}),
    layoutFile: /** @type {string | null} */ (null),
    apiModules: /** @type {Record<string, { prefix: string, exports: Array<{ fnName?: string, method: string, path: string, rawPath: string, generatedBy?: string }> }>} */ ({}),
    controllerChains: /** @type {Record<string, import('./correlator.mjs').ControllerDbChain>} */ ({}),
  };
}

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
  /** @type {Array<import('./registry.mjs').FrontendApiCall & { rawPath?: string, clientFile?: string, clientPrefix?: string, generatedBy?: string }>} */
  const apiCalls = [];
  /** @type {string[]} */
  const imports = [];
  /** @type {string[]} */
  const axiosPrefixes = [];
  /** @type {Record<string, string[]>} */
  const namedImports = {};
  const ctx = { filePath, relFile, ext: path.extname(relFile).toLowerCase(), text, repoDir, fileIndex };

  for (const adapter of getCodeMapAdapters().frontend) {
    const out = adapter.extract(ctx);
    if (!out) continue;
    if (out.routes?.length) routes.push(...out.routes);
    if (out.brokenImports?.length) brokenImports.push(...out.brokenImports);
    if (out.apiCalls?.length) apiCalls.push(...out.apiCalls);
    if (out.imports?.length) imports.push(...out.imports);
    if (out.axiosPrefixes?.length) axiosPrefixes.push(...out.axiosPrefixes);
    const outNamed = /** @type {any} */ (out).namedImports;
    if (outNamed && typeof outNamed === 'object') {
      for (const [k, v] of Object.entries(outNamed)) {
        namedImports[k] = [...new Set([...(namedImports[k] || []), ...(Array.isArray(v) ? v : [])])];
      }
    }
  }
  return { routes, brokenImports, apiCalls, imports: [...new Set(imports)], axiosPrefixes: [...new Set(axiosPrefixes)], namedImports };
}

/** @param {string} relFile @param {string} text */
export function extractBackendAndDbData(relFile, text) {
  /** @type {import('./registry.mjs').BackendEndpoint[]} */
  const endpoints = [];
  /** @type {import('./registry.mjs').DbEntity[]} */
  const entities = [];
  /** @type {import('./correlator.mjs').ExtendedJavaFileMeta | null} */
  let javaMeta = null;
  /** @type {(import('./backend-adapters.mjs').MybatisMapperMeta & { statements?: any[] }) | null} */
  let mybatisMapper = null;
  const ctx = { relFile, ext: path.extname(relFile).toLowerCase(), text };
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

/** @param {string} repoDir @param {number} maxScanFiles @param {string} repoPrefix */
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

  const part = createEmptySourceIndex(repoDir, [normalizeSlash(repoDir)]);
  part.fileCount = walked.files.length;
  part.truncated = walked.truncated;
  part.warnings = warnings;
  /** @type {Record<string, import('./vue-template-factory.mjs').AxiosWrapperInfo>} */
  const wrapperInfoByFile = {};
  /** @type {import('./vue-template-factory.mjs').CrudFactoryDef[]} */
  const crudFactoryDefs = [];
  /** @type {Array<{ relFile: string, text: string }>} */
  const crudCallerFiles = [];
  /** @type {Array<{ relFile: string, templateTags: string[], localComponents: Record<string, string>, identifierToFile: Map<string, string> }>} */
  const rawVueTemplates = [];
  /** @type {Array<{ relFile: string, text: string }>} */
  const prefixConfigBuffers = [];
  /** @type {import('./spring-prefix-resolver.mjs').JavaConstDecl[]} */
  const javaConstDecls = [];
  /** @type {Array<{ relFile: string, stripped: string }>} */
  const feignBuffers = [];
  /** @type {Array<{ relFile: string, stripped: string }>} */
  const javaCallBuffers = [];
  /** @type {Array<{ relFile: string, stripped: string }>} */
  const rpcSignalBuffers = [];

  for (const filePath of walked.files) {
    let stat;
    try { stat = fs.statSync(filePath); } catch { continue; }
    if (stat.size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    const bareRel = normalizeSlash(path.relative(repoDir, filePath));
    const relFile = applyPrefix(repoPrefix, bareRel);
    const ext = path.extname(bareRel).toLowerCase();

    if (VIEW_FILE_RE.test(bareRel)) part.viewFiles.push(relFile);
    if (!part.layoutFile && /^(?:src\/)?layout\/index\.vue$/i.test(bareRel)) part.layoutFile = relFile;

    if (ext === '.java' || ext === '.kt') {
      const stripped = stripJavaComments(text);
      if (/\bString\s+[A-Za-z_$][A-Za-z0-9_$]*\s*=/.test(stripped)) javaConstDecls.push(extractJavaStringConstants(relFile, stripped));
      if (SPRING_PREFIX_HINT_RE.test(stripped)) prefixConfigBuffers.push({ relFile, text });
      if (/@FeignClient\b/.test(stripped)) feignBuffers.push({ relFile, stripped });
      else if (/\b[A-Z][A-Za-z0-9_$]*(?:Api|Client|Feign)\s+[a-z_$]/.test(stripped)) javaCallBuffers.push({ relFile, stripped });
      if (RPC_SIGNAL_HINT_RE.test(stripped)) rpcSignalBuffers.push({ relFile, stripped });
    } else if (SPRING_CFG_FILE_RE.test(path.basename(bareRel))) {
      prefixConfigBuffers.push({ relFile, text });
    }

    if (FRONTEND_EXTS.has(ext)) {
      const fe = extractFrontendData(filePath, bareRel, text, repoDir, fileIndex);
      for (const r of fe.routes) {
        if (r.kind === 'router-layout') part.layoutRoutes[r.route] = applyPrefix(repoPrefix, r.file);
        else part.frontendRoutes.push({ ...r, file: applyPrefix(repoPrefix, r.file) });
      }
      for (const b of fe.brokenImports) {
        part.brokenRouteImports.push({ ...b, routerFile: applyPrefix(repoPrefix, b.routerFile), expectedFile: b.expectedFile ? applyPrefix(repoPrefix, b.expectedFile) : null });
      }
      for (const c of fe.apiCalls) {
        part.frontendApiCalls.push({ ...c, file: relFile, ...(c.clientFile ? { clientFile: applyPrefix(repoPrefix, c.clientFile) } : {}) });
      }
      if (fe.imports.length > 0) part.frontendImports[relFile] = fe.imports.map((imp) => applyPrefix(repoPrefix, imp));
      if (Object.keys(fe.namedImports).length > 0) {
        part.frontendNamedImports[relFile] = Object.fromEntries(Object.entries(fe.namedImports).map(([k, v]) => [applyPrefix(repoPrefix, k), v]));
      }
      const wrapInfo = extractAxiosWrapperInfo({ filePath, relFile: bareRel, text, repoDir, fileIndex, resolveImportCandidate });
      if (wrapInfo) {
        wrapperInfoByFile[relFile] = { ...wrapInfo, delegatesToFile: wrapInfo.delegatesToFile ? applyPrefix(repoPrefix, wrapInfo.delegatesToFile) : null };
      }
      const factoryDef = extractCrudFactoryDefinition({ filePath, relFile: bareRel, text, repoDir, fileIndex, resolveImportCandidate });
      if (factoryDef) {
        crudFactoryDefs.push({ ...factoryDef, clientFile: factoryDef.clientFile ? applyPrefix(repoPrefix, factoryDef.clientFile) : null, sourceFile: relFile });
      } else if (/\bcreateCrudApi\s*\(/.test(text)) {
        crudCallerFiles.push({ relFile, text });
      }
      for (const g of extractGlobalVueComponents({ filePath, relFile: bareRel, text, repoDir, fileIndex, resolveImportCandidate })) {
        part.globalComponents.push({ ...g, file: applyPrefix(repoPrefix, g.file), registeredIn: relFile });
      }
      if (ext === '.vue') {
        const tpl = extractVueTemplateComponents(text);
        if (tpl.templateTags.length > 0) {
          const scriptText = [...text.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');
          const { identifierToSpec } = parseStaticImports(stripJsComments(scriptText));
          /** @type {Map<string, string>} */
          const identifierToFile = new Map();
          for (const [id, spec] of identifierToSpec.entries()) {
            if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('@/')) {
              const chk = resolveImportCandidate(filePath, spec, repoDir, fileIndex);
              if (chk.exists && chk.resolvedRel) identifierToFile.set(id, applyPrefix(repoPrefix, chk.resolvedRel));
            }
          }
          rawVueTemplates.push({ relFile, ...tpl, identifierToFile });
        }
      }
    }

    const be = extractBackendAndDbData(bareRel, text);
    for (const ep of be.endpoints) part.backendEndpoints.push({ ...ep, file: applyPrefix(repoPrefix, ep.file) });
    for (const ent of be.entities) part.dbEntities.push({ ...ent, file: applyPrefix(repoPrefix, ent.file) });
    if (be.endpoints.length > 0) part.backendFileTexts[relFile] = text;
    if (be.javaMeta) part.javaFileInfos[relFile] = { ...be.javaMeta, relFile };
    if (be.mybatisMapper) part.mybatisMappers.push({ ...be.mybatisMapper, file: relFile });
  }

  const chainedPrefixes = resolveChainedAxiosPrefixes(wrapperInfoByFile);
  part.axiosPrefixes = [...new Set(Object.values(chainedPrefixes))];
  for (const caller of crudCallerFiles) {
    part.frontendApiCalls.push(...extractCrudFactoryApiCalls(caller.relFile, caller.text, crudFactoryDefs));
  }
  for (const [f, imps] of Object.entries(part.frontendImports)) {
    const matched = [...new Set(imps.map((imp) => chainedPrefixes[imp]).filter(Boolean))];
    if (matched.length === 1) part.axiosPrefixByFile[f] = matched[0];
  }
  const factoryPref = crudFactoryDefs[0]?.clientFile ? chainedPrefixes[crudFactoryDefs[0].clientFile] : '';
  if (factoryPref) {
    for (const caller of crudCallerFiles) {
      if (!part.axiosPrefixByFile[caller.relFile]) part.axiosPrefixByFile[caller.relFile] = factoryPref;
    }
  }
  for (const call of part.frontendApiCalls) {
    const callPrefix = (call.clientFile && chainedPrefixes[call.clientFile]) || part.axiosPrefixByFile[call.file] || '';
    const rawPath = call.rawPath || call.path;
    call.rawPath = rawPath;
    if (callPrefix) {
      call.clientPrefix = callPrefix;
      if (!call.path.startsWith(`${callPrefix}/`) && call.path !== callPrefix) call.path = normalizeRoutePath(`${callPrefix}${call.path}`);
    }
    if (/(?:^|\/)api\//.test(call.file)) {
      const mod = part.apiModules[call.file] || (part.apiModules[call.file] = { prefix: part.axiosPrefixByFile[call.file] || callPrefix || '', exports: [] });
      mod.exports.push({ ...(call.fnName ? { fnName: call.fnName } : {}), method: call.method, path: call.path, rawPath, ...(call.generatedBy ? { generatedBy: call.generatedBy } : {}) });
    }
  }
  part.vueTemplateRefs = resolveVueTemplateRefs(rawVueTemplates, part.globalComponents);
  return { part, prefixConfigBuffers, javaConstDecls, feignBuffers, javaCallBuffers, rpcSignalBuffers };
}

/**
 * Indexes multiple repositories fairly (each gets its own `maxScanFiles` budget) and merges source graphs.
 * @param {string[]} repos
 * @param {{ maxScanFiles?: number, apiPrefixes?: string[], prefixSingleRepo?: boolean }} [options]
 */
export function indexRepositoriesSource(repos, options = {}) {
  const maxScanFiles = options.maxScanFiles || DEFAULT_PER_REPO_SCAN_FILES;
  const resolved = [...new Set((repos || []).filter(Boolean).map((r) => path.resolve(r)))].filter((r) => fs.existsSync(r));
  const effectiveRepos = resolved.length === 1 && detectMultiRepoRoots(resolved[0]).length >= 2 ? detectMultiRepoRoots(resolved[0]) : resolved;
  const multiMode = effectiveRepos.length > 1 || Boolean(options.prefixSingleRepo);

  const usedLabels = new Set();
  const repoLabels = effectiveRepos.map((r) => {
    if (!multiMode) return '';
    const base = path.basename(r) || 'repo';
    let label = base;
    for (let idx = 2; usedLabels.has(label); idx += 1) label = `${base}-${idx}`;
    usedLabels.add(label);
    return label;
  });

  const acc = createEmptySourceIndex(resolved[0] || '', effectiveRepos.map(normalizeSlash));
  const axiosSet = new Set((options.apiPrefixes || []).map(normalizeRoutePath));
  /** @type {import('./spring-prefix-resolver.mjs').JavaConstDecl[]} */
  const allJavaConstDecls = [];
  /** @type {Array<{ relFile: string, text: string }>} */
  const allPrefixConfigs = [];
  /** @type {Array<{ relFile: string, stripped: string }>} */
  const allFeignBuffers = [];
  /** @type {Array<{ relFile: string, stripped: string }>} */
  const allJavaCallBuffers = [];
  /** @type {Array<{ relFile: string, stripped: string }>} */
  const allRpcBuffers = [];

  effectiveRepos.forEach((repoRoot, idx) => {
    const { part, prefixConfigBuffers, javaConstDecls, feignBuffers, javaCallBuffers, rpcSignalBuffers } = scanSingleRepo(repoRoot, maxScanFiles, repoLabels[idx]);
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
    Object.assign(acc.frontendNamedImports, part.frontendNamedImports);
    Object.assign(acc.axiosPrefixByFile, part.axiosPrefixByFile);
    for (const p of part.axiosPrefixes) axiosSet.add(p);
    Object.assign(acc.javaFileInfos, part.javaFileInfos);
    acc.mybatisMappers.push(...part.mybatisMappers);
    acc.globalComponents.push(...part.globalComponents);
    Object.assign(acc.vueTemplateRefs, part.vueTemplateRefs);
    Object.assign(acc.layoutRoutes, part.layoutRoutes);
    if (!acc.layoutFile && part.layoutFile) acc.layoutFile = part.layoutFile;
    Object.assign(acc.apiModules, part.apiModules);
    allJavaConstDecls.push(...javaConstDecls);
    allPrefixConfigs.push(...prefixConfigBuffers);
    allFeignBuffers.push(...feignBuffers);
    allJavaCallBuffers.push(...javaCallBuffers);
    allRpcBuffers.push(...rpcSignalBuffers);
  });

  const globalJavaConsts = buildJavaConstantTable(allJavaConstDecls);
  for (const cfg of allPrefixConfigs) acc.springPackagePrefixes.push(...extractSpringPrefixRulesFromFile(cfg.relFile, cfg.text, globalJavaConsts));
  acc.springPrefixRules = acc.springPackagePrefixes;
  acc.axiosPrefixes = [...axiosSet];
  attachSpringPackagePrefixes(acc.backendEndpoints, acc.springPackagePrefixes);

  const feignClients = allFeignBuffers.map((b) => extractFeignClientFromFile(b.relFile, b.stripped, globalJavaConsts)).filter((x) => x !== null);
  /** @type {import('./rpc-mybatis-extractor.mjs').MqListenerEntry[]} */
  const mqListeners = [];
  /** @type {import('./rpc-mybatis-extractor.mjs').MqProducerEntry[]} */
  const mqProducers = [];
  for (const rb of allRpcBuffers) {
    const sig = extractRpcAndJobSignals(rb.relFile, rb.stripped, globalJavaConsts);
    acc.dubboServices.push(...sig.dubboServices);
    acc.dubboReferences.push(...sig.dubboReferences);
    mqListeners.push(...sig.mqListeners);
    mqProducers.push(...sig.mqProducers);
    acc.xxlJobs.push(...sig.xxlJobs);
  }
  acc.feignBridges = buildFeignAndDubboBridges(feignClients, acc.javaFileInfos, acc.dubboServices);
  acc.feignMethodCallers = extractFeignMethodCallers(allJavaCallBuffers, acc.feignBridges, acc.javaFileInfos);
  acc.mqEdges = buildMqEdges(mqListeners, mqProducers);
  acc.mybatisXmlLinks = buildMybatisXmlLinks(acc.mybatisMappers, acc.javaFileInfos);

  const dbChain = buildJavaDbChainIndex(acc.javaFileInfos, acc.mybatisMappers, acc.dbEntities, { feignBridges: acc.feignBridges });
  for (const [relFile, meta] of Object.entries(acc.javaFileInfos)) {
    if (meta.isController) acc.controllerChains[relFile] = dbChain.resolveChainForBackendFile(relFile);
  }
  return acc;
}

/**
 * Indexes static routes, API calls, backend endpoints, and DB entities from host repository files (`K-05`).
 * @param {string} repoDir
 * @param {{ maxScanFiles?: number, repos?: string[], apiPrefixes?: string[] }} [options]
 */
export function indexRepositorySource(repoDir, options = {}) {
  const repos = Array.isArray(options.repos) && options.repos.length > 0 ? options.repos : repoDir ? [repoDir] : [];
  if (repos.length === 0 || (!options.repos && (!repoDir || !fs.existsSync(repoDir)))) {
    return createEmptySourceIndex(repoDir || '', []);
  }
  return indexRepositoriesSource(repos, options);
}
