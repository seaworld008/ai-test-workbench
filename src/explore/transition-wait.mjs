// @ts-check

/**
 * Waits for SPA route transition completion (URL pathname/hash match, CSS/Vue leave-node detachment,
 * double requestAnimationFrame paint flush, and a brief XHR kickoff window) before `networkidle`.
 * @param {any} page
 * @param {string} expectedRoute
 * @param {{ waitNotes: Array<{ route: string, stage: string, note: string }> }} topology
 */
export async function waitForSpaRouteTransition(page, expectedRoute, topology) {
  const cleanTarget = String(expectedRoute || '/').split('?')[0];
  const isHashRoute = cleanTarget.startsWith('#');
  try {
    await page.waitForFunction(
      (/** @type {{ target: string, isHash: boolean }} */ { target, isHash }) => {
        if (isHash) {
          return window.location.hash === target || window.location.hash.startsWith(`${target}?`);
        }
        return window.location.pathname === target;
      },
      { target: cleanTarget, isHash: isHashRoute },
      { timeout: 1_500 }
    );
  } catch {
    topology.waitNotes.push({
      route: expectedRoute,
      stage: 'spa-route',
      note: `URL did not match "${cleanTarget}" within 1500ms`,
    });
  }

  try {
    await page.waitForFunction(
      () => {
        const leaving = document.querySelectorAll('[class*="-leave-active"], [class*="-leave-to"]');
        for (const el of leaving) {
          if (!el.isConnected) continue;
          const st = window.getComputedStyle(el);
          if (st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0') {
            return false;
          }
        }
        return true;
      },
      null,
      { timeout: 1_200 }
    );
  } catch {
    topology.waitNotes.push({
      route: expectedRoute,
      stage: 'spa-transition',
      note: 'CSS/Vue transition leave node remained visible after 1200ms',
    });
  }

  // Double rAF paint + brief 120ms XHR kickoff window so async requests fire before networkidle check
  try {
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          requestAnimationFrame(() =>
            requestAnimationFrame(() => {
              setTimeout(resolve, 120);
            })
          );
        })
    );
  } catch {
    await page.waitForTimeout(120).catch(() => {});
  }
}

/**
 * Settles a page after navigation by running optional SPA transition waits followed by `networkidle`
 * and loading-mask disappearance checks.
 * @param {any} page
 * @param {string} routeLabel
 * @param {{ waitNotes: Array<{ route: string, stage: string, note: string }> }} topology
 * @param {{ afterSpaNav?: boolean, expectedRoute?: string }} [options]
 */
export async function waitPageSettled(page, routeLabel, topology, options = {}) {
  if (options.afterSpaNav) {
    await waitForSpaRouteTransition(page, options.expectedRoute || routeLabel, topology);
  }
  try {
    await page.waitForLoadState('networkidle', { timeout: 2_500 });
  } catch {
    topology.waitNotes.push({ route: routeLabel, stage: 'networkidle', note: 'Streaming/long-polling active after 2500ms' });
  }
  try {
    await page.waitForFunction(
      () => {
        const masks = document.querySelectorAll('[aria-busy="true"], .el-loading-mask, .ant-spin-spinning, .el-skeleton');
        for (const m of masks) {
          if (getComputedStyle(m).display !== 'none') return false;
        }
        return true;
      },
      null,
      { timeout: 3_000 }
    );
  } catch {
    topology.waitNotes.push({ route: routeLabel, stage: 'aria-busy', note: 'Loading indicator remained visible >3000ms' });
  }
}

/** @param {any} page */
export async function closeVisibleOverlays(page) {
  await page
    .evaluate(() => {
      const closeBtns = Array.from(
        document.querySelectorAll(
          '.el-dialog__headerbtn, .el-drawer__close-btn, .ant-modal-close, .ant-drawer-close, [aria-label="Close"], .el-message-box__headerbtn'
        )
      ).filter((el) => /** @type {HTMLElement} */ (el).offsetParent !== null);
      for (const btn of closeBtns.reverse()) {
        try {
          /** @type {HTMLElement} */ (btn).click();
        } catch {
          // ignore
        }
      }
    })
    .catch(() => {});
  await page.keyboard.press('Escape').catch(() => {});
}

/**
 * Navigates to a target route via SPA router push/link click (when subsequent) or full `page.goto`,
 * recording broken route errors without aborting the exploration crawl.
 * @param {any} page
 * @param {{ targetUrl: string, normalizedKey: string, portalLabel: string, useSpa: boolean, shouldGoto: boolean, topology: any, redactSecrets: (s: string) => string }} params
 * @returns {Promise<{ ok: boolean, usedSpaNavigation: boolean }>}
 */
export async function navigateExploreRoute(page, { targetUrl, normalizedKey, portalLabel, useSpa, shouldGoto, topology, redactSecrets }) {
  let usedSpaNavigation = false;
  try {
    if (useSpa) {
      const spaNav = await page
        .evaluate(async (/** @type {string} */ dest) => {
          const appEl = /** @type {any} */ (document.querySelector('#app'));
          const router = appEl?.__vue__?.$router || appEl?.__vue_app__?.config?.globalProperties?.$router;
          if (router && typeof router.push === 'function') {
            try {
              await router.push(dest);
              return { usedSpa: true, error: null };
            } catch (e) {
              const errObj = /** @type {{ name?: unknown, message?: unknown } | null} */ (typeof e === 'object' && e !== null ? e : null);
              if (errObj?.name === 'NavigationDuplicated') return { usedSpa: true, error: null };
              return { usedSpa: true, error: String(errObj?.message || e) };
            }
          }
          const targetPathOnly = dest.split('?')[0];
          const matchingLink = Array.from(document.querySelectorAll('a[href], [role="link"][data-href]')).find((el) => {
            const raw = el.getAttribute('href') || el.getAttribute('data-href') || '';
            if (!raw || raw.startsWith('#') || raw.startsWith('http')) return false;
            return raw === dest || raw.split('?')[0] === targetPathOnly;
          });
          if (matchingLink && typeof (/** @type {any} */ (matchingLink)).click === 'function') {
            (/** @type {any} */ (matchingLink)).click();
            return { usedSpa: true, error: null };
          }
          return { usedSpa: false, error: null };
        }, normalizedKey)
        .catch(() => ({ usedSpa: false, error: null }));

      usedSpaNavigation = Boolean(spaNav.usedSpa);
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
    } else if (shouldGoto) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    }
    return { ok: true, usedSpaNavigation };
  } catch (navErr) {
    const navMsg = navErr instanceof Error ? navErr.message : String(navErr);
    topology.waitNotes.push({ route: normalizedKey, stage: 'goto', note: navMsg.slice(0, 120) });
    topology.brokenRoutes.push({
      portal: portalLabel,
      route: normalizedKey,
      actualPath: null,
      reason: `Navigation error: ${navMsg.slice(0, 140)}`,
    });
    return { ok: false, usedSpaNavigation };
  }
}
