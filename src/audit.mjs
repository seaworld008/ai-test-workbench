import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { loadMergedQaEnv } from './origin-guard.mjs';
import {
  analyzeHealerDiffText,
  auditResultsJson,
  isCoveredByWaiver,
  loadAitestConfig,
  loadAndValidateWaivers,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
} from '../templates/playwright-qa/scripts/audit-results.mjs';

export {
  analyzeHealerDiffText,
  auditResultsJson,
  isCoveredByWaiver,
  loadAitestConfig,
  loadAndValidateWaivers,
  runAuditForQaDir,
  runGitDiffGuard,
  runStaticSpecChecks,
  scanSpecFilesFallback,
};

export async function runAuditCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未在 ${target} 找到 QA 目录` : `QA directory not found at ${target}`);
    return 1;
  }

  const mergedEnv = loadMergedQaEnv(qaDir);
  const allowMutation = mergedEnv.TEST_ALLOW_MUTATION === '1' || mergedEnv.TEST_ALLOW_MUTATION === 'true';

  const res = runAuditForQaDir(qaDir, {
    resultsPath: options.results,
    waiversPath: options.waivers,
    checkSpecs: Boolean(options.checkSpecs),
    requireE2e: Boolean(options.requireE2e),
    staticOnly: Boolean(options.staticOnly),
    maxFlaky: options.maxFlaky,
    maxSkipped: options.maxSkipped,
    diffBase: options.diffBase,
    allowMutation,
  });

  if (options.json) {
    console.log(JSON.stringify(res, null, 2));
    return res.ok ? 0 : 1;
  }

  console.log(`\n=== ${lang === 'zh' ? '防假绿质量门禁审计 (audit)' : 'Anti-Fake-Green Quality Gate (audit)'} ===`);
  if (res.stats) {
    console.log(
      `Stats: passed=${res.stats.passed}, failed=${res.stats.failed}, flaky=${res.stats.flaky}, skipped=${res.stats.skipped}, policyExcluded(@mutation)=${res.stats.policyExcludedMutations}`
    );
  }
  for (const item of res.policyExcludedTitles) {
    console.log(`  [POLICY-EXCLUDED @mutation] ${item}`);
  }
  for (const w of res.warnings) {
    console.warn(`[WARN] ${w}`);
  }
  if (!res.ok) {
    for (const e of res.errors) {
      console.error(`[FAIL] ${e}`);
    }
    return 1;
  }
  console.log(`[OK] ${lang === 'zh' ? '质量门禁全部通过' : 'All quality gates passed'}.\n`);
  return 0;
}
