// @ts-check
import { extractVueDynamicRoutes, isSafeReadonlyDialogTrigger, sanitizeUntrustedDomText } from './safety.mjs';

/** @param {any} page @param {string} routeLabel @param {{ waitNotes: Array<{ route: string, stage: string, note: string }> }} topology */
export async function waitPageSettled(page, routeLabel, topology) {
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

/** @param {any} page */
export async function expandCollapsedMenus(page) {
  await page
    .evaluate(() => {
      const toggles = Array.from(
        document.querySelectorAll(
          '.el-submenu:not(.is-opened) > .el-submenu__title, .ant-menu-submenu:not(.ant-menu-submenu-open) > .ant-menu-submenu-title, [role="menuitem"][aria-haspopup="menu"][aria-expanded="false"]'
        )
      ).slice(0, 12);
      for (const el of toggles) {
        try {
          /** @type {HTMLElement} */ (el).click();
        } catch {
          // ignore
        }
      }
    })
    .catch(() => {});
}

/**
 * Probes generic multi-portal / tenant / workspace switcher drawers or popovers and returns
 * discovered switchable portal entries.
 * @param {any} page
 * @returns {Promise<{ selector: string | null, options: string[] }>}
 */
export async function discoverPortalSwitcherOptions(page) {
  const switcherSelectors = [
    '.sidebar-logo-container',
    '[class*="tenant-switch"]',
    '[class*="workspace-switch"]',
    '[class*="org-switch"]',
    '[class*="portal-switch"]',
    '[class*="school-switch"]',
    '[data-testid*="tenant-switcher"]',
    '[data-testid*="workspace-switcher"]',
  ];
  /** @type {{ clicked: boolean, selector: string | null }} */
  const found = await page
    .evaluate((/** @type {string[]} */ sels) => {
      for (const sel of sels) {
        const el = /** @type {HTMLElement | null} */ (document.querySelector(sel));
        if (el && el.offsetParent !== null) {
          el.click();
          return { clicked: true, selector: sel };
        }
      }
      return { clicked: false, selector: null };
    }, switcherSelectors)
    .catch(() => ({ clicked: false, selector: null }));

  if (!found.clicked) return { selector: null, options: [] };
  await page.waitForTimeout(450).catch(() => {});

  /** @type {string[]} */
  const optionsFound = await page
    .evaluate(() => {
      const overlay = Array.from(
        document.querySelectorAll('.el-drawer, .el-dialog, .ant-drawer, .ant-modal, [role="dialog"], [role="listbox"], .el-popover')
      ).find((el) => {
        const h = /** @type {HTMLElement} */ (el);
        return h.offsetParent !== null && getComputedStyle(h).display !== 'none';
      });
      if (!overlay) return [];
      const items = Array.from(
        overlay.querySelectorAll(
          '[role="option"], [data-portal], [data-tenant], li, button, [class*="item"], [class*="school"], [class*="tenant"], [class*="workspace"], .el-card'
        )
      )
        .filter((el) => {
          const h = /** @type {HTMLElement} */ (el);
          if (h.offsetParent === null) return false;
          const txt = (h.textContent || '').replace(/\s+/g, ' ').trim();
          if (!txt || txt.length > 60) return false;
          if (/^(关闭|取消|确定|保存|close|cancel|ok)$/i.test(txt)) return false;
          if (h.querySelector('[role="option"], [data-portal], [data-tenant]')) return false;
          return true;
        })
        .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim());
      return [...new Set(items)].slice(0, 12);
    })
    .catch(() => []);

  await closeVisibleOverlays(page);
  return { selector: found.selector, options: optionsFound };
}

/**
 * Captures DOM affordances, tech stack, a11y baseline, and route links from the active page.
 * Vue route trees are projected to plain serializable objects and normalized in Node via
 * `extractVueDynamicRoutes` (single source of truth).
 * @param {any} page
 */
export async function capturePageSnapshot(page) {
  /** @type {{ actualPath: string, title: string, breadcrumbs: string[], tableHeaders: string[], hasTable: boolean, tableRowCount: number, filterLabels: string[], buttons: string[], tabs: string[], hasPasswordInput: boolean, hasChart: boolean, a11y: { hasMainLandmark: boolean, hasH1: boolean, inputsMissingLabel: number, imagesMissingAlt: number }, tech: string[], authKeyNames: string[], detectedPortals: Array<{ name: string, mode: string, id?: string | number, notes?: string }>, anchors: string[], flatFrameworkRoutes: string[], vueRouteTrees: any[] }} */
  const raw = await page.evaluate(() => {
    const mainScope = document.querySelector('main, [role="main"], .app-main') || document.body;
    const buttons = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('button, [role="button"]'))
          .map((b) => (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 25);

    const tabs = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('[role="tab"], .el-tabs__item, .ant-tabs-tab'))
          .map((t) => (t.textContent || t.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 15);

    const tableHeaders = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('table th, [role="columnheader"], .el-table__header th .cell'))
          .map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 20);

    const filterLabels = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('label, .el-form-item__label'))
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 20);

    const breadcrumbs = Array.from(
      document.querySelectorAll('nav[aria-label*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] span, .app-breadcrumb .el-breadcrumb__inner')
    )
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean);

    const anchors = Array.from(document.querySelectorAll('a[href], [role="menuitem"][href], [data-href], [to]'))
      .map((a) => a.getAttribute('href') || a.getAttribute('data-href') || a.getAttribute('to') || '')
      .filter((h) => h && !h.startsWith('#') && !h.startsWith('javascript:') && !h.startsWith('mailto:'));

    const tech = [];
    const anyWin = /** @type {any} */ (window);
    const appEl = /** @type {any} */ (document.querySelector('#app'));
    if (appEl?.__vue__ || appEl?.__vue_app__) tech.push('Vue');
    if (anyWin.__NEXT_DATA__ || document.querySelector('#__next, [data-nextjs-scroll-focus-boundary]')) tech.push('Next.js');
    if (
      document.querySelector('[data-reactroot]') ||
      Object.keys(document.body || {}).some((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'))
    ) {
      tech.push('React');
    }
    if (document.querySelector('[ng-version]')) tech.push('Angular');
    if (document.querySelector('.el-table, .el-menu, .el-form')) tech.push('Element UI');
    if (document.querySelector('[class*="ant-"]')) tech.push('Ant Design');

    // Serialize minimal route tree metadata so Node-side extractVueDynamicRoutes handles all path normalization
    /** @param {any} routes @param {number} [depth] @returns {Array<{ path: string, hidden: boolean, children: any[] }>} */
    const serializeTree = (routes, depth = 0) => {
      if (!Array.isArray(routes) || depth > 8) return [];
      return routes.slice(0, 200).map((/** @type {any} */ r) => ({
        path: typeof r?.path === 'string' ? r.path : '',
        hidden: Boolean(r?.hidden || r?.meta?.hidden),
        children: Array.isArray(r?.children) ? serializeTree(r.children, depth + 1) : [],
      }));
    };

    const vueRouteTrees = [];
    const flatFrameworkRoutes = [];
    const vueRoot = appEl?.__vue__;
    if (vueRoot?.$router?.options?.routes) vueRouteTrees.push(serializeTree(vueRoot.$router.options.routes));
    if (typeof vueRoot?.$router?.getRoutes === 'function') {
      for (const r of vueRoot.$router.getRoutes()) {
        if (r?.path && !r.path.includes(':') && !r.path.includes('*') && !r.meta?.hidden) flatFrameworkRoutes.push(r.path);
      }
    }
    const permState = vueRoot?.$store?.state?.permission;
    if (permState) {
      for (const key of ['sidebarRouters', 'topbarRouters', 'routes', 'addRoutes']) {
        if (Array.isArray(permState[key])) vueRouteTrees.push(serializeTree(permState[key]));
      }
    }
    const vue3Router = appEl?.__vue_app__?.config?.globalProperties?.$router;
    if (vue3Router && typeof vue3Router.getRoutes === 'function') {
      for (const r of vue3Router.getRoutes()) {
        if (r?.path && !r.path.includes(':') && !r.path.includes('*')) flatFrameworkRoutes.push(r.path);
      }
    }
    if (anyWin.__NEXT_DATA__?.page && typeof anyWin.__NEXT_DATA__.page === 'string' && !anyWin.__NEXT_DATA__.page.includes('[')) {
      flatFrameworkRoutes.push(anyWin.__NEXT_DATA__.page);
    }

    const detectedPortals = [];
    const switcherDom = document.querySelectorAll(
      '.sidebar-logo-container, [class*="tenant-switch"], [class*="workspace-switch"], [class*="org-switch"], [class*="portal-switch"], [data-testid*="tenant-switcher"], [data-testid*="workspace-switcher"]'
    );
    if (switcherDom.length > 0) {
      detectedPortals.push({ name: 'Multi-Tenant Switcher', mode: 'switcher', notes: 'Interactive switcher DOM found' });
    }

    const primaryElRows = mainScope.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row');
    const primaryAntRows = mainScope.querySelectorAll('.ant-table-body tbody tr.ant-table-row');
    const tableRowCount =
      primaryElRows.length > 0
        ? primaryElRows.length
        : primaryAntRows.length > 0
          ? primaryAntRows.length
          : Array.from(mainScope.querySelectorAll('table tbody tr, [role="row"]')).filter(
              (tr) => !tr.closest('.el-table__fixed, .el-table__fixed-right, .ant-table-fixed-left, .ant-table-fixed-right')
            ).length;

    return {
      actualPath: window.location.pathname,
      title: document.title || '',
      breadcrumbs,
      tableHeaders,
      hasTable: !!mainScope.querySelector('table, [role="table"], [role="grid"], .el-table'),
      tableRowCount,
      filterLabels,
      buttons,
      tabs,
      hasPasswordInput: !!document.querySelector('input[type="password"]'),
      hasChart: !!mainScope.querySelector('canvas, svg[class*="chart"], .echarts, [class*="chart"]'),
      a11y: {
        hasMainLandmark: !!document.querySelector('main, [role="main"]'),
        hasH1: !!document.querySelector('h1'),
        inputsMissingLabel: Array.from(mainScope.querySelectorAll('input:not([type="hidden"])')).filter(
          (i) =>
            !i.getAttribute('aria-label') &&
            !i.getAttribute('aria-labelledby') &&
            !(i.id && document.querySelector(`label[for="${i.id.replace(/"/g, '\\"')}"]`))
        ).length,
        imagesMissingAlt: mainScope.querySelectorAll('img:not([alt])').length,
      },
      tech,
      authKeyNames: Object.keys(window.localStorage || {}).filter((k) =>
        /token|auth|session|user|platform|tenant|admin/i.test(k)
      ),
      detectedPortals,
      anchors,
      flatFrameworkRoutes,
      vueRouteTrees,
    };
  });

  const vueDynamicRoutes = extractVueDynamicRoutes(raw.vueRouteTrees || []);
  return {
    ...raw,
    discoveredLinks: [...raw.anchors, ...raw.flatFrameworkRoutes, ...vueDynamicRoutes],
  };
}

/** @param {any} page @param {number} maxTabsPerPage @returns {Promise<string[]>} */
export async function explorePageTabs(page, maxTabsPerPage) {
  /** @type {string[]} */
  const clickedTabs = await page
    .evaluate(async (/** @type {number} */ limit) => {
      const scope = document.querySelector('main, [role="main"], .app-main') || document.body;
      const els = Array.from(scope.querySelectorAll('[role="tab"], .el-tabs__item, .ant-tabs-tab')).filter(
        (el) => /** @type {HTMLElement} */ (el).offsetParent !== null && !el.classList.contains('is-disabled')
      );
      const visitedTabs = [];
      for (const tabEl of els.slice(1, limit + 1)) {
        const label = (tabEl.textContent || tabEl.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
        try {
          /** @type {HTMLElement} */ (tabEl).click();
          await new Promise((r) => setTimeout(r, 220));
          visitedTabs.push(label || '(tab)');
        } catch {
          // ignore
        }
      }
      if (els[0]) {
        try {
          /** @type {HTMLElement} */ (els[0]).click();
        } catch {
          // ignore
        }
      }
      return visitedTabs;
    }, maxTabsPerPage)
    .catch(() => []);
  return clickedTabs.map((t) => sanitizeUntrustedDomText(t));
}

/** @param {any} page @param {string[]} buttons @param {number} maxDialogsPerPage @param {string} targetUrl @param {string} routeLabel @param {{ waitNotes: Array<{ route: string, stage: string, note: string }> }} topology */
export async function exploreSafeReadonlyDialogs(page, buttons, maxDialogsPerPage, targetUrl, routeLabel, topology) {
  const dialogsExplored = [];
  const safeTriggerLabels = buttons.filter((b) => isSafeReadonlyDialogTrigger(b)).slice(0, maxDialogsPerPage);
  for (const triggerLabel of safeTriggerLabels) {
    const beforePath = new URL(page.url()).pathname;
    const clickOutcome = await page
      .evaluate(async (/** @type {string} */ targetText) => {
        const scope = document.querySelector('main, [role="main"], .app-main') || document.body;
        const candidates = Array.from(scope.querySelectorAll('button, [role="button"], .el-button--text'));
        const btn = candidates.find((el) => {
          const h = /** @type {HTMLElement} */ (el);
          if (h.offsetParent === null || /** @type {HTMLButtonElement} */ (h).disabled) return false;
          const txt = (h.textContent || h.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
          return txt === targetText;
        });
        if (!btn) return { clicked: false };
        /** @type {HTMLElement} */ (btn).click();
        await new Promise((r) => setTimeout(r, 420));
        const overlay = Array.from(
          document.querySelectorAll('.el-dialog, .el-drawer, .ant-modal, .ant-drawer, [role="dialog"], [aria-modal="true"]')
        ).find((d) => {
          const h = /** @type {HTMLElement} */ (d);
          return h.offsetParent !== null && getComputedStyle(h).display !== 'none';
        });
        if (overlay) {
          const title = (
            overlay.querySelector('.el-dialog__title, .el-drawer__header span, .ant-modal-title, .ant-drawer-title, h2, h3, header')
              ?.textContent || ''
          )
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 80);
          const overlayButtons = Array.from(overlay.querySelectorAll('button, [role="button"]'))
            .map((b) => (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
            .filter(Boolean)
            .slice(0, 10);
          return { clicked: true, kind: 'overlay', title, overlayButtons, afterPath: window.location.pathname };
        }
        return { clicked: true, kind: 'page', title: document.title || '', afterPath: window.location.pathname };
      }, triggerLabel)
      .catch(() => ({ clicked: false }));

    if (clickOutcome.clicked) {
      if (clickOutcome.kind === 'overlay') {
        dialogsExplored.push({
          trigger: sanitizeUntrustedDomText(triggerLabel),
          kind: 'dialog',
          title: sanitizeUntrustedDomText(clickOutcome.title || '(dialog)'),
          buttons: (/** @type {string[]} */ (clickOutcome.overlayButtons || [])).map((b) => sanitizeUntrustedDomText(b)),
        });
        await closeVisibleOverlays(page);
      } else if (clickOutcome.afterPath && clickOutcome.afterPath !== beforePath) {
        dialogsExplored.push({
          trigger: sanitizeUntrustedDomText(triggerLabel),
          kind: 'subroute',
          navigatedTo: clickOutcome.afterPath,
        });
        await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8_000 }).catch(async () => {
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 10_000 }).catch(() => {});
        });
        await waitPageSettled(page, routeLabel, topology);
      }
    }
  }
  return dialogsExplored;
}

/** @param {any} page @param {string} selector @param {string} optionLabel @returns {Promise<boolean>} */
export async function switchPortalOption(page, selector, optionLabel) {
  return page
    .evaluate(
      async (/** @type {{ sel: string, optText: string }} */ { sel, optText }) => {
        const trigger = /** @type {HTMLElement | null} */ (document.querySelector(sel));
        if (!trigger) return false;
        trigger.click();
        await new Promise((r) => setTimeout(r, 400));
        const overlay = Array.from(
          document.querySelectorAll('.el-drawer, .el-dialog, .ant-drawer, .ant-modal, [role="dialog"], [role="listbox"], .el-popover')
        ).find((el) => {
          const h = /** @type {HTMLElement} */ (el);
          return h.offsetParent !== null && getComputedStyle(h).display !== 'none';
        });
        if (!overlay) return false;
        const match = Array.from(
          overlay.querySelectorAll(
            '[role="option"], [data-portal], [data-tenant], li, button, [class*="item"], [class*="school"], [class*="tenant"], [class*="workspace"], .el-card'
          )
        ).find((el) => (el.textContent || '').replace(/\s+/g, ' ').trim() === optText);
        if (!match) return false;
        /** @type {HTMLElement} */ (match).click();
        await new Promise((r) => setTimeout(r, 800));
        return true;
      },
      { sel: selector, optText: optionLabel }
    )
    .catch(() => false);
}
