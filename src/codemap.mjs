// @ts-check
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { WORKBENCH_VERSION } from './core/version.mjs';
import {
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
import {
  getGraphProvider,
  listGraphProviders,
  queryGraphComposite,
  registerGraphProvider,
  resolveGraphSnapshot,
  unregisterGraphProvider,
} from './codemap/providers/registry.mjs';
import { generateLivingSystemMapMarkdown, syncImpactMapFromCodeMap } from './codemap/reporter.mjs';
import { buildCompositeCodeMapQuery, resolveCodeMapInputs, syncLivingCodeMap } from './codemap/sync.mjs';

export {
  buildCompositeCodeMapQuery,
  createRoutePatternMatcher,
  generateLivingSystemMapMarkdown,
  getGraphProvider,
  indexQaSpecs,
  indexRepositoriesSource,
  indexRepositorySource,
  listCodeMapAdapters,
  listGraphProviders,
  matchRuntimeRouteToPattern,
  mergeLivingCodeMap,
  migrateCodeMapSchema,
  normalizeRoutePath,
  queryGraphComposite,
  registerCodeMapAdapter,
  registerGraphProvider,
  resolveCodeMapInputs,
  resolveGraphSnapshot,
  syncImpactMapFromCodeMap,
  syncLivingCodeMap,
  unregisterCodeMapAdapter,
  unregisterGraphProvider,
};

/**
 * CLI handler for `aitw map` (CodeMap v5 + Graph Impact Index + optional composite query).
 * @param {{
 *   lang?: string,
 *   target?: string,
 *   qaDir?: string,
 *   repo?: string | string[],
 *   repos?: string[],
 *   maxScanFiles?: number,
 *   engine?: string,
 *   query?: string,
 *   noSyncImpact?: boolean,
 *   force?: boolean,
 *   dryRun?: boolean,
 *   json?: boolean,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runMapCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {string} msg @param {{ blockerKind?: string | null, recoverySteps?: string[], nextRecommendedActions?: string[] }} [meta] */
  const failMap = (msg, meta = {}) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'map',
        outcome: 'fail',
        ok: false,
        exitCode: 1,
        recoverable: true,
        blockerKind: meta.blockerKind ?? null,
        recoverySteps: meta.recoverySteps || [],
        nextRecommendedActions: meta.nextRecommendedActions || meta.recoverySteps || [],
        summary: msg,
        data: { error: msg },
      }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) {
    return failMap(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option', {
      blockerKind: 'USAGE_ERROR',
      recoverySteps: [
        lang === 'zh'
          ? `请传入 --target <业务仓库路径>: npx ai-test-workbench@${WORKBENCH_VERSION} map --target <repo>`
          : `Pass --target <repo-path>: npx ai-test-workbench@${WORKBENCH_VERSION} map --target <repo>`,
      ],
      nextRecommendedActions: ['Run "aitw map --target <repo-path> --json".'],
    });
  }

  const resolvedTarget = path.resolve(options.target);
  const qaDir = resolveQaDirectory(resolvedTarget, options.qaDir);
  if (!qaDir) {
    return failMap(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`, {
      blockerKind: 'WORKSPACE_NOT_INITIALIZED',
      recoverySteps: [
        lang === 'zh'
          ? `请先初始化 QA 工作区: npx ai-test-workbench@${WORKBENCH_VERSION} init --target "${resolvedTarget}"`
          : `Initialize QA workspace first: npx ai-test-workbench@${WORKBENCH_VERSION} init --target "${resolvedTarget}"`,
      ],
      nextRecommendedActions: [`Run "aitw init --target ${resolvedTarget}" or call aitest_bootstrap(target) before "aitw map".`],
    });
  }

  const out = await syncLivingCodeMap(qaDir, {
    lang,
    repo: options.repo,
    repos: options.repos,
    maxScanFiles: options.maxScanFiles,
    engine: options.engine,
    query: options.query,
    syncImpact: !options.noSyncImpact,
    skipWriteIfUnchanged: options.force ? false : true,
    force: Boolean(options.force),
  });

  if (!options.json) {
    for (const w of out.warnings || []) console.warn(`[CodeMap WARN] ${w}`);
    const ge = out.graphEngine || { provider: 'builtin', mode: 'builtin-fallback' };
    console.log(
      lang === 'zh'
        ? `\n[CodeMap v5] 活体代码知识图谱已更新至 Revision #${out.revision} (引擎=${ge.provider}/${ge.mode})：共 ${out.coverage.totalRoutes} 条活跃路由，覆盖 ${out.coverage.coveredRoutes} 条 (${out.coverage.coveragePct}%)，API ${out.apisCount} 个，调用链 ${out.serviceChainsCount} 条，开放缺陷 ${out.openDefects} 项。`
        : `\n[CodeMap v5] Living Code Map updated to Revision #${out.revision} (engine=${ge.provider}/${ge.mode}): ${out.coverage.coveredRoutes}/${out.coverage.totalRoutes} active routes covered (${out.coverage.coveragePct}%), ${out.apisCount} APIs, ${out.serviceChainsCount} service chains, ${out.openDefects} open defect(s).`
    );
    console.log(`  JSON Knowledge : ${out.codeMapPath}`);
    console.log(`  System Map MD  : ${out.systemMapMdPath}`);
    console.log(`  Graph Index    : ${out.graphImpactIndexPath}`);
    if (out.queryResult) {
      console.log(
        `  Composite Query("${out.queryResult.query}"): routes=${out.queryResult.matchedRoutes.length}, apis=${out.queryResult.matchedApis.length}, chains=${out.queryResult.matchedServiceChains.length}, symbols=${out.queryResult.symbols.length}`
      );
    }
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'map',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary: `Living Code Map v5 synced rev #${out.revision} (${out.coverage.coveredRoutes}/${out.coverage.totalRoutes} routes, ${out.coverage.coveragePct}%, engine=${out.graphEngine?.mode || 'builtin-fallback'})`,
      data: out,
    }),
    { asJson: Boolean(options.json) }
  );
}
