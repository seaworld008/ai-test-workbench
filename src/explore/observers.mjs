// @ts-check
import { redactSecrets } from '../core/redact.mjs';
import { evaluateExploreRequestSafety } from '../origin-guard.mjs';
import { detectEnvelopeBusinessError, detectUrlQueryAnomalies, redactEndpointUrl } from './safety.mjs';

/**
 * Installs read-only network/WebSocket/sendBeacon firewalls and attaches console/response
 * telemetry observers onto a Playwright browser context and page.
 * @param {{ context: any, safety: any, guardConfig: any, sessionData: any, topology: any, entryPath: string }} params
 */
export async function attachExploreObservers({ context, safety, guardConfig, sessionData, topology, entryPath }) {
  // Block non-allowlisted WebSockets during exploration (`E-05`)
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', (/** @type {any} */ ws) => {
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

  // Block sendBeacon writes & restore optional sessionStorage
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
    },
    { sessionPayload: sessionData }
  );

  /** @type {Set<string>} */
  const blockedApiHostSet = new Set();
  let firewallAbortCount = 0;

  await context.route('**/*', async (/** @type {any} */ route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = req.url();
    const postData = req.postData() || null;
    const check = evaluateExploreRequestSafety(method, url, postData, guardConfig);
    if (check.blocked) {
      firewallAbortCount += 1;
      if ((req.resourceType() === 'xhr' || req.resourceType() === 'fetch') && /allowlist|not in allowed/i.test(String(check.reason || ''))) {
        try {
          const h = new URL(url).hostname.toLowerCase();
          if (h && h !== new URL(safety.baseURL).hostname.toLowerCase()) blockedApiHostSet.add(h);
        } catch {
          // ignore
        }
      }
      if (topology.blockedWriteRequests.length < 50) {
        topology.blockedWriteRequests.push({
          method,
          endpoint: redactEndpointUrl(url),
          reason: check.reason,
        });
      }
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });

  const page = await context.newPage();
  let activeRouteLabel = entryPath;
  /** @type {Set<string>} */
  const seenEndpointKeys = new Set();
  /** @type {Map<string, number>} */
  let routeApiCounts = new Map();
  /** @type {Set<string>} */
  const seenAnomalyKeys = new Set();

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
        void res
          .json()
          .then((/** @type {any} */ body) => {
            const envErr = detectEnvelopeBusinessError(status, body);
            if (envErr.isError && topology.envelopeErrors.length < 50) {
              topology.envelopeErrors.push({
                route: capturedRoute,
                method: capturedMethod,
                endpoint: cleanEp,
                httpStatus: status,
                code: envErr.code,
                message: envErr.message,
              });
            }
          })
          .catch(() => {});
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
    },
    getRouteApiCounts() {
      return routeApiCounts;
    },
    getBlockedApiHosts() {
      return [...blockedApiHostSet].sort();
    },
  };
}
