// @ts-check
import { redactSecrets } from '../core/redact.mjs';
import { MAX_REDIRECT_HOPS, REDIRECT_STATUSES, computeNextRedirectRequest } from '../kernel/target-redirect.mjs';
import { evaluateExploreRequestSafety } from '../origin-guard.mjs';
import {
  detectEnvelopeBusinessError,
  detectUrlQueryAnomalies,
  isSuspectedReadQueryPostUrl,
  redactEndpointUrl,
  shouldSilentlyAbortThirdPartyHost,
} from './safety.mjs';

/**
 * Installs read-only network/WebSocket/sendBeacon firewalls and attaches console/response
 * telemetry observers onto a Playwright browser context and page.
 * @param {{ context: any, safety: any, guardConfig: any, sessionData: any, topology: any, entryPath: string }} params
 */
export async function attachExploreObservers({ context, safety, guardConfig, sessionData, topology, entryPath }) {
  /** @type {Set<string>} */
  const blockedApiHostSet = new Set();
  let firewallAbortCount = 0;
  /** @type {Map<string, { depth: number, ts: number }>} */
  const redirectHopTracker = new Map();

  // Block non-allowlisted WebSockets during exploration (`E-05`)
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', (/** @type {any} */ ws) => {
      if (shouldSilentlyAbortThirdPartyHost(ws.url(), guardConfig)) {
        firewallAbortCount += 1;
        void ws.close({ code: 1008, reason: 'Third-party host aborted silently' });
        return;
      }
      const check = evaluateExploreRequestSafety('GET', ws.url(), null, guardConfig);
      if (check.blocked) {
        if (topology.blockedWriteRequests.length < 50) {
          topology.blockedWriteRequests.push({
            method: 'WS',
            endpoint: redactEndpointUrl(ws.url()),
            reason: check.reason,
          });
        }
        void ws.close({ code: 1008, reason: 'Blocked by Explore Firewall' });
        return;
      }
      ws.connectToServer();
    });
  }

  // Block sendBeacon writes, refresh numeric idle timestamps in localStorage, & restore optional sessionStorage
  await context.addInitScript(
    (/** @type {{ sessionPayload: any }} */ { sessionPayload }) => {
      if (navigator && typeof navigator.sendBeacon === 'function') {
        navigator.sendBeacon = () => false;
      }
      if (sessionPayload?.origin && Array.isArray(sessionPayload.entries) && window.location.origin === sessionPayload.origin) {
        for (const [k, v] of sessionPayload.entries) {
          window.sessionStorage.setItem(k, v);
        }
      }
      try {
        const nowStr = String(Date.now());
        for (const k of ['lastRecordTime', 'lastActiveTime']) {
          const cur = window.localStorage.getItem(k);
          if (cur !== null && /^\d+$/.test(cur.trim())) {
            window.localStorage.setItem(k, nowStr);
          }
        }
      } catch {
        // ignore storage access restrictions on opaque origins
      }
    },
    { sessionPayload: sessionData }
  );

  await context.route('**/*', async (/** @type {any} */ route) => {
    const req = route.request();
    const curMethod = typeof req.method === 'function' ? req.method().toUpperCase() : 'GET';
    const curUrl = typeof req.url === 'function' ? req.url() : '';
    const curBody = typeof req.postData === 'function' ? req.postData() || null : null;
    const curHeaders = typeof req.headers === 'function' ? { ...req.headers() } : {};
    const resourceType = typeof req.resourceType === 'function' ? req.resourceType() : '';

    if (shouldSilentlyAbortThirdPartyHost(curUrl, guardConfig)) {
      firewallAbortCount += 1;
      await route.abort('blockedbyclient');
      return;
    }

    const recordBlocked = (/** @type {string} */ m, /** @type {string} */ u, /** @type {string | null} */ reason) => {
      firewallAbortCount += 1;
      if ((resourceType === 'xhr' || resourceType === 'fetch') && /allowlist|not in allowed/i.test(String(reason || ''))) {
        try {
          const h = new URL(u).hostname.toLowerCase();
          if (h && h !== new URL(safety.baseURL).hostname.toLowerCase()) blockedApiHostSet.add(h);
        } catch {
          // ignore
        }
      }
      if (topology.blockedWriteRequests.length < 50) {
        const suspectedReadQueryPost = m === 'POST' && isSuspectedReadQueryPostUrl(u, safety.baseURL);
        topology.blockedWriteRequests.push({
          method: m,
          endpoint: redactEndpointUrl(u),
          reason,
          ...(suspectedReadQueryPost ? { suspectedReadQueryPost: true } : {}),
        });
      }
    };

    const initCheck = evaluateExploreRequestSafety(curMethod, curUrl, curBody, guardConfig);
    if (initCheck.blocked) {
      recordBlocked(curMethod, curUrl, initCheck.reason);
      await route.abort('blockedbyclient');
      return;
    }

    if (!/^https?:/i.test(curUrl) || typeof route.fetch !== 'function') {
      await route.continue();
      return;
    }

    let nativeDepth = 0;
    for (let r = typeof req.redirectedFrom === 'function' ? req.redirectedFrom() : null; r; r = r.redirectedFrom?.()) {
      nativeDepth += 1;
    }
    const trackedKey = `${resourceType}:${curUrl}`;
    const trackedEntry = redirectHopTracker.get(trackedKey);
    const trackedDepth = trackedEntry && Date.now() - trackedEntry.ts < 30_000 ? trackedEntry.depth : 0;
    redirectHopTracker.delete(trackedKey);
    const redirectDepth = Math.max(nativeDepth, trackedDepth);

    if (redirectDepth >= MAX_REDIRECT_HOPS) {
      recordBlocked(curMethod, curUrl, `Blocked explore redirect loop exceeding ${MAX_REDIRECT_HOPS} hops`);
      await route.abort('blockedbyclient');
      return;
    }

    try {
      const res = await route.fetch({ maxRedirects: 0, headers: curHeaders });
      const status = res.status();
      const location = res.headers()?.location;
      if (REDIRECT_STATUSES.has(status) && location) {
        const nextDepth = redirectDepth + 1;
        if (nextDepth > MAX_REDIRECT_HOPS) {
          recordBlocked(curMethod, curUrl, `Blocked explore redirect loop exceeding ${MAX_REDIRECT_HOPS} hops`);
          await route.abort('blockedbyclient');
          return;
        }
        const next = computeNextRedirectRequest(curMethod, status, location, curUrl, curHeaders);
        const hopBody = next.dropBody ? null : curBody;
        const hopCheck = evaluateExploreRequestSafety(next.method, next.url, hopBody, guardConfig);
        if (hopCheck.blocked) {
          recordBlocked(next.method, next.url, hopCheck.reason);
          await route.abort('blockedbyclient');
          return;
        }
        if (redirectHopTracker.size > 200) redirectHopTracker.clear();
        redirectHopTracker.set(`${resourceType}:${next.url}`, { depth: nextDepth, ts: Date.now() });
      }
      // Return checked 3xx/non-3xx response directly so Chromium natively tracks page.url() redirects
      await route.fulfill({ response: res });
    } catch {
      try {
        await route.abort('failed');
      } catch {
        // route already handled or browser closed
      }
    }
  });

  const page = await context.newPage();
  let activeRouteLabel = entryPath;
  /** @type {Set<string>} */
  const seenEndpointKeys = new Set();
  /** @type {Map<string, number>} */
  let routeApiCounts = new Map();
  /** @type {Set<string>} */
  const seenAnomalyKeys = new Set();
  let routeUnauthorized = false;
  /** @type {Set<Promise<void>>} */
  const pendingJsonChecks = new Set();

  page.on('pageerror', (/** @type {any} */ err) => {
    topology.consoleErrors.push({
      route: activeRouteLabel,
      message: redactSecrets(err?.message || String(err)),
    });
  });

  page.on('console', (/** @type {any} */ msg) => {
    if (msg.type() === 'error') {
      const text = redactSecrets(msg.text());
      // Filter self-inflicted Chromium console noise emitted when Playwright's own read-only firewall aborts a request
      if (firewallAbortCount > 0 && /ERR_BLOCKED_BY_CLIENT/i.test(text)) {
        topology.firewallAbortedConsoleCount += 1;
        return;
      }
      topology.consoleErrors.push({
        route: activeRouteLabel,
        message: text,
      });
    }
  });

  page.on('response', (/** @type {any} */ res) => {
    const status = res.status();
    const reqType = res.request().resourceType();
    const url = res.url();
    if (status === 401 || status === 403) {
      routeUnauthorized = true;
    }
    if (status >= 500) {
      topology.serverErrors.push(`${status} ${res.request().method()} ${redactEndpointUrl(url)}`);
    }
    if (reqType === 'xhr' || reqType === 'fetch') {
      const cleanEp = redactEndpointUrl(url);
      const key = `${res.request().method()} ${cleanEp} ${status}`;
      if (!seenEndpointKeys.has(key)) {
        seenEndpointKeys.add(key);
        topology.endpoints.push({
          method: res.request().method(),
          endpoint: cleanEp,
          status,
        });
      }
      const contentType = String(res.headers()?.['content-type'] || '');
      if (status >= 200 && status < 400 && /application\/json/i.test(contentType)) {
        const capturedRoute = activeRouteLabel;
        const capturedMethod = res.request().method();
        let capturedPathname = cleanEp;
        try {
          capturedPathname = new URL(url).pathname;
        } catch {
          capturedPathname = cleanEp;
        }
        const jsonTask = Promise.resolve(res.json())
          .then((/** @type {any} */ body) => {
            if (Array.isArray(topology.jsonCaptures) && topology.jsonCaptures.length < 60 && status >= 200 && status < 300) {
              topology.jsonCaptures.push({
                method: capturedMethod,
                pathname: capturedPathname,
                status,
                sample: body,
              });
            }
            const envErr = detectEnvelopeBusinessError(status, body);
            if (envErr.isError) {
              if ((envErr.code === 401 || envErr.code === 403) && capturedRoute === activeRouteLabel) {
                routeUnauthorized = true;
              }
              if (topology.envelopeErrors.length < 50) {
                topology.envelopeErrors.push({
                  route: capturedRoute,
                  method: capturedMethod,
                  endpoint: cleanEp,
                  httpStatus: status,
                  code: envErr.code,
                  message: envErr.message,
                });
              }
            }
          })
          .catch(() => {})
          .finally(() => {
            pendingJsonChecks.delete(jsonTask);
          });
        pendingJsonChecks.add(jsonTask);
      }
      if (res.request().method().toUpperCase() === 'GET') {
        let pathnameOnly = cleanEp;
        try {
          pathnameOnly = new URL(url).pathname;
        } catch {
          // keep cleanEp
        }
        routeApiCounts.set(pathnameOnly, (routeApiCounts.get(pathnameOnly) || 0) + 1);
      }
      for (const detail of detectUrlQueryAnomalies(url)) {
        const aKey = `${activeRouteLabel}:${detail}`;
        if (!seenAnomalyKeys.has(aKey)) {
          seenAnomalyKeys.add(aKey);
          topology.queryAnomalies.push({ route: activeRouteLabel, detail, endpoint: cleanEp });
        }
      }
    }
  });

  return {
    page,
    /** @param {string} routeLabel */
    beginRoute(routeLabel) {
      activeRouteLabel = routeLabel;
      routeApiCounts = new Map();
      routeUnauthorized = false;
    },
    async awaitRouteTelemetry() {
      if (pendingJsonChecks.size === 0) return;
      await Promise.race([
        Promise.allSettled([...pendingJsonChecks]),
        new Promise((resolve) => setTimeout(resolve, 300)),
      ]);
    },
    isRouteUnauthorized() {
      return routeUnauthorized;
    },
    getRouteApiCounts() {
      return routeApiCounts;
    },
    getBlockedApiHosts() {
      return [...blockedApiHostSet].sort();
    },
  };
}
