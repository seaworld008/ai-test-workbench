// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { WORKBENCH_VERSION } from './core/version.mjs';
import {
  detectCorpusFormat,
  extractFeatureCohort,
  importTrafficCorpus,
  stripExternalOriginToRelativePath,
} from './corpus/importer.mjs';

export {
  detectCorpusFormat,
  extractFeatureCohort,
  importTrafficCorpus,
  stripExternalOriginToRelativePath,
};

/**
 * CLI handler for `corpus --action import --target <repo> --from <file> [--format auto|har|jsonl|otel]`.
 * @param {{
 *   lang?: string;
 *   target?: string;
 *   qaDir?: string;
 *   action?: string;
 *   from?: string;
 *   format?: string;
 *   output?: string;
 *   allowMutation?: boolean;
 *   dryRun?: boolean;
 *   json?: boolean;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runCorpusCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  const action = String(options.action || 'import').toLowerCase();

  /** @param {number} exitCode @param {string} msg @param {'fail' | 'usage'} [outcome] */
  const failOut = (exitCode, msg, outcome = exitCode === 64 ? 'usage' : 'fail') => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'corpus',
        outcome,
        ok: false,
        exitCode,
        summary: msg,
        blockerKind: exitCode === 64 ? 'USAGE_ERROR' : null,
        data: { error: msg },
      }),
      { asJson, compatSpreadData: false }
    );
  };

  if (action !== 'import') {
    return failOut(64, `Unsupported corpus action "${action}". Allowed: import.`, 'usage');
  }
  if (!options.target) {
    return failOut(64, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option', 'usage');
  }
  if (!options.from) {
    return failOut(64, lang === 'zh' ? '缺少 --from <file> 参数' : 'Missing --from <file> option', 'usage');
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    return failOut(1, lang === 'zh' ? `未在 ${options.target} 找到 QA 目录` : `QA directory not found under ${options.target}`);
  }

  const fromPath = path.resolve(options.from);
  if (!fs.existsSync(fromPath)) {
    return failOut(1, lang === 'zh' ? `语料源文件不存在: ${fromPath}` : `Corpus source file not found: ${fromPath}`);
  }

  const formatOpt = String(options.format || 'auto').toLowerCase();
  if (!['auto', 'har', 'jsonl', 'otel'].includes(formatOpt)) {
    return failOut(64, `Invalid --format "${options.format}". Allowed: auto | har | jsonl | otel.`, 'usage');
  }

  const res = importTrafficCorpus({
    qaDir,
    fromPath,
    format: formatOpt,
    outputPath: options.output,
    allowMutation: Boolean(options.allowMutation),
    dryRun: Boolean(options.dryRun),
  });

  const governanceApproveCmd = `npx ai-test-workbench@${WORKBENCH_VERSION} governance approve --target "${path.dirname(qaDir)}" --by <human> --reason "Lock sanitized golden corpus"`;
  const summary = `Imported ${res.importedCount} sanitized ${res.format.toUpperCase()} request(s) (filtered=${res.filteredCount})`;

  if (!asJson) {
    console.log(
      lang === 'zh'
        ? `[Corpus] 已导入 ${res.importedCount} 条脱敏 ${res.format.toUpperCase()} 样本（过滤高危 ${res.filteredCount} 条）${res.outputPath ? `: ${res.outputPath}` : ' (dry-run)'}`
        : `[Corpus] ${summary}${res.outputPath ? `: ${res.outputPath}` : ' (dry-run)'}`
    );
    if (!options.dryRun) {
      console.log(
        lang === 'zh'
          ? `  [提示] corpus/** 受 Layer 0 治理锁保护；请由人类确认脱敏内容后执行:\n    ${governanceApproveCmd}`
          : `  [Notice] corpus/** is protected by Layer 0 governance.lock; have a human seal it via:\n    ${governanceApproveCmd}`
      );
    }
  }

  return emitCommandResult(
    buildCommandResult({
      tool: 'corpus',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary,
      data: {
        format: res.format,
        totalRead: res.totalRead,
        importedCount: res.importedCount,
        filteredCount: res.filteredCount,
        cohortCounts: res.cohortCounts,
        outputPath: res.outputPath,
        dryRun: Boolean(options.dryRun),
        governanceReminder: governanceApproveCmd,
      },
      nextRecommendedActions: [governanceApproveCmd],
    }),
    { asJson }
  );
}
