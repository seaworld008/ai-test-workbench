// @ts-check
import { performance } from 'node:perf_hooks';
import { redactSecrets } from '../core/redact.mjs';
import { compareParityCheckpoints, computeShapeFingerprint } from '../kernel/diff-oracle.mjs';
import { collectAriaSnapshotsForRoutes } from './aria.mjs';
import {
  detectAuthOrShellInvalidPair,
  isApiRoutePath,
  loadParityAuthContext,
} from './auth-context.mjs';
import { executeSampleRequest, validateDualTargetSafety } from './transport.mjs';

export { validateDualTargetSafety };

/**
 * Concurrently executes dual-target differential verification across all samples (`CP1..CP5`),
 * returning cohort-stratified match statistics, deduplicated clusters, and fail-closed `AUTH_OR_SHELL_INVALID` detection.
 * @param {{
 *   qaDir: string;
 *   baselineUrl: string;
 *   candidateUrl: string;
 *   baselineApiUrl?: string;
 *   candidateApiUrl?: string;
 *   requests: import('./normalizer.mjs').ParityRequestItem[];
 *   baseGuard: Record<string, any>;
 *   candGuard: Record<string, any>;
 *   baseApiGuard?: Record<string, any> | null;
 *   candApiGuard?: Record<string, any> | null;
 *   policy: ReturnType<import('./normalizer.mjs').resolveParityPolicy>;
 *   authHeaders?: Record<string, string> | string[] | string;
 *   noAuth?: boolean;
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
  const apiPrefixes = params.policy.apiPrefixes || [];

  const authCtx = loadParityAuthContext(params.qaDir, {
    noAuth: params.noAuth,
    authHeaders: params.authHeaders,
    authStorageKeys: params.policy.authStorageKeys,
  });

  const ariaRoutes = params.checkAria
    ? [...new Set(requests.filter((r) => r.method === 'GET').map((r) => r.path.split('?')[0]))]
    : [];
  const ariaMap = params.checkAria
    ? await collectAriaSnapshotsForRoutes(
        params.qaDir,
        params.baselineUrl,
        params.candidateUrl,
        ariaRoutes,
        params.baseGuard,
        params.candGuard,
        { noAuth: params.noAuth, authCtx }
      )
    : new Map();

  /** @type {Array<{ index: number, id: string, routePattern: string, featureCohort: string[], blocked?: boolean, blockedReason?: string, authInvalid?: boolean, authReasonCode?: string, authDetail?: string, baseByteLen?: number, candByteLen?: number, cmp?: ReturnType<typeof compareParityCheckpoints> }>} */
  const results = new Array(requests.length);
  let cursor = 0;

  const worker = async () => {
    while (cursor < requests.length) {
      const idx = cursor;
      cursor += 1;
      if (idx >= requests.length) break;
      const reqItem = requests[idx];
      const routePattern = `${reqItem.method} ${reqItem.path.split('?')[0]}`;
      const isApi = isApiRoutePath(reqItem.path, apiPrefixes);
      const effBaseUrl = isApi && params.baselineApiUrl ? params.baselineApiUrl : params.baselineUrl;
      const effCandUrl = isApi && params.candidateApiUrl ? params.candidateApiUrl : params.candidateUrl;
      const effBaseGuard = isApi && params.baseApiGuard ? params.baseApiGuard : params.baseGuard;
      const effCandGuard = isApi && params.candApiGuard ? params.candApiGuard : params.candGuard;

      const [baseRes, candRes] = await Promise.all([
        executeSampleRequest(effBaseUrl, reqItem, effBaseGuard, timeoutMs, authCtx),
        executeSampleRequest(effCandUrl, reqItem, effCandGuard, timeoutMs, authCtx),
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
      if (params.policy.failOnAuthError !== false) {
        const authCheck = detectAuthOrShellInvalidPair(reqItem, baseRes, candRes, ariaRec, apiPrefixes);
        if (authCheck.invalid) {
          results[idx] = {
            index: idx,
            id: reqItem.id,
            routePattern,
            featureCohort: reqItem.featureCohort,
            authInvalid: true,
            authReasonCode: authCheck.reasonCode || 'AUTH_OR_SHELL_INVALID',
            authDetail: authCheck.detail || 'AUTH_OR_SHELL_INVALID',
            baseByteLen: Buffer.byteLength(baseRes.bodyText || '', 'utf8'),
            candByteLen: Buffer.byteLength(candRes.bodyText || '', 'utf8'),
          };
          continue;
        }
      }

      const cmp = compareParityCheckpoints(
        {
          routePattern, method: reqItem.method, path: reqItem.path,
          status: baseRes.status, headers: baseRes.headers, bodyText: baseRes.bodyText,
          durationMs: baseRes.durationMs, ttftMs: baseRes.ttftMs, isSse: baseRes.isSse,
          featureCohort: reqItem.featureCohort, ...(ariaRec ? ariaRec.base : {}),
        },
        {
          routePattern, method: reqItem.method, path: reqItem.path,
          status: candRes.status, headers: candRes.headers, bodyText: candRes.bodyText,
          durationMs: candRes.durationMs, ttftMs: candRes.ttftMs, isSse: candRes.isSse,
          featureCohort: reqItem.featureCohort, ...(ariaRec ? ariaRec.cand : {}),
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
      authInvalid: false,
      authInvalidCount: 0,
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
  let authInvalidCount = 0;
  /** @type {string[]} */
  const authErrors = [];
  /** @type {Record<string, { total: number, matched: number, mismatched: number, parityPct: number }>} */
  const cohortStats = {};
  /** @type {Map<string, any>} */
  const clusterMap = new Map();
  /** @type {any[]} */
  const perfWarnings = [];

  for (const r of results) {
    if (!r) continue;
    const isAuthInv = Boolean(r.authInvalid);
    const ok = !isAuthInv && Boolean(r.cmp?.matched);
    if (ok) matchedSamples += 1;
    else mismatchedSamples += 1;
    if (isAuthInv) {
      authInvalidCount += 1;
      authErrors.push(`[AUTH_OR_SHELL_INVALID] ${r.routePattern}: ${r.authDetail}`);
    }

    const cohorts = r.featureCohort.length > 0 ? r.featureCohort : ['default'];
    for (const tag of cohorts) {
      const bucket = cohortStats[tag] || { total: 0, matched: 0, mismatched: 0, parityPct: 100 };
      bucket.total += 1;
      if (ok) bucket.matched += 1;
      else bucket.mismatched += 1;
      bucket.parityPct = Number(((bucket.matched / bucket.total) * 100).toFixed(2));
      cohortStats[tag] = bucket;
    }

    if (r.cmp?.perfWarnings?.length) {
      perfWarnings.push(...r.cmp.perfWarnings.map((w) => ({ sampleId: r.id, ...w })));
    }

    if (isAuthInv) {
      const fp = computeShapeFingerprint({
        checkpoint: 'CP1-Status-Headers',
        routePattern: r.routePattern,
        pieceOrJsonPath: `auth.${r.authReasonCode || 'invalid'}`,
        firstDiffByteOffset: 0,
        baselineByteLen: r.baseByteLen || 0,
        candidateByteLen: r.candByteLen || 0,
        diffKind: 'AUTH_OR_SHELL_INVALID',
        featureCohort: r.featureCohort,
      });
      const existing = clusterMap.get(fp.fingerprintId);
      if (existing) {
        existing.count += 1;
        existing.sampleIds.push(r.id);
      } else {
        clusterMap.set(fp.fingerprintId, {
          clusterId: `cls_${fp.fingerprintId.slice(3)}`,
          fingerprintId: fp.fingerprintId,
          checkpoint: 'CP1',
          reason: 'AUTH_OR_SHELL_INVALID',
          diffKind: 'AUTH_OR_SHELL_INVALID',
          routePattern: r.routePattern,
          pieceOrJsonPath: `auth.${r.authReasonCode || 'invalid'}`,
          firstDiffByteOffset: 0,
          baselineByteLen: r.baseByteLen || 0,
          candidateByteLen: r.candByteLen || 0,
          featureCohort: fp.featureCohort,
          count: 1,
          sampleIds: [r.id],
          minimalSampleId: r.id,
          baselinePreview: isShapeOnly ? null : r.authDetail || null,
          candidatePreview: isShapeOnly ? null : r.authDetail || null,
        });
      }
    } else if (!ok && r.cmp?.primaryMismatch) {
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
    ok: mismatchedSamples === 0 && authInvalidCount === 0,
    blocked: false,
    authInvalid: authInvalidCount > 0,
    authInvalidCount,
    errors: authErrors,
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
