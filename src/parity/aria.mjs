// @ts-check
import { pathToFileURL } from 'node:url';
import { resolvePlaywrightPackage } from '../core/playwright-resolve.mjs';
import { checkOutgoingRequestSafety } from '../origin-guard.mjs';
import { loadParityAuthContext } from './auth-context.mjs';

const LOGIN_URL_RE = /(?:^|\/)(?:login|signin)(?:[/?#]|$)|#\/(?:login|signin)(?:[/?#]|$)/i;
const LOGIN_ROUTE_PARAM_RE = /\/(?:login|signin|passport|sso|auth)\b|#\/(?:login|signin)/i;

/**
 * Optionally collects dual-target browser ARIA snapshots & runtime errors (`CP4-DOM-ARIA-And-Runtime`),
 * injecting reusable `user.json` storageState, `session.json` sessionStorage, and numeric idle-timestamp
 * refreshes while flagging unexpected auth redirects to `/login` or `/signin`.
 *
 * @param {string} qaDir
 * @param {string} baseUrl
 * @param {string} candUrl
 * @param {string[]} routes
 * @param {Record<string, any>} baseGuard
 * @param {Record<string, any>} candGuard
 * @param {{ noAuth?: boolean, authCtx?: ReturnType<typeof loadParityAuthContext> }} [options]
 */
export async function collectAriaSnapshotsForRoutes(
  qaDir,
  baseUrl,
  candUrl,
  routes,
  baseGuard,
  candGuard,
  options = {}
) {
  const pwPkg = resolvePlaywrightPackage(qaDir);
  if (!pwPkg || routes.length === 0) return new Map();

  const authCtx = options.authCtx || loadParityAuthContext(qaDir, { noAuth: options.noAuth });
  const { chromium } = await import(pathToFileURL(pwPkg).href);
  const browser = await chromium.launch({ headless: true });
  /** @type {Map<string, { base: { ariaSnapshot: string, pageErrors: string[], serverErrors: string[], finalUrl: string, authRedirected: boolean }, cand: { ariaSnapshot: string, pageErrors: string[], serverErrors: string[], finalUrl: string, authRedirected: boolean } }>} */
  const out = new Map();

  /** @param {string} targetOrigin @param {string} rPath @param {Record<string, any>} guardCfg */
  const sampleOne = async (targetOrigin, rPath, guardCfg) => {
    const expectedOrigin = new URL(targetOrigin).origin;
    const contextOpts = {
      serviceWorkers: /** @type {const} */ ('block'),
      ...(!options.noAuth && authCtx.userStatePath ? { storageState: authCtx.userStatePath } : {}),
    };
    const context = await browser.newContext(contextOpts);

    const lsEntries = (() => {
      if (options.noAuth || authCtx.origins.length === 0) return [];
      const exact = authCtx.origins.find((o) => String(o?.origin || '').toLowerCase() === expectedOrigin.toLowerCase());
      if (exact) return [];
      return (authCtx.origins[0]?.localStorage || []).map((item) => [String(item.name), String(item.value)]);
    })();

    const sessionEntries = !options.noAuth && authCtx.sessionData?.entries ? authCtx.sessionData.entries : [];
    const preserveIdle = process.env.TEST_PRESERVE_IDLE_TIMESTAMPS === '1';

    await context.addInitScript(
      (/** @type {{ expOrigin: string, sEntries: Array<[string, string]>, lsFallback: Array<[string, string]>, skipIdleRefresh: boolean }} */ payload) => {
        if (window.location.origin !== payload.expOrigin) return;
        try {
          for (const [k, v] of payload.sEntries) {
            window.sessionStorage.setItem(k, v);
          }
          for (const [k, v] of payload.lsFallback) {
            if (window.localStorage.getItem(k) === null) {
              window.localStorage.setItem(k, v);
            }
          }
          if (!payload.skipIdleRefresh) {
            const nowStr = String(Date.now());
            for (const key of ['lastRecordTime', 'lastActiveTime', 'lastActivityTime']) {
              const cur = window.localStorage.getItem(key);
              if (cur !== null && /^\d{10,13}$/.test(cur.trim())) {
                window.localStorage.setItem(key, nowStr);
              }
            }
          }
        } catch {
          // ignore opaque storage origins
        }
      },
      {
        expOrigin: expectedOrigin,
        sEntries: sessionEntries,
        lsFallback: lsEntries,
        skipIdleRefresh: preserveIdle,
      }
    );

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
      const finalUrl = page.url();
      const requestedIsLogin = LOGIN_ROUTE_PARAM_RE.test(rPath);
      let landedOnLogin = false;
      try {
        const parsed = new URL(finalUrl);
        landedOnLogin = LOGIN_URL_RE.test(`${parsed.pathname}${parsed.hash}`);
      } catch {
        landedOnLogin = false;
      }
      const authRedirected = !requestedIsLogin && landedOnLogin;
      const ariaSnapshot = await page.locator('body').ariaSnapshot();
      return { ariaSnapshot, pageErrors, serverErrors, finalUrl, authRedirected };
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
