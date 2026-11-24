// @ts-check

export const DEFAULT_BUDGET = {
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

export function medianOfNullable(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  if (valid.length % 2 === 1) return valid[mid];
  return Number(((valid[mid - 1] + valid[mid]) / 2).toFixed(2));
}

export function p75OfNullable(nums) {
  const valid = nums.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (valid.length === 0) return null;
  return valid[Math.min(valid.length - 1, Math.max(0, Math.ceil(0.75 * valid.length) - 1))];
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

export function buildPerfMarkdown(report, lang = 'zh') {
  const isZh = lang === 'zh';
  const lines = [
    isZh ? '# AI 性能与全链路 SLO 基线报告 (`perf`)' : '# AI Performance & SLO Baseline Report (`perf`)',
    '',
    `- **Target**: \`${report.baseURL}\` · **Measured At**: \`${report.measuredAt}\` · **Mode**: \`${report.mode}\` · **Budget Gate**: \`${report.budgetPassed ? 'PASS' : 'WARN/FAIL'}\``,
    '',
  ];

  if (report.browserMetrics.length > 0) {
    lines.push(
      isZh
        ? '## 1. 真实浏览器 CDP / Web Vitals 指标 (PerformanceObserver 中位数)'
        : '## 1. Browser CDP & Web Vitals Metrics (PerformanceObserver Median)',
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
