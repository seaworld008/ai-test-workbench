// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isLoopbackHttpUrl, loadRuntimeConfig } from '../core/runtime-config.mjs';
import { redactSecrets } from '../core/redact.mjs';
import {
  capturePageSnapshot,
  expandCollapsedMenus,
  explorePageTabs,
  exploreSafeReadonlyDialogs,
} from './dom-probes.mjs';
import { attachExploreObservers } from './observers.mjs';
import {
  PORTAL_CIRCUIT_BREAKER_REASON,
  detectBlockedPortalAuthExchange,
  discoverPortalSwitcherOptions,
  shouldTripPortalUnauthorizedBreaker,
  switchPortalOption,
} from './portal-switcher.mjs';
import {
  classifyActionSafety,
  createStratifiedRouteQueue,
  detectPageArchetype,
  isNonCrawlableSystemRoute,
  sanitizeUntrustedDomText,
} from './safety.mjs';
import { navigateExploreRoute, waitPageSettled } from './transition-wait.mjs';

/** @param {string} filePath */
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
 * @param {{ browser: any, safety: any, guardConfig: any, sessionData: any, userAuthPath: string, maxPages: number, exploreTabs: boolean, exploreDialogs: boolean, explorePortals: boolean, maxTabsPerPage: number, maxDialogsPerPage: number, maxPortals: number, entryPath: string }} params
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
    techStack: /** @type {string[]} */ ([]),
    authKeyNames: /** @type {string[]} */ ([]),
    portals: /** @type {Array<{ name: string, mode: string, id?: string | number, abortedReason?: string | null, notes?: string }>} */ ([]),
    portalCircuitBreakers: /** @type {Array<{ portal: string, abortedReason: string, detail: string }>} */ ([]),
    pages: /** @type {Array<{ portal: string, route: string, actualPath: string, component?: string | null, title: string, breadcrumbs: string[], tableHeaders: string[], hasTable: boolean, tableRowCount: number, filterLabels: string[], buttons: string[], tabs: string[], tabsExplored: string[], dialogsExplored: any[], readonlyButtons: string[], mutationButtons: string[], apisObserved: string[], hasPasswordInput: boolean, hasChart: boolean, a11y: any, ariaSnapshot: string | null, archetype: string }>} */ ([]),
    brokenRoutes: /** @type {Array<{ portal: string, route: string, actualPath: string | null, reason: string }>} */ ([]),
    endpoints: /** @type {Array<{ method: string, endpoint: string, status: number }>} */ ([]),
    blockedWriteRequests: /** @type {Array<{ method: string, endpoint: string, reason: string | null, suspectedReadQueryPost?: boolean }>} */ ([]),
    blockedApiHosts: /** @type {string[]} */ ([]),
    jsonCaptures: /** @type {Array<{ method: string, pathname: string, status: number, sample: unknown }>} */ ([]),
    envelopeErrors: /** @type {Array<{ route: string, method: string, endpoint: string, httpStatus: number, code: number | null, message: string | null }>} */ ([]),
    queryAnomalies: /** @type {Array<{ route: string, detail: string, endpoint: string }>} */ ([]),
    duplicateWaterfalls: /** @type {Array<{ route: string, endpoint: string, count: number }>} */ ([]),
    consoleErrors: /** @type {Array<{ route: string, message: string }>} */ ([]),
    firewallAbortedConsoleCount: 0,
    authRequired: false,
    loginRoute: /** @type {string | null} */ (null),
    authRedirectCount: 0,
    authRedirectRoutes: /** @type {string[]} */ ([]),
    serverErrors: /** @type {string[]} */ ([]),
    waitNotes: /** @type {Array<{ route: string, stage: string, note: string }>} */ ([]),
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
  const qaDirForRuntime = userAuthPath ? path.resolve(userAuthPath, '..', '..', '..') : null;
  if (qaDirForRuntime && isLoopbackHttpUrl(safety.baseURL)) {
    const rt = loadRuntimeConfig(qaDirForRuntime);
    const authCfg = rt.ok ? rt.config?.auth : null;
    if (authCfg?.loginEndpoint && authCfg.email && authCfg.password && !loadJsonIfValid(userAuthPath)) {
      try {
        const loginUrl = new URL(authCfg.loginEndpoint, safety.baseURL).toString();
        await context.request.post(loginUrl, {
          data: { email: authCfg.email, password: authCfg.password },
        });
      } catch {
        // non-fatal loopback warmup attempt
      }
    }
  }
  const observers = await attachExploreObservers({
    context,
    safety,
    guardConfig,
    sessionData,
    topology,
    entryPath,
  });
  const { page } = observers;

  /** @type {Set<string>} */
  const visited = new Set();
  /** @type {Set<string>} */
  const stackSet = new Set();
  /** @type {Set<string>} */
  const authKeysSet = new Set();
  /** @type {Map<string, { name: string, mode: string, id?: string | number, abortedReason?: string | null, notes?: string }>} */
  const portalMap = new Map();

  /** @param {string} portalLabel @param {string} initialRoute @param {number} portalPageBudget @param {boolean} isPrimaryPortal */
  const crawlPortalContext = async (portalLabel, initialRoute, portalPageBudget, isPrimaryPortal) => {
    const routeQueue = createStratifiedRouteQueue();
    routeQueue.enqueue(initialRoute, 'primary');
    let crawledInPortal = 0;
    let probedInPortal = 0;
    let unauthorizedInFirstThree = 0;
    /** @type {string | null} */
    let abortedReason = null;
    let effectivePortalBudget = portalPageBudget;
    let consecutiveAuthRedirects = 0;
    let capturedAuthPortalOnce = false;
    /** @type {{ selector: string | null, options: string[] }} */
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
      observers.beginRoute(normalizedKey);
      const navResult = await navigateExploreRoute(page, {
        targetUrl,
        normalizedKey,
        portalLabel,
        useSpa: crawledInPortal > 0,
        shouldGoto: isPrimaryPortal,
        topology,
        redactSecrets,
      });
      if (!navResult.ok) continue;

      await waitPageSettled(page, normalizedKey, topology, {
        afterSpaNav: navResult.usedSpaNavigation,
        expectedRoute: normalizedKey,
      });
      await observers.awaitRouteTelemetry();
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

      const currentApiCounts = observers.getRouteApiCounts();
      const apisObserved = [...currentApiCounts.keys()];
      for (const [epPath, count] of currentApiCounts.entries()) {
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
        component: snap.component || null,
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
        archetype: '',
      };
      pageEntry.archetype = detectPageArchetype(pageEntry);

      const landedOnLogin =
        Boolean(snap.actualPath) &&
        (pageEntry.archetype === 'auth-portal' || /\/(login|signin|sso|auth)\b/i.test(snap.actualPath));
      const isAuthRedirect = landedOnLogin && snap.actualPath !== expectedPathname;

      if (isAuthRedirect) {
        topology.authRedirectCount += 1;
        if (!topology.authRedirectRoutes.includes(normalizedKey)) {
          topology.authRedirectRoutes.push(normalizedKey);
        }
        if (!topology.loginRoute) {
          topology.loginRoute = snap.actualPath;
        }
        if (crawledInPortal === 0) {
          topology.authRequired = true;
        }
        consecutiveAuthRedirects += 1;
      } else {
        consecutiveAuthRedirects = 0;
      }

      const isDuplicateLoginRedirect = isAuthRedirect && capturedAuthPortalOnce;
      if (landedOnLogin) {
        capturedAuthPortalOnce = true;
        if (!topology.loginRoute && snap.actualPath) topology.loginRoute = snap.actualPath;
      }

      if (!isDuplicateLoginRedirect) {
        topology.pages.push(pageEntry);
        crawledInPortal += 1;
      }

      probedInPortal += 1;
      if (
        !isPrimaryPortal &&
        probedInPortal <= 3 &&
        (observers.isRouteUnauthorized() || /\/(401|403)\b/.test(String(snap.actualPath || '')))
      ) {
        unauthorizedInFirstThree += 1;
      }
      if (shouldTripPortalUnauthorizedBreaker({ isPrimaryPortal, probedCount: probedInPortal, unauthorizedInFirstThree })) {
        abortedReason = PORTAL_CIRCUIT_BREAKER_REASON;
        topology.portalCircuitBreakers.push({
          portal: portalLabel,
          abortedReason,
          detail: 'First 3 probed sub-portal routes all returned 401/403',
        });
        break;
      }

      // Stop burning page budget when an unauthenticated session redirects repeatedly to the same login screen
      if (consecutiveAuthRedirects >= 4) {
        topology.authRequired = true;
        break;
      }

      const enqueueLinks = (/** @type {string[]} */ links, /** @type {'primary' | 'secondary' | 'fallback'} */ tier) => {
        for (const rawHref of links || []) {
          try {
            const resolved = new URL(rawHref, safety.baseURL);
            if (resolved.origin !== baseOrigin) continue;
            if (isNonCrawlableSystemRoute(resolved.pathname)) continue;
            const rel = resolved.pathname + resolved.search;
            if (!visited.has(`${portalLabel}::${rel}`)) {
              routeQueue.enqueue(rel, tier);
            }
          } catch {
            // ignore malformed href
          }
        }
      };
      enqueueLinks(snap.primaryLinks || snap.discoveredLinks, 'primary');
      enqueueLinks(snap.secondaryLinks || [], 'secondary');
      enqueueLinks(snap.fallbackLinks || [], 'fallback');
    }

    return { crawledInPortal, switcherInfo, abortedReason };
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
      const beforeBlockedCount = topology.blockedWriteRequests.length;
      const switched = await switchPortalOption(page, primaryRes.switcherInfo.selector, optionLabel);
      if (switched) {
        await waitPageSettled(page, `portal:${optionLabel}`, topology);
        await observers.awaitRouteTelemetry();
        const blockedAuth = detectBlockedPortalAuthExchange(topology.blockedWriteRequests, beforeBlockedCount);
        if (blockedAuth.tripped) {
          topology.portalCircuitBreakers.push({
            portal: optionLabel,
            abortedReason: PORTAL_CIRCUIT_BREAKER_REASON,
            detail: `Blocked auth/token-exchange POST ${blockedAuth.endpoint}`,
          });
          portalMap.set(`switcher-option:${optionLabel}`, {
            name: sanitizeUntrustedDomText(optionLabel),
            mode: 'portal-aborted',
            abortedReason: PORTAL_CIRCUIT_BREAKER_REASON,
            notes: `Circuit-breaker tripped on blocked auth exchange (${blockedAuth.endpoint}).`,
          });
          continue;
        }
        const afterSwitchPath = new URL(page.url()).pathname + new URL(page.url()).search;
        const subRes = await crawlPortalContext(optionLabel, afterSwitchPath, perPortalBudget, false);
        portalMap.set(`switcher-option:${optionLabel}`, {
          name: sanitizeUntrustedDomText(optionLabel),
          mode: subRes.abortedReason ? 'portal-aborted' : 'portal-explored',
          ...(subRes.abortedReason ? { abortedReason: subRes.abortedReason } : {}),
          notes: subRes.abortedReason
            ? `Circuit-breaker tripped (${subRes.abortedReason}) after ${subRes.crawledInPortal} route(s).`
            : `Switched via ${primaryRes.switcherInfo.selector}; explored ${subRes.crawledInPortal} route(s).`,
        });
      }
    }
  }

  topology.techStack = [...stackSet];
  topology.authKeyNames = [...authKeysSet];
  topology.blockedApiHosts = observers.getBlockedApiHosts();
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
