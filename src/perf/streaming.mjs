// @ts-check
import { measureSseEndpoint } from '../core/stream-sse.mjs';
import { redactEndpointUrl } from '../explore/safety.mjs';
import { computeNextRedirectRequest, MAX_REDIRECT_HOPS } from '../kernel/target-redirect.mjs';
import { checkOutgoingRequestSafety } from '../origin-guard.mjs';
import { computeLatencyPercentiles } from './budget.mjs';

/**
 * Benchmarks a streaming `text/event-stream` endpoint under full egress/redirect firewall protection,
 * measuring `ttftMedianMs`, `ttftP95Ms`, `streamTotalP95Ms`, `framesPerStream`, `cleanTerminationRate`,
 * and mid-stream `envelopeErrors` (`WU-C`).
 *
 * @param {string} endpointUrl
 * @param {number} iterations
 * @param {Record<string, any>} [guardConfig]
 * @param {{ method?: string, headers?: Record<string, string>, body?: string | null, timeoutMs?: number }} [options]
 */
export async function runSseStreamBenchmark(endpointUrl, iterations, guardConfig = {}, options = {}) {
  const totalTarget = Math.min(100, Math.max(1, Number(iterations || 5)));
  const method = String(options.method || 'GET').toUpperCase();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs || 20_000));

  /** @type {number[]} */
  const ttftSamples = [];
  /** @type {number[]} */
  const totalSamples = [];
  /** @type {number[]} */
  const frameCounts = [];
  let cleanTerminations = 0;
  let envelopeErrors = 0;
  let errorCount = 0;

  for (let i = 0; i < totalTarget; i += 1) {
    const res = await measureSseEndpoint(endpointUrl, {
      method,
      headers: options.headers,
      body: options.body,
      timeoutMs,
      maxRedirects: MAX_REDIRECT_HOPS,
      validateHop: (m, targetUrl) =>
        checkOutgoingRequestSafety(m, targetUrl, {
          ...guardConfig,
          strictReadonly: method === 'GET' || method === 'HEAD',
        }),
      resolveRedirect: (m, status, location, curUrl, hdrs) =>
        computeNextRedirectRequest(m, status, location, curUrl, hdrs),
    });

    if (res.ttftMs !== null && Number.isFinite(res.ttftMs)) {
      ttftSamples.push(res.ttftMs);
    }
    totalSamples.push(res.totalMs);
    frameCounts.push(res.parsed.frameCount);
    if (res.parsed.cleanTermination) cleanTerminations += 1;
    if (res.parsed.hasEnvelopeError) envelopeErrors += res.parsed.envelopeErrors.length;
    if (!res.ok || res.blocked || res.status >= 500 || res.status === 0) errorCount += 1;
  }

  const ttftStats = computeLatencyPercentiles(ttftSamples);
  const totalStats = computeLatencyPercentiles(totalSamples);
  const avgFrames =
    frameCounts.length > 0
      ? Number((frameCounts.reduce((a, b) => a + b, 0) / frameCounts.length).toFixed(2))
      : 0;

  return {
    endpoint: redactEndpointUrl(endpointUrl),
    method,
    totalStreams: totalTarget,
    errorCount,
    envelopeErrors,
    ttftMedianMs: ttftStats.count > 0 ? ttftStats.p50Ms : null,
    ttftP95Ms: ttftStats.count > 0 ? ttftStats.p95Ms : null,
    streamTotalP95Ms: totalStats.count > 0 ? totalStats.p95Ms : null,
    framesPerStream: avgFrames,
    cleanTerminationRate: Number((cleanTerminations / totalTarget).toFixed(4)),
    ttftStats,
    totalStats,
  };
}
