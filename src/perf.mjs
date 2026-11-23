// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolveQaDirectory } from './agents.mjs';
import { syncLivingCodeMap } from './codemap.mjs';
import { redactEndpointUrl } from './explore.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';

const DEFAULT_BUDGET = {
  browser: {
    maxTtfbMs: 1500,
    maxFcpMs: 2500,
    maxLcpMs: 4000,
    maxInpMs: 500,
    maxCls: 0.25,
    maxDomNodes: 5000,
    maxJsHeapMb: 256,
    maxDuplicateApisPerRoute: 1,
    maxRegressionRatio: 0.25,
  },
  api: {
    maxP95Ms: 1500,
    maxP99Ms: 3000,
    maxErrorRate: 0.01,
  },
};

/**
 * Computes percentile latency metrics (P50 / P75 / P90 / P95 / P99 / avg / min / max) from millisecond samples.
 * @param {number[]} samplesMs
 */
export function computeLatencyPercentiles(samplesMs) {
  const clean = (samplesMs || []).filter((n) => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  if (clean.length === 0) {
    return { count: 0, minMs: 0, p50Ms: 0, p75Ms: 0, p90Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0, avgMs: 0 };
  }
  const pick = (pct) => clean[Math.min(clean.length - 1, Math.max(0, Math.ceil((pct / 100) * clean.length) - 1))];
  const sum = clean.reduce((a, b) => a + b, 0);
  return {
    count: clean.length,
    minMs: Number(clean[0].toFixed(2)),
    p50Ms: Number(pick(50).toFixed(2)),
    p75Ms: Number(pick(75).toFixed(2)),
    p90Ms: Number(pick(90).toFixed(2)),
    p95Ms: Number(pick(95).toFixed(2)),
    p99Ms: Number(pick(99).toFixed(2)),
    maxMs: Number(clean[clean.length - 1].toFixed(2)),
    avgMs: Number((sum / clean.length).toFixed(2)),
  };
}

/**
 * Evaluates collected browser CDP Web Vitals & concurrent API latency against `<qaDir>/perf-budget.json`
 * plus optional relative baseline regression check (`P-01`, `P-02`).
 */
export function evaluatePerfBudget(report, budgetInput = DEFAULT_BUDGET, baselineSnapshot = null) {
  const budget = {
    browser: { ...DEFAULT_BUDGET.browser, ...(budgetInput?.browser || {}) },
    api: { ...DEFAULT_BUDGET.api, ...(budgetInput?.api || {}) },
  };
  const violations = [];

  for (const bm of report?.browserMetrics || []) {
    if (bm.ttfbMs != null && bm.ttfbMs > budget.browser.maxTtfbMs) {
      violations.push(`[Browser SLO] ${bm.route} TTFB=${bm.ttfbMs}ms exceeds maxTtfbMs=${budget.browser.maxTtfbMs}ms`);
    }
    if (bm.fcpMs != null && bm.fcpMs > budget.browser.maxFcpMs) {
      violations.push(`[Browser SLO] ${bm.route} FCP=${bm.fcpMs}ms exceeds maxFcpMs=${budget.browser.maxFcpMs}ms`);
    }
    if (bm.lcpMs != null && bm.lcpMs > budget.browser.maxLcpMs) {
      violations.push(`[Browser SLO] ${bm.route} LCP=${bm.lcpMs}ms exceeds maxLcpMs=${budget.browser.maxLcpMs}ms`);
    }
    if (bm.inpMs != null && bm.inpMs > budget.browser.maxInpMs) {
      violations.push(`[Browser SLO] ${bm.route} INP=${bm.inpMs}ms exceeds maxInpMs=${budget.browser.maxInpMs}ms`);
    }
    if (bm.cls != null && bm.cls > budget.browser.maxCls) {
      violations.push(`[Browser SLO] ${bm.route} CLS=${bm.cls} exceeds maxCls=${budget.browser.maxCls}`);
    }
    if (bm.domNodes != null && bm.domNodes > budget.browser.maxDomNodes) {
      violations.push(`[Browser SLO] ${bm.route} DOMNodes=${bm.domNodes} exceeds maxDomNodes=${budget.browser.maxDomNodes}`);
    }
    if (bm.jsHeapMb != null && bm.jsHeapMb > budget.browser.maxJsHeapMb) {
      violations.push(`[Browser SLO] ${bm.route} JSHeap=${bm.jsHeapMb}MB exceeds maxJsHeapMb=${budget.browser.maxJsHeapMb}MB`);
    }
    if (bm.duplicateApisCount != null && bm.duplicateApisCount > budget.browser.maxDuplicateApisPerRoute) {
      violations.push(
        `[Waterfall SLO] ${bm.route} triggered ${bm.duplicateApisCount} duplicate API call(s) (budget=${budget.browser.maxDuplicateApisPerRoute})`
      );
    }

    if (baselineSnapshot?.browserSummary) {
      const prev = baselineSnapshot.browserSummary.find((p) => p.route === bm.route);
      if (prev?.lcpMs && bm.lcpMs && prev.lcpMs >= 100) {
        const ratio = (bm.lcpMs - prev.lcpMs) / prev.lcpMs;
        if (ratio > budget.browser.maxRegressionRatio && bm.lcpMs - prev.lcpMs > 150) {
          violations.push(
            `[Relative Regression] ${bm.route} LCP regressed +${Math.round(ratio * 100)}% (${prev.lcpMs}ms -> ${bm.lcpMs}ms)`
          );
        }
      }
    }
  }

  const api = report?.apiBenchmark;
  if (api && api.totalRequests > 0) {
    if (api.p95Ms > budget.api.maxP95Ms) {
      violations.push(`[API SLO] P95=${api.p95Ms}ms exceeds maxP95Ms=${budget.api.maxP95Ms}ms`);
    }
    if (api.p99Ms > budget.api.maxP99Ms) {
      violations.push(`[API SLO] P99=${api.p99Ms}ms exceeds maxP99Ms=${budget.api.maxP99Ms}ms`);
    }
    if (api.errorRate > budget.api.maxErrorRate) {
      violations.push(`[API SLO] errorRate=${api.errorRate} exceeds maxErrorRate=${budget.api.maxErrorRate}`);
    }
  }

  return { ok: violations.length === 0, violations, budget };
}

function loadPlaywrightPkg(qaDir) {
  for (const rel of ['playwright/index.mjs', '@playwright/test/index.mjs']) {
    const p = path.join(qaDir, 'node_modules', ...rel.split('/'));
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

function medianOfNullable(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  return valid[Math.floor((valid.length - 1) / 2)];
}

function p75OfNullable(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  return valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(0.75 * valid.length) - 1))];
}

/**
 * Profiles routes in Chromium using pre-injected `PerformanceObserver({ buffered: true })` for real LCP / CLS / INP (`P-01`),
 * plus multi-sample median/P75 aggregation and optional CDP CPU throttling (`P-02`).
 */
export async function runBrowserPerfProfile(qaDir, baseURL, routes, options = {}) {
  const pwPkg = loadPlaywrightPkg(qaDir);
  if (!pwPkg) return [];

  const samplesPerRoute = Math.min(7, Math.max(1, Number(options.samples || 2)));
  const cpuSlowdownRate = options.throttle ? 4 : 1;

  const { chromium } = await import(pathToFileURL(pwPkg).href);
  const browser = await chromium.launch({ headless: true });
  const userAuthPath = path.join(qaDir, 'playwright', '.auth', 'user.json');
  const sessionAuthPath = path.join(qaDir, 'playwright', '.auth', 'session.json');
  const sessionData = readJsonSafe(sessionAuthPath);
  const metricsList = [];

  try {
    /** @type {Record<string, any>} */
    const ctxOpts = { viewport: { width: 1440, height: 900 } };
    if (readJsonSafe(userAuthPath)) ctxOpts.storageState = userAuthPath;
    const context = await browser.newContext(ctxOpts);

    // Pre-register PerformanceObserver BEFORE navigation so buffered LCP, CLS, FCP & INP are always captured (`P-01`)!
    await context.addInitScript(
      ({ sessionPayload }) => {
        if (sessionPayload?.origin && Array.isArray(sessionPayload.entries) && window.location.origin === sessionPayload.origin) {
          for (const [k, v] of sessionPayload.entries) window.sessionStorage.setItem(k, v);
        }

        const anyWin = /** @type {any} */ (window);
        anyWin.__aitestWebVitals = {
          lcpMs: null,
          fcpMs: null,
          cls: 0,
          inpMs: null,
        };

        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              const anyEntry = /** @type {any} */ (e);
              const ts = anyEntry.renderTime || anyEntry.loadTime || e.startTime;
              if (typeof ts === 'number') {
                anyWin.__aitestWebVitals.lcpMs = Math.round(ts);
              }
            }
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          // ignore if unsupported
        }

        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              if (e.name === 'first-contentful-paint') {
                anyWin.__aitestWebVitals.fcpMs = Math.round(e.startTime);
              }
            }
          }).observe({ type: 'paint', buffered: true });
        } catch {
          // ignore
        }

        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              const anyShift = /** @type {any} */ (e);
              if (!anyShift.hadRecentInput && typeof anyShift.value === 'number') {
                anyWin.__aitestWebVitals.cls += anyShift.value;
              }
            }
          }).observe({ type: 'layout-shift', buffered: true });
        } catch {
          // ignore
        }

        try {
          new PerformanceObserver((list) => {
            for (const e of list.getEntries()) {
              const anyEv = /** @type {any} */ (e);
              if (anyEv.interactionId && typeof e.duration === 'number') {
                anyWin.__aitestWebVitals.inpMs = Math.max(anyWin.__aitestWebVitals.inpMs ?? 0, Math.round(e.duration));
              }
            }
          }).observe(/** @type {any} */ ({ type: 'event', durationThreshold: 16, buffered: true }));
        } catch {
          // ignore
        }
      },
      { sessionPayload: sessionData }
    );

    const page = await context.newPage();
    let cdp = null;
    try {
      cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      if (cpuSlowdownRate > 1) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpuSlowdownRate });
      }
    } catch {
      cdp = null;
    }

    for (const rPath of routes) {
      const targetUrl = new URL(rPath, baseURL).toString();
      const sampleRuns = [];
      let lastDuplicateApis = [];
      let lastSlowestApis = [];

      for (let sIdx = 0; sIdx < samplesPerRoute; sIdx += 1) {
        const apiCounts = new Map();
        const apiDurations = [];

        const onRes = (res) => {
          const rt = res.request().resourceType();
          if (rt === 'xhr' || rt === 'fetch') {
            const clean = redactEndpointUrl(res.url()).split('?')[0];
            apiCounts.set(clean, (apiCounts.get(clean) || 0) + 1);
            const timing = res.request().timing();
            if (timing && timing.responseEnd > 0 && timing.requestTime >= 0) {
              apiDurations.push({ endpoint: clean, status: res.status(), ms: Math.round(timing.responseEnd) });
            }
          }
        };
        page.on('response', onRes);

        try {
          await page.goto(targetUrl, { waitUntil: 'load', timeout: 25_000 });
        } catch {
          // evaluate whatever rendered
        }

        // Trigger a tiny synthetic pointer/focus tick & double-rAF so Chromium flushes pending LCP candidate
        try {
          await page.mouse.move(10, 10);
        } catch {
          // ignore
        }

        const navMetrics = await page.evaluate(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const anyWin = /** @type {any} */ (window);
          let vitals = anyWin.__aitestWebVitals || { lcpMs: null, fcpMs: null, cls: 0, inpMs: null };

          // Secondary buffered PerformanceObserver check if LCP candidate flushed right on rAF
          if (vitals.lcpMs === null) {
            await new Promise((resolve) => {
              try {
                const obs = new PerformanceObserver((list) => {
                  for (const e of list.getEntries()) {
                    const anyE = /** @type {any} */ (e);
                    const ts = anyE.renderTime || anyE.loadTime || e.startTime;
                    if (typeof ts === 'number') vitals.lcpMs = Math.round(ts);
                  }
                });
                obs.observe({ type: 'largest-contentful-paint', buffered: true });
                setTimeout(() => {
                  obs.disconnect();
                  resolve(null);
                }, 100);
              } catch {
                resolve(null);
              }
            });
          }

          const browserPerf = /** @type {any} */ (globalThis.performance);
          const nav = browserPerf.getEntriesByType('navigation')[0];
          const paints = browserPerf.getEntriesByType('paint') || [];
          const fcp = paints.find((p) => p.name === 'first-contentful-paint');
          const resources = browserPerf.getEntriesByType('resource') || [];
          const transferBytes = resources.reduce((sum, r) => sum + (r.transferSize || 0), 0);

          return {
            ttfbMs: nav ? Math.round(nav.responseStart) : null,
            domReadyMs: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
            loadMs: nav ? Math.round(nav.loadEventEnd) : null,
            fcpMs: vitals.fcpMs ?? (fcp ? Math.round(fcp.startTime) : null),
            lcpMs: vitals.lcpMs,
            inpMs: vitals.inpMs,
            cls: Number((vitals.cls || 0).toFixed(4)),
            domNodes: document.getElementsByTagName('*').length,
            transferKb: Math.round(transferBytes / 1024),
          };
        });

        let jsHeapMb = null;
        if (cdp) {
          try {
            const { metrics } = await cdp.send('Performance.getMetrics');
            const heap = metrics.find((m) => m.name === 'JSHeapUsedSize');
            if (heap) jsHeapMb = Number((heap.value / (1024 * 1024)).toFixed(2));
          } catch {
            // ignore unsupported CDP metric
          }
        }

        page.off('response', onRes);
        lastDuplicateApis = [...apiCounts.entries()]
          .filter(([, cnt]) => cnt >= 2)
          .map(([ep, count]) => ({ endpoint: ep, count }));
        apiDurations.sort((a, b) => b.ms - a.ms);
        lastSlowestApis = apiDurations.slice(0, 5);

        sampleRuns.push({ ...navMetrics, jsHeapMb });
      }

      const lastSample = sampleRuns[sampleRuns.length - 1];
      metricsList.push({
        route: rPath,
        samples: sampleRuns.length,
        ttfbMs: medianOfNullable(sampleRuns.map((s) => s.ttfbMs)),
        domReadyMs: medianOfNullable(sampleRuns.map((s) => s.domReadyMs)),
        loadMs: medianOfNullable(sampleRuns.map((s) => s.loadMs)),
        fcpMs: medianOfNullable(sampleRuns.map((s) => s.fcpMs)),
        lcpMs: medianOfNullable(sampleRuns.map((s) => s.lcpMs)),
        lcpP75Ms: p75OfNullable(sampleRuns.map((s) => s.lcpMs)),
        inpMs: medianOfNullable(sampleRuns.map((s) => s.inpMs)),
        cls: medianOfNullable(sampleRuns.map((s) => s.cls)) ?? 0,
        domNodes: lastSample.domNodes,
        transferKb: lastSample.transferKb,
        jsHeapMb: medianOfNullable(sampleRuns.map((s) => s.jsHeapMb)),
        duplicateApisCount: lastDuplicateApis.length,
        duplicateApis: lastDuplicateApis,
        slowestApis: lastSlowestApis,
      });
    }
  } finally {
    await browser.close();
  }

  return metricsList;
}

async function runReadOnlyApiBenchmark(endpointUrl, concurrency, iterations) {
  const latencies = [];
  let errors = 0;
  let issued = 0;
  const wallStart = performance.now();

  const worker = async () => {
    while (issued < iterations) {
      const myIdx = issued;
      issued += 1;
      if (myIdx >= iterations) break;
      const t0 = performance.now();
      try {
        const res = await fetch(endpointUrl, { method: 'GET', redirect: 'follow' });
        await res.arrayBuffer();
        latencies.push(performance.now() - t0);
        if (res.status >= 500) errors += 1;
      } catch {
        latencies.push(performance.now() - t0);
        errors += 1;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const wallSec = Math.max(0.001, (performance.now() - wallStart) / 1000);
  const stats = computeLatencyPercentiles(latencies);

  return {
    endpoint: redactEndpointUrl(endpointUrl),
    method: 'GET',
    concurrency,
    totalRequests: latencies.length,
    errorCount: errors,
    errorRate: latencies.length > 0 ? Number((errors / latencies.length).toFixed(4)) : 0,
    rps: Number((latencies.length / wallSec).toFixed(2)),
    ...stats,
  };
}

function buildPerfMarkdown(report, lang = 'zh') {
  const isZh = lang === 'zh';
  const lines = [
    isZh ? '# AI 性能与全链路 SLO 基线报告 (`perf`)' : '# AI Performance & SLO Baseline Report (`perf`)',
    '',
    `- **Target**: \`${report.baseURL}\` · **Measured At**: \`${report.measuredAt}\` · **Mode**: \`${report.mode}\` · **Budget Gate**: \`${report.budgetPassed ? 'PASS' : 'WARN/FAIL'}\``,
    '',
  ];

  if (report.browserMetrics.length > 0) {
    lines.push(
      isZh ? '## 1. 真实浏览器 CDP / Web Vitals 指标 (PerformanceObserver 中位数)' : '## 1. Browser CDP & Web Vitals Metrics (PerformanceObserver Median)',
      '| Route | Samples | TTFB (ms) | FCP (ms) | LCP (ms) | LCP P75 | CLS | INP (ms) | DOM Nodes | JS Heap (MB) | Duplicate APIs |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
    );
    for (const m of report.browserMetrics) {
      lines.push(
        `| \`${m.route}\` | ${m.samples ?? 1} | ${m.ttfbMs ?? '-'} | ${m.fcpMs ?? '-'} | ${m.lcpMs ?? '-'} | ${m.lcpP75Ms ?? '-'} | ${m.cls ?? '-'} | ${m.inpMs ?? '-'} | ${m.domNodes ?? '-'} | ${m.jsHeapMb ?? '-'} | ${m.duplicateApisCount ?? 0} |`
      );
    }
    lines.push('');
  }

  if (report.apiBenchmark) {
    const a = report.apiBenchmark;
    lines.push(
      isZh ? '## 2. 只读并发 API 压测基准' : '## 2. Concurrent Read-Only API Benchmark',
      `- Endpoint: \`GET ${a.endpoint}\` (concurrency=\`${a.concurrency}\`, requests=\`${a.totalRequests}\`)`,
      `- Throughput: **${a.rps} req/s** · Error Rate: \`${(a.errorRate * 100).toFixed(2)}%\``,
      `- Latency: Min=\`${a.minMs}ms\` · P50=\`${a.p50Ms}ms\` · P75=\`${a.p75Ms}ms\` · P90=\`${a.p90Ms}ms\` · **P95=\`${a.p95Ms}ms\`** · P99=\`${a.p99Ms}ms\` · Max=\`${a.maxMs}ms\``,
      ''
    );
  }

  lines.push(isZh ? '## 3. 性能预算告警与违约项' : '## 3. Budget Violations & Advisories');
  if (report.violations.length === 0) {
    lines.push(isZh ? '- 所有测试指标均符合 `perf-budget.json` SLO 阈值。' : '- All measured metrics satisfy `perf-budget.json` SLO thresholds.');
  } else {
    for (const v of report.violations) lines.push(`- ${v}`);
  }
  lines.push('');
  return lines.join('\n');
}

export async function runPerfCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

  /** @type {Record<string, string>} */
  const overrides = {};
  if (options.baseUrl) overrides.TEST_BASE_URL = options.baseUrl;
  const mergedEnv = loadMergedQaEnv(qaDir, { ...process.env, ...overrides });
  const safety = evaluateTargetSafety(mergedEnv);
  if (!safety.ok || !safety.baseURL) {
    const errs = safety.errors.length > 0 ? safety.errors : ['TEST_BASE_URL is required for perf.'];
    for (const err of errs) console.error(`[Target Guard Blocked] ${err}`);
    return 2;
  }

  const mode = (options.mode || 'all').toLowerCase();
  if (!['all', 'browser', 'api'].includes(mode)) {
    console.error(`Invalid --mode "${mode}". Use: all | browser | api`);
    return 1;
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

  const browserMetrics =
    mode === 'api'
      ? []
      : await runBrowserPerfProfile(qaDir, safety.baseURL, routes, {
          samples: options.samples,
          throttle: Boolean(options.throttle),
        });

  let apiBenchmark = null;
  if (mode !== 'browser') {
    const concurrency = Math.min(20, Math.max(1, Number(options.concurrency || 4)));
    const iterations = Math.min(200, Math.max(1, Number(options.iterations || 12)));
    const ep = options.endpoint || mergedEnv.E2E_API_HEALTH_PATH || '/';
    const epUrl = new URL(ep, safety.baseURL).toString();
    apiBenchmark = await runReadOnlyApiBenchmark(epUrl, concurrency, iterations);
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

  if (!options.dryRun) {
    const reportsDir = path.join(qaDir, 'reports');
    fs.mkdirSync(reportsDir, { recursive: true });
    const jsonPath = path.join(reportsDir, 'perf-report.json');
    const mdPath = path.join(reportsDir, 'perf-summary.md');
    fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(mdPath, buildPerfMarkdown(report, lang), 'utf8');

    if (fs.existsSync(path.join(qaDir, 'knowledge', 'code-map.json'))) {
      syncLivingCodeMap(qaDir, { lang, syncImpact: false });
    }

    if (options.json) {
      console.log(JSON.stringify({ jsonPath, mdPath, ...report }, null, 2));
    } else {
      console.log(
        lang === 'zh'
          ? `\n[Perf] 性能探测完成 (Browser 路由=${browserMetrics.length}, LCP=${browserMetrics[0]?.lcpMs ?? '-'}ms, API P95=${apiBenchmark?.p95Ms ?? '-'}ms, RPS=${apiBenchmark?.rps ?? '-'})`
          : `\n[Perf] Benchmark complete (routes=${browserMetrics.length}, LCP=${browserMetrics[0]?.lcpMs ?? '-'}ms, API P95=${apiBenchmark?.p95Ms ?? '-'}ms, RPS=${apiBenchmark?.rps ?? '-'})`
      );
      console.log(`  Perf JSON    : ${jsonPath}`);
      console.log(`  Perf Summary : ${mdPath}`);
      for (const v of evalOut.violations) console.warn(`  [PERF WARN] ${v}`);
    }
  } else if (options.json) {
    console.log(JSON.stringify({ dryRun: true, ...report }, null, 2));
  }

  if (options.enforceBudget && !evalOut.ok) {
    return 1;
  }
  return 0;
}
