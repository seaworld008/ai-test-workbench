// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { syncLivingCodeMap } from './codemap.mjs';
import { loadWorkbenchConfig } from './core/config.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { loadRuntimeConfig } from './core/runtime-config.mjs';
import {
  DEFAULT_BLOCKED_ENDPOINTS,
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  evaluateTargetSafety,
  loadMergedQaEnv,
} from './origin-guard.mjs';
import {
  DEFAULT_BUDGET,
  buildPerfMarkdown,
  computeLatencyPercentiles,
  evaluatePerfBudget,
} from './perf/budget.mjs';
import { runBrowserPerfProfile, runReadOnlyApiBenchmark } from './perf/collectors.mjs';

export { computeLatencyPercentiles, evaluatePerfBudget, runBrowserPerfProfile };

/** @param {string} p */
function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** @param {Record<string, any>} [options] */
export async function runPerfCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {number} exitCode @param {string} msg @param {'fail' | 'blocked' | 'usage'} [outcome] */
  const failPerf = (exitCode, msg, outcome = exitCode === 2 ? 'blocked' : exitCode === 64 ? 'usage' : 'fail') => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'perf',
        outcome,
        ok: false,
        exitCode,
        summary: msg,
        blockerKind: exitCode === 2 ? 'TARGET_OR_CONFIG_BLOCKED' : exitCode === 64 ? 'USAGE_ERROR' : null,
        data: { error: msg },
      }),
      { asJson, compatSpreadData: false }
    );
  };
  if (!options.target) {
    return failPerf(1, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    return failPerf(1, lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
  }

  const wbCfg = loadWorkbenchConfig({ qaDir });
  if (!wbCfg.ok) {
    return failPerf(2, `[Config Blocked] ${wbCfg.errors.join('; ') || 'Invalid workbench config.'}`, 'blocked');
  }
  const runtimeCfgRes = loadRuntimeConfig(qaDir);
  if (!runtimeCfgRes.ok) {
    return failPerf(2, `[Runtime Config Blocked] ${runtimeCfgRes.errors.join('; ') || 'Invalid aitest.runtime.json.'}`, 'blocked');
  }
  /** @type {Record<string, string>} */
  const overrides = {};
  if (options.baseUrl) overrides.TEST_BASE_URL = options.baseUrl;
  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  if (!mergedEnv.TEST_BASE_URL && runtimeCfgRes.config?.baseURL) {
    mergedEnv.TEST_BASE_URL = runtimeCfgRes.config.baseURL;
  }
  const safety = evaluateTargetSafety(mergedEnv);
  if (!safety.ok || !safety.baseURL) {
    const errs = safety.errors.length > 0 ? safety.errors : ['TEST_BASE_URL is required for perf.'];
    if (!asJson) {
      for (const err of errs) console.error(`[Target Guard Blocked] ${err}`);
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'perf',
        outcome: 'blocked',
        ok: false,
        exitCode: 2,
        summary: `[Target Guard Blocked] ${errs[0]}`,
        blockerKind: 'TARGET_GUARD_BLOCKED',
        data: { error: errs.join('; '), errors: errs },
      }),
      { asJson, compatSpreadData: false }
    );
  }

  const mode = (options.mode || 'all').toLowerCase();
  if (!['all', 'browser', 'api'].includes(mode)) {
    return failPerf(64, `Invalid --mode "${mode}". Use: all | browser | api`, 'usage');
  }

  const existingCm = readJsonSafe(path.join(qaDir, 'knowledge', 'code-map.json'));
  let routes = ['/'];
  if (options.routes) {
    routes = String(options.routes)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  } else if (existingCm?.routes) {
    const extras = Object.keys(existingCm.routes)
      .filter((r) => r !== '/' && !r.includes(':') && !/login|404|403|401/i.test(r))
      .slice(0, 2);
    if (extras.length > 0) routes = ['/', ...extras];
  }

  const perfGuardConfig = {
    baseURL: safety.baseURL,
    allowedHosts: safety.allowedHosts,
    allowedOrigins: safety.allowedOrigins,
    deniedOrigins: safety.deniedOrigins,
    extraEgressHosts: safety.extraEgressHosts,
    egressMode: safety.egressMode || 'allowlist',
    blockedRules: compileBlockedEndpointRules(mergedEnv.TEST_BLOCKED_ENDPOINTS ?? DEFAULT_BLOCKED_ENDPOINTS),
    strictReadonly: true,
  };

  for (const rPath of routes) {
    const resolvedRouteUrl = new URL(rPath, safety.baseURL).toString();
    const rCheck = checkOutgoingRequestSafety('GET', resolvedRouteUrl, perfGuardConfig);
    if (rCheck.blocked) {
      return failPerf(2, `[Target Guard Blocked] Perf route "${rPath}" blocked: ${rCheck.reason}`, 'blocked');
    }
  }

  const browserMetrics =
    mode === 'api'
      ? []
      : await runBrowserPerfProfile(qaDir, safety.baseURL, routes, {
          samples: options.samples,
          throttle: Boolean(options.throttle),
          guardConfig: perfGuardConfig,
        });

  let apiBenchmark = null;
  if (mode !== 'browser') {
    const concurrency = Math.min(20, Math.max(1, Number(options.concurrency || 4)));
    const iterations = Math.min(200, Math.max(1, Number(options.iterations || 12)));
    const ep = options.endpoint || mergedEnv.E2E_API_HEALTH_PATH || '/';
    const epUrl = new URL(ep, safety.baseURL).toString();
    const epCheck = checkOutgoingRequestSafety('GET', epUrl, perfGuardConfig);
    if (epCheck.blocked) {
      return failPerf(2, `[Target Guard Blocked] Perf endpoint "${ep}" blocked: ${epCheck.reason}`, 'blocked');
    }
    apiBenchmark = await runReadOnlyApiBenchmark(epUrl, concurrency, iterations, perfGuardConfig);
  }

  const budgetCfg = readJsonSafe(path.join(qaDir, 'perf-budget.json')) || DEFAULT_BUDGET;
  const prevSnapshots = existingCm?.perfSnapshots || [];
  const lastBaseline = prevSnapshots.length > 0 ? prevSnapshots[prevSnapshots.length - 1] : null;
  const evalOut = evaluatePerfBudget({ browserMetrics, apiBenchmark }, budgetCfg, options.checkRegression ? lastBaseline : null);

  const report = {
    baseURL: safety.baseURL,
    measuredAt: new Date().toISOString(),
    mode,
    readOnly: true,
    budgetPassed: evalOut.ok,
    violations: evalOut.violations,
    browserMetrics,
    apiBenchmark,
  };

  const exitCode = options.enforceBudget && !evalOut.ok ? 1 : 0;
  let jsonPath = null;
  let mdPath = null;

  if (!options.dryRun) {
    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    jsonPath = path.join(reportsDir, 'perf-report.json');
    mdPath = path.join(reportsDir, 'perf-summary.md');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(mdPath, buildPerfMarkdown(report, lang), 'utf8');

    if (fs.existsSync(path.join(qaDir, 'knowledge', 'code-map.json'))) {
      syncLivingCodeMap(qaDir, { lang, syncImpact: false });
    }

    if (!options.json) {
      console.log(
        lang === 'zh'
          ? `\n[Perf] 性能探测完成 (Browser 路由=${browserMetrics.length}, LCP=${browserMetrics[0]?.lcpMs ?? '-'}ms, API P95=${apiBenchmark?.p95Ms ?? '-'}ms, RPS=${apiBenchmark?.rps ?? '-'})`
          : `\n[Perf] Benchmark complete (routes=${browserMetrics.length}, LCP=${browserMetrics[0]?.lcpMs ?? '-'}ms, API P95=${apiBenchmark?.p95Ms ?? '-'}ms, RPS=${apiBenchmark?.rps ?? '-'})`
      );
      console.log(`  Perf JSON    : ${jsonPath}`);
      console.log(`  Perf Summary : ${mdPath}`);
      for (const v of evalOut.violations) console.warn(`  [PERF WARN] ${v}`);
    }
  }

  return emitCommandResult(
    buildCommandResult({
      tool: 'perf',
      outcome: exitCode === 0 ? 'pass' : 'fail',
      ok: exitCode === 0,
      exitCode,
      summary: `Perf benchmark (routes=${browserMetrics.length}, budgetPassed=${evalOut.ok}, LCP=${browserMetrics[0]?.lcpMs ?? '-'}ms, API P95=${apiBenchmark?.p95Ms ?? '-'}ms)`,
      data: {
        ...report,
        ...(options.dryRun ? { dryRun: true } : { jsonPath, mdPath }),
      },
    }),
    { asJson: Boolean(options.json) }
  );
}
