// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { loadAndValidateAitestConfigFile } from './core/config.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import {
  DEFAULT_PER_REPO_SCAN_FILES,
  createRoutePatternMatcher,
  indexQaSpecs,
  indexRepositoriesSource,
  indexRepositorySource,
  listCodeMapAdapters,
  matchRuntimeRouteToPattern,
  normalizeRoutePath,
  registerCodeMapAdapter,
  unregisterCodeMapAdapter,
} from './codemap/adapters.mjs';
import { mergeLivingCodeMap, migrateCodeMapSchema } from './codemap/merger.mjs';
import { generateLivingSystemMapMarkdown, syncImpactMapFromCodeMap } from './codemap/reporter.mjs';

export {
  createRoutePatternMatcher,
  generateLivingSystemMapMarkdown,
  indexQaSpecs,
  indexRepositoriesSource,
  indexRepositorySource,
  listCodeMapAdapters,
  matchRuntimeRouteToPattern,
  mergeLivingCodeMap,
  migrateCodeMapSchema,
  normalizeRoutePath,
  registerCodeMapAdapter,
  syncImpactMapFromCodeMap,
  unregisterCodeMapAdapter,
};

/** @param {string} filePath @returns {any} */
function readJsonOptional(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {string | string[] | undefined} raw @param {string} baseDir @returns {string[]} */
function parseRepoEntries(raw, baseDir) {
  if (!raw) return [];
  const items = Array.isArray(raw) ? raw : [raw];
  /** @type {string[]} */
  const out = [];
  for (const item of items) {
    const s = String(item || '').trim();
    if (!s) continue;
    const direct = path.isAbsolute(s) ? s : path.resolve(baseDir, s);
    if (fs.existsSync(direct)) {
      out.push(direct);
    } else if (s.includes(',')) {
      for (const part of s.split(',').map((p) => p.trim()).filter(Boolean)) {
        out.push(path.isAbsolute(part) ? part : path.resolve(baseDir, part));
      }
    } else {
      out.push(direct);
    }
  }
  return [...new Set(out)];
}

/**
 * Resolves `sourceRepos`, `maxScanFiles`, and `apiPrefixes` without mutating locked `aitest.config.json`.
 * Priority: explicit `options.repos` / `options.repo` / `options.repoDir` -> `aitestConfig.sourceRepos` -> `existingMap.meta.sourceRepos` -> `[path.dirname(qaDir)]`.
 * @param {string} qaDir
 * @param {any} existingMap
 * @param {{ repoDir?: string, repo?: string | string[], repos?: string[], maxScanFiles?: number, apiPrefixes?: string[] }} options
 */
function resolveCodeMapInputs(qaDir, existingMap, options) {
  const defaultRoot = path.dirname(qaDir);
  const cfgRes = loadAndValidateAitestConfigFile(qaDir);
  const cfg = cfgRes.config;

  const explicitRepos = [
    ...parseRepoEntries(options.repos, process.cwd()),
    ...parseRepoEntries(options.repo, process.cwd()),
    ...parseRepoEntries(options.repoDir, process.cwd()),
  ];
  const cfgRepos = (cfg.sourceRepos || []).map((/** @type {string} */ entry) => {
    if (path.isAbsolute(entry)) return entry;
    const fromParent = path.resolve(defaultRoot, entry);
    return fs.existsSync(fromParent) ? fromParent : path.resolve(qaDir, entry);
  });
  const metaRepos = Array.isArray(existingMap?.meta?.sourceRepos)
    ? existingMap.meta.sourceRepos.filter((/** @type {string} */ p) => typeof p === 'string' && fs.existsSync(p))
    : [];

  const sourceRepos = explicitRepos.length > 0
    ? [...new Set(explicitRepos)]
    : cfgRepos.length > 0
      ? [...new Set(cfgRepos)]
      : metaRepos.length > 0
        ? [...new Set(metaRepos)]
        : [defaultRoot];

  const maxScanFiles = options.maxScanFiles || cfg.maxScanFiles || existingMap?.meta?.maxScanFiles || DEFAULT_PER_REPO_SCAN_FILES;
  const apiPrefixes = [...new Set([...(options.apiPrefixes || []), ...(cfg.apiPrefixes || [])])];
  return { sourceRepos, maxScanFiles, apiPrefixes };
}

/**
 * Synchronizes `<qaDir>/knowledge/code-map.json`, `<qaDir>/knowledge/SYSTEM_MAP.md`, and `impact-map.json`.
 * @param {string} qaDir
 * @param {{ lang?: string, repoDir?: string, repo?: string | string[], repos?: string[], maxScanFiles?: number, apiPrefixes?: string[], skipWriteIfUnchanged?: boolean, syncImpact?: boolean | 'force' }} [options]
 */
export function syncLivingCodeMap(qaDir, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const knowledgeDir = path.join(qaDir, 'knowledge');
  const codeMapPath = path.join(knowledgeDir, 'code-map.json');
  const systemMapMdPath = path.join(knowledgeDir, 'SYSTEM_MAP.md');

  const existingMap = readJsonOptional(codeMapPath);
  const { sourceRepos, maxScanFiles, apiPrefixes } = resolveCodeMapInputs(qaDir, existingMap, options);
  const sourceIndex = indexRepositoriesSource(sourceRepos, { maxScanFiles, apiPrefixes });
  const specIndex = indexQaSpecs(qaDir);
  const topology = readJsonOptional(path.join(qaDir, 'reports', 'system-topology.json'));
  const resultsJson = readJsonOptional(path.join(qaDir, 'reports', 'results.json'));
  const perfReport = readJsonOptional(path.join(qaDir, 'reports', 'perf-report.json'));

  const nextMap = mergeLivingCodeMap(existingMap, {
    sourceIndex,
    specIndex,
    topology,
    resultsJson,
    perfReport,
    sourceRepos,
    maxScanFiles,
    apiPrefixes,
  });

  if (options.skipWriteIfUnchanged && existingMap?.contentFingerprint === nextMap.contentFingerprint) {
    return {
      codeMapPath,
      systemMapMdPath,
      revision: existingMap.revision,
      unchanged: true,
      truncated: Boolean(sourceIndex.truncated),
      warnings: sourceIndex.warnings || [],
      coverage: existingMap.coverage,
      impactSync: { manualRulesCount: 0, autoRulesCount: 0 },
      openDefects: (existingMap.defects || []).filter((/** @type {any} */ d) => d.status === 'open').length,
    };
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(codeMapPath, JSON.stringify(nextMap, null, 2) + '\n', 'utf8');
  fs.writeFileSync(systemMapMdPath, generateLivingSystemMapMarkdown(nextMap, lang), 'utf8');

  /** @type {{ manualRulesCount: number, autoRulesCount: number, mode?: string, suggestedPath?: string, autoImpactPath?: string }} */
  let impactSync = { manualRulesCount: 0, autoRulesCount: 0 };
  if (options.syncImpact !== false) {
    const autoImpactPath = path.join(knowledgeDir, 'impact-map.auto.json');
    const autoOut = syncImpactMapFromCodeMap(autoImpactPath, nextMap);

    const impactPath = path.join(qaDir, 'impact-map.json');
    const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
    let impactLocked = false;
    if (fs.existsSync(lockPath)) {
      try {
        const lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        impactLocked = Boolean(lockObj?.files && 'impact-map.json' in lockObj.files);
      } catch {
        impactLocked = true;
      }
    }

    if (impactLocked && options.syncImpact !== 'force') {
      const existing = readJsonOptional(impactPath);
      const manualCount = Array.isArray(existing?.rules) ? existing.rules.filter((/** @type {any} */ r) => !r.autoGenerated).length : 0;
      const suggestedPath = path.join(knowledgeDir, 'impact-map.suggested.json');
      syncImpactMapFromCodeMap(suggestedPath, nextMap);
      impactSync = {
        manualRulesCount: Math.max(manualCount, autoOut.manualRulesCount),
        autoRulesCount: autoOut.autoRulesCount,
        mode: 'auto-union',
        suggestedPath,
        autoImpactPath,
      };
    } else {
      impactSync = { ...syncImpactMapFromCodeMap(impactPath, nextMap), autoImpactPath };
    }
  }

  return {
    codeMapPath,
    systemMapMdPath,
    revision: nextMap.revision,
    unchanged: false,
    truncated: Boolean(sourceIndex.truncated),
    warnings: sourceIndex.warnings || [],
    coverage: nextMap.coverage,
    impactSync,
    openDefects: nextMap.defects.filter((d) => d.status === 'open').length,
  };
}

/**
 * @param {{ lang?: string, target?: string, qaDir?: string, repo?: string | string[], repos?: string[], maxScanFiles?: number, noSyncImpact?: boolean, force?: boolean, dryRun?: boolean, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runMapCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {string} msg */
  const failMap = (msg) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({ tool: 'map', outcome: 'fail', ok: false, exitCode: 1, summary: msg, data: { error: msg } }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) return failMap(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) return failMap(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);

  const out = syncLivingCodeMap(qaDir, {
    lang,
    repo: options.repo,
    repos: options.repos,
    maxScanFiles: options.maxScanFiles,
    syncImpact: !options.noSyncImpact,
    skipWriteIfUnchanged: options.force ? false : true,
  });

  if (!options.json) {
    for (const w of out.warnings || []) console.warn(`[CodeMap WARN] ${w}`);
    console.log(
      lang === 'zh'
        ? `\n[CodeMap] 活体代码知识图谱已更新至 Revision #${out.revision}：共 ${out.coverage.totalRoutes} 条活跃路由，覆盖 ${out.coverage.coveredRoutes} 条 (${out.coverage.coveragePct}%)，开放缺陷 ${out.openDefects} 项。`
        : `\n[CodeMap] Living Code Map updated to Revision #${out.revision}: ${out.coverage.coveredRoutes}/${out.coverage.totalRoutes} active routes covered (${out.coverage.coveragePct}%), ${out.openDefects} open defect(s).`
    );
    console.log(`  JSON Knowledge : ${out.codeMapPath}`);
    console.log(`  System Map MD  : ${out.systemMapMdPath}`);
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'map',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary: `Living Code Map synced rev #${out.revision} (${out.coverage.coveredRoutes}/${out.coverage.totalRoutes} routes, ${out.coverage.coveragePct}%)`,
      data: out,
    }),
    { asJson: Boolean(options.json) }
  );
}
