// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import { redactSecrets } from '../core/redact.mjs';
import { evaluateExploreRequestSafety } from '../origin-guard.mjs';
import {
  capturePageSnapshot,
  discoverPortalSwitcherOptions,
  expandCollapsedMenus,
  explorePageTabs,
  exploreSafeReadonlyDialogs,
  switchPortalOption,
  waitPageSettled,
} from './dom-probes.mjs';
import {
  classifyActionSafety,
  createStratifiedRouteQueue,
  detectEnvelopeBusinessError,
  detectPageArchetype,
  detectUrlQueryAnomalies,
  redactEndpointUrl,
  sanitizeUntrustedDomText,
} from './safety.mjs';

function loadJsonIfValid(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Runs a bounded, strictly read-only multi-portal crawl inside a Playwright browser instance.
 * Enforces HTTP/WebSocket egress & mutation firewalls and captures topology + redacted ARIA snapshots.
 */
export async function executeExploreCrawl({
  browser,
  safety,
  guardConfig,
  sessionData,
  userAuthPath,
  maxPages,
  exploreTabs,
  exploreDialogs,
  explorePortals,
  maxTabsPerPage,
  maxDialogsPerPage,
  maxPortals,
  entryPath,
}) {
  const baseOrigin = new URL(safety.baseURL).origin;
  const exploredAt = new Date().toISOString();
  const snapshotId = `exp_${crypto.randomBytes(6).toString('hex')}`;
  const topology = {
    snapshotId,
    baseURL: safety.baseURL,
    exploredAt,
    readOnly: true,
    maxPages,
    exploreOptions: {
      exploreTabs,
      exploreDialogs,
      explorePortals,
      maxTabsPerPage,
      maxDialogsPerPage,
      maxPortals,
    },
    techStack: [],
    authKeyNames: [],
    portals: [],
    pages: [],
    brokenRoutes: [],
    endpoints: [],
    blockedWriteRequests: [],
    blockedApiHosts: [],
    envelopeErrors: [],
    queryAnomalies: [],
    duplicateWaterfalls: [],
    consoleErrors: [],
    serverErrors: [],
    waitNotes: [],
  };

  /** @type {Record<string, any>} */
  const contextOpts = {
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
  };
  if (loadJsonIfValid(userAuthPath)) {
    contextOpts.storageState = userAuthPath;
  }

  const context = await browser.newContext(contextOpts);

  // Block non-allowlisted WebSockets during exploration (`E-05`)
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket('**/*', (ws) => {
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
    ({ sessionPayload }) => {
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

  const blockedApiHostSet = new Set();
  await context.route('**/*', async (route) => {
    const req = route.request();
    const method = req.method().toUpperCase();
    const url = req.url();
    const postData = req.postData() || null;
    const check = evaluateExploreRequestSafety(method, url, postData, guardConfig);
    if (check.blocked) {
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
  const seenEndpointKeys = new Set();
  let routeApiCounts = new Map();
  const seenAnomalyKeys = new Set();

  page.on('pageerror', (err) => {
    topology.consoleErrors.push({
      route: activeRouteLabel,
      message: redactSecrets(err?.message || String(err)),
    });
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      topology.consoleErrors.push({
        route: activeRouteLabel,
        message: redactSecrets(msg.text()),
      });
    }
  });

  page.on('response', (res) => {
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
          .then((body) => {
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

  const visited = new Set();
  const stackSet = new Set();
  const authKeysSet = new Set();
  const portalMap = new Map();

  const crawlPortalContext = async (portalLabel, initialRoute, portalPageBudget, isPrimaryPortal) => {
    const routeQueue = createStratifiedRouteQueue();
    routeQueue.enqueue(initialRoute);
    let crawledInPortal = 0;
    let effectivePortalBudget = portalPageBudget;
    let switcherInfo = { selector: null, options: [] };

    while (routeQueue.size() > 0 && topology.pages.length < maxPages && crawledInPortal < effectivePortalBudget) {
      const nextRoute = routeQueue.dequeue();
      if (!nextRoute) break;
      const targetUrl = new URL(nextRoute, safety.baseURL).toString();
      const expectedPathname = new URL(targetUrl).pathname;
      const normalizedKey = expectedPathname + new URL(targetUrl).search;
      const visitKey = `${portalLabel}::${normalizedKey}`;
      if (visited.has(visitKey)) continue;
      visited.add(visitKey);
      activeRouteLabel = normalizedKey;
      routeApiCounts = new Map();

      try {
        if (crawledInPortal > 0) {
          const spaNav = await page
            .evaluate(async (dest) => {
              const appEl = /** @type {any} */ (document.querySelector('#app'));
              const router = appEl?.__vue__?.$router || appEl?.__vue_app__?.config?.globalProperties?.$router;
              if (router && typeof router.push === 'function') {
                try {
                  await router.push(dest);
                  return { usedSpa: true, error: null };
                } catch (e) {
                  if (e?.name === 'NavigationDuplicated') return { usedSpa: true, error: null };
                  return { usedSpa: true, error: String(e?.message || e) };
                }
              }
              return { usedSpa: false, error: null };
            }, normalizedKey)
            .catch(() => ({ usedSpa: false, error: null }));

          if (!spaNav.usedSpa) {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
          } else if (spaNav.error) {
            topology.brokenRoutes.push({
              portal: portalLabel,
              route: normalizedKey,
              actualPath: new URL(page.url()).pathname,
              reason: redactSecrets(spaNav.error).slice(0, 160),
            });
          }
        } else if (isPrimaryPortal) {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        }
      } catch (navErr) {
        topology.waitNotes.push({ route: normalizedKey, stage: 'goto', note: String(navErr?.message || navErr).slice(0, 120) });
        topology.brokenRoutes.push({
          portal: portalLabel,
          route: normalizedKey,
          actualPath: null,
          reason: `Navigation error: ${String(navErr?.message || navErr).slice(0, 140)}`,
        });
        continue;
      }

      await waitPageSettled(page, normalizedKey, topology);
      if (crawledInPortal === 0) {
        await expandCollapsedMenus(page);
      }

      let ariaSnapshot = '';
      try {
        const rootLoc = page.locator('main, [role="main"], .app-main, body').first();
        if (typeof rootLoc.ariaSnapshot === 'function') {
          ariaSnapshot = redactSecrets(await rootLoc.ariaSnapshot({ timeout: 3_000 }));
        }
      } catch {
        ariaSnapshot = '';
      }

      const snap = await capturePageSnapshot(page);

      if (
        crawledInPortal > 0 &&
        snap.actualPath &&
        snap.actualPath !== expectedPathname &&
        !/\/(login|signin|sso|auth|401|403)\b/i.test(snap.actualPath)
      ) {
        const alreadyLogged = topology.brokenRoutes.some((b) => b.portal === portalLabel && b.route === normalizedKey);
        if (!alreadyLogged) {
          topology.brokenRoutes.push({
            portal: portalLabel,
            route: normalizedKey,
            actualPath: snap.actualPath,
            reason: `Expected pathname "${expectedPathname}" but browser remained on "${snap.actualPath}"`,
          });
        }
      }

      const tabsExplored =
        exploreTabs && maxTabsPerPage > 0 && snap.tabs.length > 1
          ? await explorePageTabs(page, maxTabsPerPage)
          : [];

      const dialogsExplored =
        exploreDialogs && maxDialogsPerPage > 0
          ? await exploreSafeReadonlyDialogs(page, snap.buttons, maxDialogsPerPage, targetUrl, normalizedKey, topology)
          : [];

      for (const tName of snap.tech) stackSet.add(tName);
      for (const k of snap.authKeyNames) authKeysSet.add(k);
      for (const dp of snap.detectedPortals || []) {
        portalMap.set(`${dp.mode}:${dp.id ?? dp.name}`, dp);
      }

      if (isPrimaryPortal && crawledInPortal === 0 && explorePortals) {
        switcherInfo = await discoverPortalSwitcherOptions(page);
        for (const optName of switcherInfo.options) {
          portalMap.set(`switcher-option:${optName}`, {
            name: sanitizeUntrustedDomText(optName),
            mode: 'switcher-option',
            notes: `Discovered via ${switcherInfo.selector}`,
          });
        }
        const plannedExtraPortals = Math.min(Math.max(0, maxPortals - 1), switcherInfo.options.length);
        if (plannedExtraPortals > 0 && maxPages > plannedExtraPortals + 1) {
          effectivePortalBudget = Math.max(1, Math.floor(maxPages / (1 + plannedExtraPortals)));
        }
      }

      const apisObserved = [...routeApiCounts.keys()];
      for (const [epPath, count] of routeApiCounts.entries()) {
        if (count >= 2) {
          topology.duplicateWaterfalls.push({ route: normalizedKey, endpoint: epPath, count });
        }
      }

      const readonlyButtons = snap.buttons.filter((b) => classifyActionSafety(b) === 'readonly');
      const mutationButtons = snap.buttons.filter((b) => classifyActionSafety(b) === 'mutation');

      const pageEntry = {
        portal: portalLabel,
        route: normalizedKey,
        actualPath: snap.actualPath,
        title: snap.title,
        breadcrumbs: snap.breadcrumbs,
        tableHeaders: snap.tableHeaders,
        hasTable: snap.hasTable,
        tableRowCount: snap.tableRowCount,
        filterLabels: snap.filterLabels,
        buttons: snap.buttons,
        tabs: snap.tabs,
        tabsExplored,
        dialogsExplored,
        readonlyButtons,
        mutationButtons,
        apisObserved,
        hasPasswordInput: snap.hasPasswordInput,
        hasChart: snap.hasChart,
        a11y: snap.a11y,
        ariaSnapshot: ariaSnapshot ? ariaSnapshot.slice(0, 4000) : null,
      };
      pageEntry.archetype = detectPageArchetype(pageEntry);
      topology.pages.push(pageEntry);
      crawledInPortal += 1;

      for (const rawHref of snap.discoveredLinks) {
        try {
          const resolved = new URL(rawHref, safety.baseURL);
          if (resolved.origin !== baseOrigin) continue;
          if (/\/(logout|signout|download|loading)\b/i.test(resolved.pathname)) continue;
          const rel = resolved.pathname + resolved.search;
          if (!visited.has(`${portalLabel}::${rel}`)) {
            routeQueue.enqueue(rel);
          }
        } catch {
          // ignore malformed href
        }
      }
    }

    return { crawledInPortal, switcherInfo };
  };

  const primaryRes = await crawlPortalContext('default', entryPath, maxPages, true);

  if (
    explorePortals &&
    primaryRes.switcherInfo.selector &&
    primaryRes.switcherInfo.options.length > 0 &&
    topology.pages.length < maxPages
  ) {
    const candidatePortals = primaryRes.switcherInfo.options.slice(0, Math.max(0, maxPortals - 1));
    const perPortalBudget = Math.max(1, Math.floor((maxPages - topology.pages.length) / Math.max(1, candidatePortals.length)));
    for (const optionLabel of candidatePortals) {
      if (topology.pages.length >= maxPages) break;
      const switched = await switchPortalOption(page, primaryRes.switcherInfo.selector, optionLabel);
      if (switched) {
        await waitPageSettled(page, `portal:${optionLabel}`, topology);
        const afterSwitchPath = new URL(page.url()).pathname + new URL(page.url()).search;
        const subRes = await crawlPortalContext(optionLabel, afterSwitchPath, perPortalBudget, false);
        portalMap.set(`switcher-option:${optionLabel}`, {
          name: sanitizeUntrustedDomText(optionLabel),
          mode: 'portal-explored',
          notes: `Switched via ${primaryRes.switcherInfo.selector}; explored ${subRes.crawledInPortal} route(s).`,
        });
      }
    }
  }

  topology.techStack = [...stackSet];
  topology.authKeyNames = [...authKeysSet];
  topology.blockedApiHosts = [...blockedApiHostSet].sort();
  topology.portals =
    portalMap.size > 0
      ? [...portalMap.values()]
      : [
          {
            name: topology.pages[0]?.title || 'Default Web Context',
            mode: 'default',
            notes: `${topology.pages.length} route(s) explored cleanly.`,
          },
        ];

  return topology;
}
