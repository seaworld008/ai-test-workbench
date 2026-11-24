// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveQaDirectory } from './agents.mjs';
import { resolvePlaywrightPackage } from './core/playwright-resolve.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';

const LOGIN_ROUTE_RE = /\/(login|signin|passport|sso|auth)\b|#\/(login|signin)/i;

/**
 * Validates that an optional `--cdp-url` points strictly to a local loopback CDP endpoint
 * (`127.0.0.1`, `localhost`, or `::1`) so remote debug ports can never be targeted.
 * @param {string} rawUrl
 */
export function validateLoopbackCdpUrl(rawUrl) {
  const trimmed = String(rawUrl || '').trim();
  if (!trimmed) return { ok: false, error: 'Empty --cdp-url value.' };
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: `Invalid --cdp-url "${trimmed}". Expected e.g. http://127.0.0.1:9222` };
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsed.protocol)) {
    return { ok: false, error: `Unsupported --cdp-url protocol "${parsed.protocol}".` };
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
    return {
      ok: false,
      error: `Refusing non-loopback --cdp-url host "${host}". Only localhost / 127.0.0.1 / ::1 are permitted.`,
    };
  }
  return { ok: true, url: parsed.toString() };
}

/**
 * @param {any} context
 * @param {any} page
 * @param {string} expectedOrigin
 * @param {string} storageStatePath
 * @param {string} sessionStoragePath
 * @param {Record<string, unknown>} [extraMeta]
 */
async function saveSessionSnapshot(context, page, expectedOrigin, storageStatePath, sessionStoragePath, extraMeta = {}) {
  await context.storageState({ path: storageStatePath });
  try {
    fs.chmodSync(storageStatePath, 0o600);
  } catch {
    // ignore chmod failures on Windows filesystems
  }
  /** @type {{ origin: string, url: string, entries: [string, string][], localStorageKeys: string[] }} */
  const sessionDump = await page
    .evaluate(() => ({
      origin: window.location.origin,
      url: window.location.href,
      entries: Object.entries(window.sessionStorage),
      localStorageKeys: Object.keys(window.localStorage),
    }))
    .catch(() => ({ origin: expectedOrigin, url: page.url(), entries: [], localStorageKeys: [] }));

  fs.writeFileSync(sessionStoragePath, JSON.stringify(sessionDump, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  console.log(
    JSON.stringify(
      {
        saved: true,
        ...extraMeta,
        finalUrl: sessionDump.url,
        storageStatePath,
        sessionStoragePath,
        sessionStorageKeys: sessionDump.entries.map(([k]) => k),
        localStorageKeys: sessionDump.localStorageKeys,
      },
      null,
      2
    )
  );
}

/** @param {{ chromium: any, cdpUrl: string, expectedOrigin: string, storageStatePath: string, sessionStoragePath: string }} params */
async function captureSessionViaCdp({ chromium, cdpUrl, expectedOrigin, storageStatePath, sessionStoragePath }) {
  const browser = await chromium.connectOverCDP(cdpUrl);
  try {
    const contexts = browser.contexts();
    let matchedContext = null;
    let matchedPage = null;
    /** @type {string[]} */
    const openOrigins = [];
    for (const ctx of contexts) {
      for (const p of ctx.pages()) {
        try {
          const u = new URL(p.url());
          openOrigins.push(u.origin);
          if (u.origin === expectedOrigin && !matchedPage) {
            matchedContext = ctx;
            matchedPage = p;
          }
        } catch {
          // ignore non-URL tabs (about:blank, chrome://)
        }
      }
    }
    if (!matchedContext || !matchedPage) {
      console.error(
        `[auth-login --cdp-url] No open tab matching origin ${expectedOrigin}. Open origins: ${[...new Set(openOrigins)].join(', ')}`
      );
      return 2;
    }
    await saveSessionSnapshot(matchedContext, matchedPage, expectedOrigin, storageStatePath, sessionStoragePath, {
      mode: 'cdp-attach',
    });
    return 0;
  } finally {
    // Disconnect CDP client cleanly without closing the user's browser
    await browser.close().catch(() => {});
  }
}

/** @param {any} page @param {string} btnLabel */
async function ensureFloatingSaveButton(page, btnLabel) {
  try {
    await page.evaluate((/** @type {string} */ label) => {
      if (document.getElementById('__aitest_auth_helper__')) return;
      const btn = document.createElement('button');
      btn.id = '__aitest_auth_helper__';
      btn.type = 'button';
      btn.textContent = label;
      Object.assign(btn.style, {
        position: 'fixed',
        right: '20px',
        bottom: '20px',
        zIndex: '2147483647',
        padding: '10px 16px',
        background: '#059669',
        color: '#ffffff',
        border: '2px solid #064e3b',
        borderRadius: '8px',
        fontSize: '14px',
        fontWeight: '700',
        fontFamily: 'system-ui, sans-serif',
        boxShadow: '0 8px 24px rgba(0,0,0,0.28)',
        cursor: 'pointer',
      });
      btn.addEventListener('click', () => {
        /** @type {any} */ (window).__aitestSaveNow = true;
        btn.textContent = 'Saving...';
      });
      (document.body || document.documentElement).appendChild(btn);
    }, btnLabel);
  } catch {
    // ignore transient navigation race
  }
}

/** @param {{ chromium: any, targetUrl: string, account: string, storageStatePath: string, sessionStoragePath: string, timeoutSec: number, lang: 'zh' | 'en' }} params */
async function captureSessionViaHeadedBrowser({
  chromium,
  targetUrl,
  account,
  storageStatePath,
  sessionStoragePath,
  timeoutSec,
  lang,
}) {
  const timeoutMs = timeoutSec * 1000;
  const btnLabel =
    lang === 'zh'
      ? '✅ 登录成功后点我保存 QA 会话 (Save Session)'
      : '✅ Save QA Session After Login';

  console.log(
    lang === 'zh'
      ? `\n[auth-login] 正在打开可视化 Chromium 登录窗口: ${targetUrl}\n` +
          `请在弹出的浏览器中完成验证与登录，然后点击页面右下角绿色按钮「✅ 登录成功后点我保存 QA 会话」（或等待登录后自动跳转保存）。`
      : `\n[auth-login] Opening headed Chromium login window: ${targetUrl}\n` +
          `Complete login in the browser and click "✅ Save QA Session After Login" (or wait after redirect).`
  );

  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
    const page = await context.newPage();

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(1200).catch(() => {});

    // Best-effort non-destructive account prefill (never touches CAPTCHA/OTP or submits forms)
    if (account) {
      try {
        const candidates = page.locator(
          'input[type="tel"], input[name*="phone" i], input[name*="mobile" i], input[name*="account" i], input[name*="user" i], input[placeholder*="手机"], input[placeholder*="账号"], input[placeholder*="用户名"], input[placeholder*="phone" i], input[placeholder*="account" i], input[type="text"]'
        );
        const count = await candidates.count();
        for (let i = 0; i < count; i += 1) {
          const el = candidates.nth(i);
          if (await el.isVisible()) {
            const placeholder = ((await el.getAttribute('placeholder')) || '') + ((await el.getAttribute('aria-label')) || '');
            if (/验证码|图形|code|captcha|sms|otp/i.test(placeholder)) continue;
            const current = await el.inputValue().catch(() => '');
            if (!current) await el.fill(account);
            break;
          }
        }
      } catch {
        // non-fatal
      }
    }

    await ensureFloatingSaveButton(page, btnLabel);

    const initialUrl = page.url();
    const initialWasLogin = LOGIN_ROUTE_RE.test(initialUrl);
    /** @type {number | null} */
    let transitionedAt = null;
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      if (browser.contexts().length === 0 || page.isClosed()) {
        console.error('[auth-login] Browser was closed before session was saved.');
        return 2;
      }

      await ensureFloatingSaveButton(page, btnLabel);
      const manualClicked = await page.evaluate(() => Boolean(/** @type {any} */ (window).__aitestSaveNow)).catch(() => false);
      if (manualClicked) break;

      const curUrl = page.url();
      if (initialWasLogin && curUrl !== initialUrl && !LOGIN_ROUTE_RE.test(curUrl)) {
        if (!transitionedAt) transitionedAt = Date.now();
        if (Date.now() - transitionedAt >= 2500) break;
      } else {
        transitionedAt = null;
      }

      await new Promise((r) => setTimeout(r, 800));
    }

    if (Date.now() - startedAt >= timeoutMs) {
      console.error('[auth-login] Timed out waiting for interactive login.');
      return 3;
    }

    await page
      .evaluate(() => {
        document.getElementById('__aitest_auth_helper__')?.remove();
      })
      .catch(() => {});

    await saveSessionSnapshot(context, page, '', storageStatePath, sessionStoragePath);
    return 0;
  } finally {
    await browser.close().catch(() => {});
  }
}

/**
 * Interactive headed Chromium session capture (`auth-login`) OR loopback CDP attach (`--cdp-url`).
 * Designed for staging/test environments protected by SMS OTP, SSO, QR login, or human-solved CAPTCHAs.
 * Never attempts to bypass CAPTCHAs or bot challenges: either reuses an already-logged-in local Chrome
 * session over `--cdp-url` (without closing the user's browser) or opens headed Chromium and waits
 * for the human operator to complete login.
 * @param {Record<string, any>} [options]
 */
export async function runAuthLoginCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(options.target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未找到 QA 目录: ${options.target}` : `QA directory not found: ${options.target}`);
    return 1;
  }

  const pwPkg = resolvePlaywrightPackage(qaDir);
  if (!pwPkg) {
    console.error(
      lang === 'zh'
        ? `在 ${qaDir} 中未找到 playwright 包，请先安装依赖。`
        : `playwright package not found in ${qaDir}. Install dependencies first.`
    );
    return 1;
  }

  const mergedEnv = loadMergedQaEnv(qaDir);
  if (options.baseUrl) {
    mergedEnv.TEST_BASE_URL = options.baseUrl;
  }
  const safety = evaluateTargetSafety(mergedEnv);
  if (!safety.ok || !safety.baseURL) {
    const errs = safety.errors.length > 0 ? safety.errors : ['TEST_BASE_URL is required for auth-login.'];
    for (const e of errs) {
      console.error(`[Target Guard Blocked] ${e}`);
    }
    return 2;
  }

  const loginPath = options.loginPath || '/';
  const targetUrl = new URL(loginPath, safety.baseURL).toString();
  const authDir = path.join(qaDir, 'playwright', '.auth');
  const storageStatePath = path.join(authDir, 'user.json');
  const sessionStoragePath = path.join(authDir, 'session.json');
  const timeoutSec = Math.max(30, Number(options.timeout || 600));
  const account = options.account ? String(options.account).trim() : '';

  fs.mkdirSync(authDir, { recursive: true });

  const { chromium } = await import(pathToFileURL(pwPkg).href);

  if (options.cdpUrl) {
    const cdpCheck = validateLoopbackCdpUrl(options.cdpUrl);
    if (!cdpCheck.ok || !cdpCheck.url) {
      console.error(`[Target Guard Blocked] ${cdpCheck.error}`);
      return 2;
    }
    const expectedOrigin = new URL(safety.baseURL).origin;
    return captureSessionViaCdp({
      chromium,
      cdpUrl: cdpCheck.url,
      expectedOrigin,
      storageStatePath,
      sessionStoragePath,
    });
  }

  return captureSessionViaHeadedBrowser({
    chromium,
    targetUrl,
    account,
    storageStatePath,
    sessionStoragePath,
    timeoutSec,
    lang,
  });
}
