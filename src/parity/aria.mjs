// @ts-check
import { pathToFileURL } from 'node:url';
import { resolvePlaywrightPackage } from '../core/playwright-resolve.mjs';
import { checkOutgoingRequestSafety } from '../origin-guard.mjs';

/**
 * Optionally collects dual-target browser ARIA snapshots & runtime errors (`CP4-DOM-ARIA-And-Runtime`).
 * Extracted from `src/parity/runner.mjs` to keep every parity module compact and single-responsibility.
 *
 * @param {string} qaDir
 * @param {string} baseUrl
 * @param {string} candUrl
 * @param {string[]} routes
 * @param {Record<string, any>} baseGuard
 * @param {Record<string, any>} candGuard
 */
export async function collectAriaSnapshotsForRoutes(qaDir, baseUrl, candUrl, routes, baseGuard, candGuard) {
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
