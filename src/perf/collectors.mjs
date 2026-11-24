// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolvePlaywrightPackage } from '../core/playwright-resolve.mjs';
import { detectEnvelopeBusinessError, redactEndpointUrl } from '../explore/safety.mjs';
import { checkOutgoingRequestSafety } from '../origin-guard.mjs';
import { computeLatencyPercentiles, medianOfNullable, p75OfNullable } from './budget.mjs';

function readJsonSafe(p) {
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Profiles routes in Chromium using pre-injected `PerformanceObserver({ buffered: true })` for real LCP / CLS / INP (`P-01`),
 * plus multi-sample median/P75 aggregation and optional CDP CPU throttling (`P-02`).
 */
export async function runBrowserPerfProfile(qaDir, baseURL, routes, options = {}) {
  const pwPkg = resolvePlaywrightPackage(qaDir);
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

    if (options.guardConfig) {
      await context.route('**/*', async (route) => {
        const req = route.request();
        const check = checkOutgoingRequestSafety(req.method(), req.url(), {
          ...options.guardConfig,
          strictReadonly: true,
        });
        if (check.blocked) {
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });
    }

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

        try {
          await page.mouse.move(10, 10);
        } catch {
          // ignore
        }

        const navMetrics = await page.evaluate(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const anyWin = /** @type {any} */ (window);
          const vitals = anyWin.__aitestWebVitals || { lcpMs: null, fcpMs: null, cls: 0, inpMs: null };

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

export async function runReadOnlyApiBenchmark(endpointUrl, concurrency, iterations) {
  const latencies = [];
  let errors = 0;
  let envelopeErrors = 0;
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
        const contentType = String(res.headers.get('content-type') || '');
        let parsedJson = null;
        if (/application\/json/i.test(contentType)) {
          const text = await res.text();
          try {
            parsedJson = JSON.parse(text);
          } catch {
            // ignore non-JSON body
          }
        } else {
          await res.arrayBuffer();
        }
        latencies.push(performance.now() - t0);
        const envCheck = detectEnvelopeBusinessError(res.status, parsedJson);
        if (res.status >= 500 || (envCheck.isError && Number(envCheck.code) >= 500)) {
          errors += 1;
        }
        if (envCheck.isError && res.status < 500) {
          envelopeErrors += 1;
        }
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
    envelopeErrorCount: envelopeErrors,
    errorRate: latencies.length > 0 ? Number((errors / latencies.length).toFixed(4)) : 0,
    rps: Number((latencies.length / wallSec).toFixed(2)),
    ...stats,
  };
}
