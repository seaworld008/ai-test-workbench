// @ts-check
import { discoverPortalSwitcherOptions, switchPortalOption } from './portal-switcher.mjs';
import {
  extractVueRouteInventory,
  isNonCrawlableSystemRoute,
  isSafeReadonlyDialogTrigger,
  sanitizeUntrustedDomText,
} from './safety.mjs';
import { closeVisibleOverlays, waitPageSettled } from './transition-wait.mjs';

export { closeVisibleOverlays, discoverPortalSwitcherOptions, switchPortalOption, waitPageSettled };

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
 * Captures visible active DOM affordances (excluding outgoing CSS/Vue `-leave-active` nodes and hidden
 * ancestors), tech stack, active Vue Router matched component hints, a11y baseline, and tiered route links.
 * @param {any} page
 */
export async function capturePageSnapshot(page) {
  /** @type {{ actualPath: string, title: string, headings: string[], breadcrumbs: string[], tableHeaders: string[], hasTable: boolean, tableRowCount: number, filterLabels: string[], buttons: string[], tabs: string[], hasPasswordInput: boolean, hasChart: boolean, a11y: { hasMainLandmark: boolean, hasH1: boolean, inputsMissingLabel: number, imagesMissingAlt: number }, tech: string[], authKeyNames: string[], detectedPortals: Array<{ name: string, mode: string, id?: string | number, notes?: string }>, component: string | null, matchedComponents: Array<{ name: string | null, file: string | null }>, anchors: string[], flatFrameworkRoutes: string[], vueRouteTrees: any[] }} */
  const raw = await page.evaluate(() => {
    /** @param {Element | null | undefined} el */
    const isVisibleActiveEl = (el) => {
      if (!el || !el.isConnected) return false;
      if (el.closest('[class*="-leave-active"], [class*="-leave-to"], [aria-hidden="true"]')) return false;
      /** @type {Element | null} */
      let cur = el;
      while (cur && cur.nodeType === 1) {
        if (cur.getAttribute('aria-hidden') === 'true') return false;
        const st = window.getComputedStyle(cur);
        if (st.display === 'none' || st.visibility === 'hidden') return false;
        cur = cur.parentElement;
      }
      const htmlEl = /** @type {HTMLElement} */ (el);
      const style = window.getComputedStyle(el);
      if (el !== document.body && style.position !== 'fixed' && style.position !== 'sticky' && htmlEl.offsetParent === null) {
        return false;
      }
      return true;
    };

    const mainScope =
      Array.from(document.querySelectorAll('main, [role="main"], .app-main')).find(isVisibleActiveEl) || document.body;

    const buttons = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('button, [role="button"]'))
          .filter(isVisibleActiveEl)
          .map((b) => (b.textContent || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 25);

    const tabs = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('[role="tab"], .el-tabs__item, .ant-tabs-tab'))
          .filter(isVisibleActiveEl)
          .map((t) => (t.textContent || t.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 15);

    const headings = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('h1, h2, h3'))
          .filter(isVisibleActiveEl)
          .map((h) => (h.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 12);

    const tableHeaders = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('table th, [role="columnheader"], .el-table__header th .cell'))
          .filter(isVisibleActiveEl)
          .map((th) => (th.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 20);

    const filterLabels = Array.from(
      new Set(
        Array.from(mainScope.querySelectorAll('label, .el-form-item__label'))
          .filter(isVisibleActiveEl)
          .map((el) => (el.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean)
      )
    ).slice(0, 20);

    const breadcrumbs = Array.from(
      document.querySelectorAll('nav[aria-label*="breadcrumb" i] a, nav[aria-label*="breadcrumb" i] span, .app-breadcrumb .el-breadcrumb__inner')
    )
      .filter(isVisibleActiveEl)
      .map((e) => (e.textContent || '').trim())
      .filter(Boolean);

    const anchors = Array.from(document.querySelectorAll('a[href], [role="menuitem"][href], [data-href], [to]'))
      .filter(isVisibleActiveEl)
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
    const vue3Router = appEl?.__vue_app__?.config?.globalProperties?.$router;
    const vue3Route =
      appEl?.__vue_app__?.config?.globalProperties?.$route || vue3Router?.currentRoute?.value || null;

    if (vueRoot?.$router?.options?.routes) vueRouteTrees.push(serializeTree(vueRoot.$router.options.routes));
    if (vue3Router?.options?.routes) vueRouteTrees.push(serializeTree(vue3Router.options.routes));
    const permState = vueRoot?.$store?.state?.permission;
    if (permState) {
      for (const key of ['sidebarRouters', 'topbarRouters', 'routes', 'addRoutes']) {
        if (Array.isArray(permState[key])) vueRouteTrees.push(serializeTree(permState[key]));
      }
    }
    if (typeof vueRoot?.$router?.getRoutes === 'function') {
      for (const r of vueRoot.$router.getRoutes()) {
        if (r?.path && !r.path.includes(':') && !r.path.includes('*') && !r.hidden && !r.meta?.hidden) {
          flatFrameworkRoutes.push(r.path);
        }
      }
    }
    if (vue3Router && typeof vue3Router.getRoutes === 'function') {
      for (const r of vue3Router.getRoutes()) {
        if (r?.path && !r.path.includes(':') && !r.path.includes('*') && !r.hidden && !r.meta?.hidden) {
          flatFrameworkRoutes.push(r.path);
        }
      }
    }
    if (anyWin.__NEXT_DATA__?.page && typeof anyWin.__NEXT_DATA__.page === 'string' && !anyWin.__NEXT_DATA__.page.includes('[')) {
      flatFrameworkRoutes.push(anyWin.__NEXT_DATA__.page);
    }

    const activeMatchedRaw = vueRoot?.$route?.matched || vue3Route?.matched || [];
    /** @type {Array<{ name: string | null, file: string | null }>} */
    const matchedComponents = [];
    if (Array.isArray(activeMatchedRaw)) {
      for (const rec of activeMatchedRaw) {
        const comp = rec?.components?.default || rec?.component || null;
        const rawFile = comp?.__file || comp?.options?.__file || null;
        const normFile = typeof rawFile === 'string' && rawFile.trim() ? rawFile.trim().replace(/\\/g, '/') : null;
        const rawName = comp?.__name || comp?.name || comp?.options?.name || rec?.name || null;
        const normName = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null;
        if (normFile || normName) {
          matchedComponents.push({ name: normName, file: normFile });
        }
      }
    }
    const leafComp = matchedComponents.length > 0 ? matchedComponents[matchedComponents.length - 1] : null;
    const component = leafComp ? leafComp.file || leafComp.name || null : null;

    const detectedPortals = [];
    const switcherDom = document.querySelectorAll(
      '.sidebar-logo-container, [class*="tenant-switch"], [class*="workspace-switch"], [class*="org-switch"], [class*="portal-switch"], [data-testid*="tenant-switcher"], [data-testid*="workspace-switcher"]'
    );
    if (switcherDom.length > 0) {
      detectedPortals.push({ name: 'Multi-Tenant Switcher', mode: 'switcher', notes: 'Interactive switcher DOM found' });
    }

    const primaryElRows = Array.from(mainScope.querySelectorAll('.el-table__body-wrapper tbody tr.el-table__row')).filter(isVisibleActiveEl);
    const primaryAntRows = Array.from(mainScope.querySelectorAll('.ant-table-body tbody tr.ant-table-row')).filter(isVisibleActiveEl);
    const tableRowCount =
      primaryElRows.length > 0
        ? primaryElRows.length
        : primaryAntRows.length > 0
          ? primaryAntRows.length
          : Array.from(mainScope.querySelectorAll('table tbody tr, [role="row"]')).filter(
              (tr) =>
                isVisibleActiveEl(tr) &&
                !tr.closest('.el-table__fixed, .el-table__fixed-right, .ant-table-fixed-left, .ant-table-fixed-right')
            ).length;

    return {
      actualPath: window.location.pathname,
      title: document.title || '',
      headings,
      breadcrumbs,
      tableHeaders,
      hasTable: Array.from(mainScope.querySelectorAll('table, [role="table"], [role="grid"], .el-table')).some(isVisibleActiveEl),
      tableRowCount,
      filterLabels,
      buttons,
      tabs,
      hasPasswordInput: Array.from(document.querySelectorAll('input[type="password"]')).some(isVisibleActiveEl),
      hasChart: Array.from(mainScope.querySelectorAll('canvas, svg[class*="chart"], .echarts, [class*="chart"]')).some(isVisibleActiveEl),
      a11y: {
        hasMainLandmark: !!document.querySelector('main, [role="main"]'),
        hasH1: Array.from(document.querySelectorAll('h1')).some(isVisibleActiveEl),
        inputsMissingLabel: Array.from(mainScope.querySelectorAll('input:not([type="hidden"])')).filter(
          (i) =>
            isVisibleActiveEl(i) &&
            !i.getAttribute('aria-label') &&
            !i.getAttribute('aria-labelledby') &&
            !(i.id && document.querySelector(`label[for="${i.id.replace(/"/g, '\\"')}"]`))
        ).length,
        imagesMissingAlt: Array.from(mainScope.querySelectorAll('img:not([alt])')).filter(isVisibleActiveEl).length,
      },
      tech,
      authKeyNames: Object.keys(window.localStorage || {}).filter((k) =>
        /token|auth|session|user|platform|tenant|admin/i.test(k)
      ),
      detectedPortals,
      component,
      matchedComponents,
      anchors,
      flatFrameworkRoutes,
      vueRouteTrees,
    };
  });

  const vueInventory = extractVueRouteInventory(raw.vueRouteTrees || []);
  const hiddenSet = new Set(vueInventory.hiddenRoutes);
  const secondarySet = new Set(vueInventory.routes);
  const primaryLinks = raw.anchors.filter((a) => !isNonCrawlableSystemRoute(a));
  const secondaryLinks = vueInventory.routes.filter((r) => !isNonCrawlableSystemRoute(r));
  const fallbackLinks = raw.flatFrameworkRoutes.filter(
    (r) => !hiddenSet.has(r) && !secondarySet.has(r) && !isNonCrawlableSystemRoute(r)
  );
  return {
    ...raw,
    primaryLinks,
    secondaryLinks,
    fallbackLinks,
    discoveredLinks: [...primaryLinks, ...secondaryLinks, ...fallbackLinks],
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
