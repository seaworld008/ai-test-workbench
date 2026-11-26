// @ts-check
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolvePlaywrightPackage } from '../core/playwright-resolve.mjs';
import { redactSecrets } from '../core/redact.mjs';
import { compareParityCheckpoints } from '../kernel/diff-oracle.mjs';
import { computeNextRedirectRequest, MAX_REDIRECT_HOPS, REDIRECT_STATUSES } from '../kernel/target-redirect.mjs';
import {
  DEFAULT_BLOCKED_ENDPOINTS,
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  evaluateTargetSafety,
  loadMergedQaEnv,
} from '../origin-guard.mjs';

/**
 * Validates BOTH `baselineUrl` and `candidateUrl` against Target Safety Guard fail-closed.
 * @param {string} qaDir
 * @param {string} baselineUrl
 * @param {string} candidateUrl
 */
export function validateDualTargetSafety(qaDir, baselineUrl, candidateUrl) {
  const baseEnv = loadMergedQaEnv(qaDir, { ...process.env, TEST_BASE_URL: baselineUrl });
  const candEnv = loadMergedQaEnv(qaDir, { ...process.env, TEST_BASE_URL: candidateUrl });
  const baseSafety = evaluateTargetSafety(baseEnv);
  const candSafety = evaluateTargetSafety(candEnv);
  /** @type {string[]} */
  const errors = [];
  if (!baseSafety.ok || !baseSafety.baseURL) {
    errors.push(...(baseSafety.errors.length > 0 ? baseSafety.errors : ['baselineUrl failed target safety validation']).map((e) => `[Baseline] ${e}`));
  }
  if (!candSafety.ok || !candSafety.baseURL) {
    errors.push(...(candSafety.errors.length > 0 ? candSafety.errors : ['candidateUrl failed target safety validation']).map((e) => `[Candidate] ${e}`));
  }
  if (errors.length > 0) {
    return { ok: false, errors, baseGuard: null, candGuard: null };
  }

  const mkGuard = (/** @type {typeof baseSafety} */ s, /** @type {Record<string, string | undefined>} */ env) => ({
    baseURL: s.baseURL,
    allowedHosts: s.allowedHosts,
    allowedOrigins: s.allowedOrigins,
    deniedOrigins: s.deniedOrigins,
    extraEgressHosts: s.extraEgressHosts,
    egressMode: s.egressMode || 'allowlist',
    blockedRules: compileBlockedEndpointRules(env.TEST_BLOCKED_ENDPOINTS ?? DEFAULT_BLOCKED_ENDPOINTS),
    strictReadonly: false,
  });

  return {
    ok: true,
    errors: /** @type {string[]} */ ([]),
    baseGuard: mkGuard(baseSafety, baseEnv),
    candGuard: mkGuard(candSafety, candEnv),
  };
}

/**
 * Executes a single HTTP or SSE request with 10-hop manual redirect validation (`maxRedirects: 0` per hop).
 * @param {string} baseUrl
 * @param {import('./normalizer.mjs').ParityRequestItem} reqItem
 * @param {Record<string, any>} guardConfig
 * @param {number} timeoutMs
 */
async function executeSampleRequest(baseUrl, reqItem, guardConfig, timeoutMs) {
  let curMethod = String(reqItem.method || 'GET').toUpperCase();
  let curUrl = new URL(reqItem.path || '/', baseUrl).toString();
  /** @type {Record<string, string>} */
  let curHeaders = { ...(reqItem.headers || {}) };
  let curBody =
    curMethod === 'GET' || curMethod === 'HEAD' || reqItem.body === null || reqItem.body === undefined
      ? undefined
      : typeof reqItem.body === 'string'
        ? reqItem.body
        : JSON.stringify(reqItem.body);
  if (curBody !== undefined && !Object.keys(curHeaders).some((k) => k.toLowerCase() === 'content-type')) {
    curHeaders['content-type'] = 'application/json';
  }

  const ac = new AbortController();
  const tid = setTimeout(() => ac.abort(new Error('Parity request timed out')), timeoutMs);
  const t0 = performance.now();
  try {
    /** @type {Response | null} */
    let finalRes = null;
    for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
      const check = checkOutgoingRequestSafety(curMethod, curUrl, guardConfig);
      if (check.blocked) {
        return {
          blocked: true,
          blockedReason: check.reason || 'Blocked by outgoing request guard',
          status: 0,
          headers: /** @type {Record<string, string>} */ ({}),
          bodyText: '',
          durationMs: Number((performance.now() - t0).toFixed(2)),
          ttftMs: null,
          isSse: false,
        };
      }
      const res = await fetch(curUrl, {
        method: curMethod,
        headers: curHeaders,
        body: curBody,
        redirect: 'manual',
        signal: ac.signal,
      });
      const loc = res.headers.get('location');
      if (REDIRECT_STATUSES.has(res.status) && loc) {
        if (hop >= MAX_REDIRECT_HOPS) {
          return {
            blocked: true,
            blockedReason: `Exceeded ${MAX_REDIRECT_HOPS} redirect hops`,
            status: res.status,
            headers: Object.fromEntries(res.headers.entries()),
            bodyText: '',
            durationMs: Number((performance.now() - t0).toFixed(2)),
            ttftMs: null,
            isSse: false,
          };
        }
        const next = computeNextRedirectRequest(curMethod, res.status, loc, curUrl, curHeaders);
        curMethod = next.method;
        curUrl = next.url;
        curHeaders = next.headers;
        if (curMethod === 'GET' || curMethod === 'HEAD') curBody = undefined;
        continue;
      }
      finalRes = res;
      break;
    }

    if (!finalRes) {
      throw new Error('No HTTP response received');
    }

    const headers = Object.fromEntries(finalRes.headers.entries());
    const isSse = /text\/event-stream/i.test(headers['content-type'] || '');
    let bodyText = '';
    /** @type {number | null} */
    let ttftMs = null;

    if (isSse && finalRes.body) {
      const reader = finalRes.body.getReader();
      const decoder = new TextDecoder('utf-8');
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value || value.byteLength === 0) continue;
        const piece = decoder.decode(value, { stream: true });
        bodyText += piece;
        if (ttftMs === null && piece.trim().length > 0) {
          ttftMs = Number((performance.now() - t0).toFixed(2));
        }
      }
      bodyText += decoder.decode();
    } else {
      bodyText = await finalRes.text();
    }

    return {
      blocked: false,
      blockedReason: null,
      status: finalRes.status,
      headers,
      bodyText,
      durationMs: Number((performance.now() - t0).toFixed(2)),
      ttftMs,
      isSse,
    };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Optionally collects dual-target browser ARIA snapshots & runtime errors (`CP4-DOM-ARIA-And-Runtime`).
 * @param {string} qaDir
 * @param {string} baseUrl
 * @param {string} candUrl
 * @param {string[]} routes
 * @param {Record<string, any>} baseGuard
 * @param {Record<string, any>} candGuard
 */
async function collectAriaSnapshotsForRoutes(qaDir, baseUrl, candUrl, routes, baseGuard, candGuard) {
  const pwPkg = resolvePlaywrightPackage(qaDir);
  if (!pwPkg || routes.length === 0) return new Map();

  const { chromium } = await import(pathToFileURL(pwPkg).href);
  const browser = await chromium.launch({ headless: true });
  /** @type {Map<string, { base: { ariaSnapshot: string, pageErrors: string[], serverErrors: string[] }, cand: { ariaSnapshot: string, pageErrors: string[], serverErrors: string[] } }>} */
  const out = new Map();

  /** @param {string} targetOrigin @param {string} rPath @param {Record<string, any>} guardCfg */
  const sampleOne = async (targetOrigin, rPath, guardCfg) => {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    /** @type {string[]} */ const pageErrors = [];
    /** @type {string[]} */ const serverErrors = [];
    await context.route('**/*', async (/** @type {any} */ route) => {
      const req = route.request();
      const chk = checkOutgoingRequestSafety(req.method(), req.url(), guardCfg);
      if (chk.blocked) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', (/** @type {any} */ e) => pageErrors.push(String(e?.message || e)));
    page.on('response', (/** @type {any} */ r) => {
      if (r.status() >= 500) serverErrors.push(`${r.status()} ${r.url()}`);
    });
    try {
      await page.goto(new URL(rPath, targetOrigin).toString(), { waitUntil: 'load', timeout: 15_000 });
      const ariaSnapshot = await page.locator('body').ariaSnapshot();
      return { ariaSnapshot, pageErrors, serverErrors };
    } finally {
      await context.close();
    }
  };

  try {
    for (const rPath of routes.slice(0, 10)) {
      const [base, cand] = await Promise.all([
        sampleOne(baseUrl, rPath, baseGuard),
        sampleOne(candUrl, rPath, candGuard),
      ]);
      out.set(rPath, { base, cand });
    }
  } finally {
    await browser.close();
  }
  return out;
}

/**
 * Concurrently executes dual-target differential verification across all samples (`CP1..CP5`),
 * returning cohort-stratified match statistics and deduplicated shape-fingerprint clusters.
 * @param {{
 *   qaDir: string;
 *   baselineUrl: string;
 *   candidateUrl: string;
 *   requests: import('./normalizer.mjs').ParityRequestItem[];
 *   baseGuard: Record<string, any>;
 *   candGuard: Record<string, any>;
 *   policy: ReturnType<import('./normalizer.mjs').resolveParityPolicy>;
 *   concurrency?: number;
 *   timeoutMs?: number;
 *   checkAria?: boolean;
 * }} params
 */
export async function executeParitySuite(params) {
  const tStart = performance.now();
  const requests = params.requests || [];
  const concurrency = Math.min(32, Math.max(1, Number(params.concurrency || 8)));
  const timeoutMs = Math.max(1000, Number(params.timeoutMs || 15_000));
  const isShapeOnly = params.policy.privacyMode === 'shape-only';

  const ariaRoutes = params.checkAria
    ? [...new Set(requests.filter((r) => r.method === 'GET').map((r) => r.path.split('?')[0]))]
    : [];
  const ariaMap = params.checkAria
    ? await collectAriaSnapshotsForRoutes(params.qaDir, params.baselineUrl, params.candidateUrl, ariaRoutes, params.baseGuard, params.candGuard)
    : new Map();

  /** @type {Array<{ index: number, id: string, routePattern: string, featureCohort: string[], blocked?: boolean, blockedReason?: string, cmp?: ReturnType<typeof compareParityCheckpoints> }>} */
  const results = new Array(requests.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < requests.length) {
      const idx = cursor;
      cursor += 1;
      if (idx >= requests.length) break;
      const reqItem = requests[idx];
      const routePattern = `${reqItem.method} ${reqItem.path.split('?')[0]}`;
      const [baseRes, candRes] = await Promise.all([
        executeSampleRequest(params.baselineUrl, reqItem, params.baseGuard, timeoutMs),
        executeSampleRequest(params.candidateUrl, reqItem, params.candGuard, timeoutMs),
      ]);
      if (baseRes.blocked || candRes.blocked) {
        results[idx] = {
          index: idx,
          id: reqItem.id,
          routePattern,
          featureCohort: reqItem.featureCohort,
          blocked: true,
          blockedReason: baseRes.blockedReason || candRes.blockedReason || 'Blocked by egress guard',
        };
        continue;
      }
      const ariaRec = ariaMap.get(reqItem.path.split('?')[0]);
      const cmp = compareParityCheckpoints(
        {
          routePattern,
          method: reqItem.method,
          path: reqItem.path,
          status: baseRes.status,
          headers: baseRes.headers,
          bodyText: baseRes.bodyText,
          durationMs: baseRes.durationMs,
          ttftMs: baseRes.ttftMs,
          isSse: baseRes.isSse,
          featureCohort: reqItem.featureCohort,
          ...(ariaRec ? ariaRec.base : {}),
        },
        {
          routePattern,
          method: reqItem.method,
          path: reqItem.path,
          status: candRes.status,
          headers: candRes.headers,
          bodyText: candRes.bodyText,
          durationMs: candRes.durationMs,
          ttftMs: candRes.ttftMs,
          isSse: candRes.isSse,
          featureCohort: reqItem.featureCohort,
          ...(ariaRec ? ariaRec.cand : {}),
        },
        {
          normalizePaths: params.policy.normalizePaths,
          includeDefaultNormalizePaths: false,
          strictByteEscape: params.policy.strictByteEscape,
          maxLatencyRatio: params.policy.maxLatencyRatio,
          maxTtftRatio: params.policy.maxTtftRatio,
          privacyMode: params.policy.privacyMode,
          routePattern,
          featureCohort: reqItem.featureCohort,
        }
      );
      results[idx] = { index: idx, id: reqItem.id, routePattern, featureCohort: reqItem.featureCohort, cmp };
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, requests.length)) }, () => worker()));

  const blockedHits = results.filter((r) => r?.blocked);
  if (blockedHits.length > 0) {
    return {
      ok: false,
      blocked: true,
      errors: blockedHits.map((b) => `[Parity Guard Blocked] ${b.routePattern}: ${b.blockedReason}`),
      totalSamples: requests.length,
      matchedSamples: 0,
      mismatchedSamples: 0,
      parityPct: 0,
      cohortStats: {},
      clusters: [],
      perfWarnings: [],
      elapsedMs: Number((performance.now() - tStart).toFixed(2)),
    };
  }

  let matchedSamples = 0;
  let mismatchedSamples = 0;
  /** @type {Record<string, { total: number, matched: number, mismatched: number, parityPct: number }>} */
  const cohortStats = {};
  /** @type {Map<string, any>} */
  const clusterMap = new Map();
  /** @type {any[]} */
  const perfWarnings = [];

  for (const r of results) {
    if (!r?.cmp) continue;
    const ok = r.cmp.matched;
    if (ok) matchedSamples += 1;
    else mismatchedSamples += 1;

    const cohorts = r.featureCohort.length > 0 ? r.featureCohort : ['default'];
    for (const tag of cohorts) {
      const bucket = cohortStats[tag] || { total: 0, matched: 0, mismatched: 0, parityPct: 100 };
      bucket.total += 1;
      if (ok) bucket.matched += 1;
      else bucket.mismatched += 1;
      bucket.parityPct = Number(((bucket.matched / bucket.total) * 100).toFixed(2));
      cohortStats[tag] = bucket;
    }

    if (r.cmp.perfWarnings.length > 0) {
      perfWarnings.push(...r.cmp.perfWarnings.map((w) => ({ sampleId: r.id, ...w })));
    }

    if (!ok && r.cmp.primaryMismatch) {
      const m = r.cmp.primaryMismatch;
      const fpId = m.fingerprint.fingerprintId;
      const existing = clusterMap.get(fpId);
      if (existing) {
        existing.count += 1;
        existing.sampleIds.push(r.id);
      } else {
        clusterMap.set(fpId, {
          clusterId: `cls_${fpId.slice(3)}`,
          fingerprintId: fpId,
          checkpoint: m.checkpoint,
          diffKind: m.diffKind,
          routePattern: m.routePattern,
          pieceOrJsonPath: m.pieceOrJsonPath,
          firstDiffByteOffset: m.firstDiffByteOffset,
          baselineByteLen: m.baselineByteLen,
          candidateByteLen: m.candidateByteLen,
          featureCohort: m.fingerprint.featureCohort,
          count: 1,
          sampleIds: [r.id],
          minimalSampleId: r.id,
          baselinePreview: isShapeOnly ? null : m.baselinePreview !== null ? redactSecrets(m.baselinePreview) : null,
          candidatePreview: isShapeOnly ? null : m.candidatePreview !== null ? redactSecrets(m.candidatePreview) : null,
        });
      }
    }
  }

  const clusters = [...clusterMap.values()].sort((a, b) => b.count - a.count || a.fingerprintId.localeCompare(b.fingerprintId));
  const totalSamples = results.length;
  const parityPct = totalSamples > 0 ? Number(((matchedSamples / totalSamples) * 100).toFixed(2)) : 100;

  return {
    ok: mismatchedSamples === 0,
    blocked: false,
    errors: /** @type {string[]} */ ([]),
    totalSamples,
    matchedSamples,
    mismatchedSamples,
    parityPct,
    cohortStats,
    clusters,
    perfWarnings,
    elapsedMs: Number((performance.now() - tStart).toFixed(2)),
  };
}
