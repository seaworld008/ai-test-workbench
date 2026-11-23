import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { runAuditForQaDir } from './audit.mjs';
import { computeImpact } from './impact.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import { resolvePlaywrightCli, runPlaywright } from './proc.mjs';

export function buildSuitePlaywrightArgs(suite, options = {}) {
  const s = (suite || 'smoke').toLowerCase();
  const args = [];

  switch (s) {
    case 'smoke':
      args.push('--project=smoke');
      break;
    case 'e2e':
      args.push('--project=e2e');
      break;
    case 'api':
      args.push('--project=api');
      break;
    case 'seed':
      args.push('--project=seed');
      break;
    case 'a11y':
      args.push('--project=smoke');
      if (options.hasBaseUrl) args.push('--project=e2e');
      args.push('--grep=@a11y');
      break;
    case 'critical':
      args.push('--project=smoke');
      if (options.hasBaseUrl) {
        args.push('--project=e2e', '--project=api');
      }
      args.push('--grep=@critical|@smoke');
      break;
    case 'all':
      args.push('--project=smoke', '--project=e2e', '--project=api');
      break;
    default:
      throw new Error(`Unknown suite "${suite}". Valid suites: smoke, e2e, api, a11y, critical, seed, impact, all.`);
  }

  return args;
}

export async function runSuiteCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir || !resolvePlaywrightCli(qaDir)) {
    console.error(
      lang === 'zh'
        ? `未在 ${target} 找到已安装依赖的 Playwright QA 目录，请先运行 init。`
        : `Playwright QA directory with installed dependencies not found under ${target}. Run init first.`
    );
    return 1;
  }

  const suite = (options.suite || 'smoke').toLowerCase();
  const overrides = {};
  if (options.baseUrl) overrides.TEST_BASE_URL = options.baseUrl;
  if (options.allowMutation) overrides.TEST_ALLOW_MUTATION = '1';

  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  const safety = evaluateTargetSafety(mergedEnv);

  if (!safety.ok) {
    for (const err of safety.errors) {
      console.error(`[Target Guard Blocked] ${err}`);
    }
    return 2;
  }

  const needsOnlineUrl = ['e2e', 'api', 'seed', 'all'].includes(suite);
  if (needsOnlineUrl && !safety.baseURL) {
    console.error(
      lang === 'zh'
        ? `[配置错误] 运行套件 "${suite}" 必须配置合法的 TEST_BASE_URL（或传入 --base-url），禁止未配 URL 整套 skip 冒充通过。`
        : `[Config Error] Suite "${suite}" requires a valid TEST_BASE_URL (or --base-url); refusing to silently skip.`
    );
    return 2;
  }

  let pwArgs = [];
  if (suite === 'impact') {
    const impact = await computeImpact(target, { qaDir: options.qaDir, base: options.base });
    console.log(`[Impact] ${impact.mode.toUpperCase()}: ${impact.reason}`);
    if (impact.mode === 'targeted') {
      pwArgs.push('test', 'tests/smoke', ...impact.specs, '--project=smoke');
      if (safety.baseURL) {
        pwArgs.push('--project=e2e', '--project=api');
      }
    } else if (impact.mode === 'only-changed' && impact.baseRef) {
      pwArgs.push('test', `--only-changed=${impact.baseRef}`, '--project=smoke');
      if (safety.baseURL) pwArgs.push('--project=e2e', '--project=api');
    } else {
      pwArgs.push('test', '--project=smoke');
      if (safety.baseURL) pwArgs.push('--project=e2e', '--project=api');
    }
  } else {
    pwArgs = ['test', ...buildSuitePlaywrightArgs(suite, { hasBaseUrl: Boolean(safety.baseURL) })];
  }

  if (options.grep) pwArgs.push(`--grep=${options.grep}`);
  if (!safety.allowMutation && suite !== 'seed') {
    pwArgs.push('--grep-invert=@mutation');
  }
  if (options.lastFailed) pwArgs.push('--last-failed');
  if (options.failOnFlaky || options.audit) pwArgs.push('--fail-on-flaky-tests');
  if (options.workers !== undefined) pwArgs.push(`--workers=${options.workers}`);
  if (options.retries !== undefined) pwArgs.push(`--retries=${options.retries}`);
  if (options.headed) pwArgs.push('--headed');
  if (options.ui) pwArgs.push('--ui');
  if (options.debug) pwArgs.push('--debug');

  const runEnv = {
    ...process.env,
    ...overrides,
    AITEST_ACTIVE_SUITE: suite,
  };

  console.log(`[Runner] (${qaDir}) playwright ${pwArgs.join(' ')}`);
  const pwRes = await runPlaywright(qaDir, pwArgs, { env: runEnv, inheritStdio: true });

  if (!options.audit) {
    return pwRes.code;
  }

  const auditOut = runAuditForQaDir(qaDir, {
    checkSpecs: true,
    requireE2e: suite === 'e2e' || suite === 'all',
    allowMutation: safety.allowMutation,
  });

  if (auditOut.stats) {
    console.log(
      `\n[Audit] passed=${auditOut.stats.passed} failed=${auditOut.stats.failed} flaky=${auditOut.stats.flaky} skipped=${auditOut.stats.skipped} policyExcluded(@mutation)=${auditOut.stats.policyExcludedMutations}`
    );
  }
  for (const w of auditOut.warnings) {
    console.warn(`[Audit WARN] ${w}`);
  }
  if (!auditOut.ok) {
    for (const e of auditOut.errors) {
      console.error(`[Audit FAIL] ${e}`);
    }
  } else {
    console.log('[Audit OK] All static & runtime quality gates passed.');
  }

  if (pwRes.code !== 0) {
    return pwRes.code;
  }
  return auditOut.ok ? 0 : 1;
}
