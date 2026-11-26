// @ts-check
import { closeVisibleOverlays } from './transition-wait.mjs';

export const PORTAL_CIRCUIT_BREAKER_REASON = 'AUTH_SWITCH_BLOCKED_OR_UNAUTHORIZED';
export const PORTAL_AUTH_EXCHANGE_RE = /(?:refresh[-_]?token|switch[-_]?tenant|exchange[-_]?token)/i;

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

/**
 * Checks whether a portal switch triggered a blocked auth/token-exchange POST request.
 * @param {Array<{ method?: string, endpoint?: string }>} blockedWriteRequests
 * @param {number} beforeCount
 * @returns {{ tripped: boolean, reason: string | null, endpoint: string | null }}
 */
export function detectBlockedPortalAuthExchange(blockedWriteRequests, beforeCount) {
  const recent = (blockedWriteRequests || []).slice(Math.max(0, beforeCount));
  const hit = recent.find(
    (r) => String(r?.method || '').toUpperCase() === 'POST' && PORTAL_AUTH_EXCHANGE_RE.test(String(r?.endpoint || ''))
  );
  if (!hit) return { tripped: false, reason: null, endpoint: null };
  return {
    tripped: true,
    reason: PORTAL_CIRCUIT_BREAKER_REASON,
    endpoint: String(hit.endpoint || ''),
  };
}

/**
 * Trips the sub-portal circuit breaker when the first 3 probed routes all fail with HTTP 401/403
 * or envelope `{ code: 401 | 403 }`.
 * @param {{ isPrimaryPortal: boolean, probedCount: number, unauthorizedInFirstThree: number }} stats
 */
export function shouldTripPortalUnauthorizedBreaker(stats) {
  return !stats.isPrimaryPortal && stats.probedCount <= 3 && stats.probedCount >= 3 && stats.unauthorizedInFirstThree >= 3;
}
