import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveQaDirectory } from './agents.mjs';
import { evaluateTargetSafety, loadMergedQaEnv } from './origin-guard.mjs';
import { runProcess } from './proc.mjs';

/**
 * Interactive headed Chromium session capture (`aitest auth-login`).
 * Designed for staging/test environments protected by SMS OTP, SSO, QR login, or human-solved CAPTCHAs.
 * Never attempts to bypass CAPTCHAs or bot challenges: pre-fills optional `--account` and waits
 * for the human operator to complete login and click the on-page Save button (or complete login redirect).
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

  const pwPkg = path.join(qaDir, 'node_modules', 'playwright', 'index.mjs');
  if (!fs.existsSync(pwPkg)) {
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

  const helperScript = `
import fs from 'node:fs';
import { chromium } from ${JSON.stringify(pathToFileURL(pwPkg).href)};

const targetUrl = ${JSON.stringify(targetUrl)};
const account = ${JSON.stringify(account)};
const storageStatePath = ${JSON.stringify(storageStatePath)};
const sessionStoragePath = ${JSON.stringify(sessionStoragePath)};
const timeoutMs = ${timeoutSec * 1000};
const lang = ${JSON.stringify(lang)};

const btnLabel = lang === 'zh'
  ? '✅ 登录成功后点我保存 QA 会话 (Save Session)'
  : '✅ Save QA Session After Login';

const browser = await chromium.launch({ headless: false });
const context = await browser.newContext({ viewport: { width: 1366, height: 860 } });
const page = await context.newPage();

async function ensureFloatingSaveButton() {
  try {
    await page.evaluate((label) => {
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
        window.__aitestSaveNow = true;
        btn.textContent = 'Saving...';
      });
      (document.body || document.documentElement).appendChild(btn);
    }, btnLabel);
  } catch {
    // ignore transient navigation race
  }
}

await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
await page.waitForTimeout(1200).catch(() => {});

// Best-effort non-destructive account prefill (never touches CAPTCHA or submits forms)
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
        if (!current) {
          await el.fill(account);
        }
        break;
      }
    }
  } catch {
    // non-fatal
  }
}

await ensureFloatingSaveButton();

const initialUrl = page.url();
const initialWasLogin = /\\/(login|signin|passport|sso|auth)\\b|#\\/(login|signin)/i.test(initialUrl);
let transitionedAt = null;
const startedAt = Date.now();

while (Date.now() - startedAt < timeoutMs) {
  if (browser.contexts().length === 0 || page.isClosed()) {
    console.error('[auth-login] Browser was closed before session was saved.');
    process.exit(2);
  }

  await ensureFloatingSaveButton();
  const manualClicked = await page.evaluate(() => Boolean(window.__aitestSaveNow)).catch(() => false);
  if (manualClicked) break;

  const curUrl = page.url();
  if (initialWasLogin && curUrl !== initialUrl && !/\\/(login|signin|passport|sso|auth)\\b|#\\/(login|signin)/i.test(curUrl)) {
    if (!transitionedAt) transitionedAt = Date.now();
    if (Date.now() - transitionedAt >= 2500) {
      break;
    }
  } else {
    transitionedAt = null;
  }

  await new Promise((r) => setTimeout(r, 800));
}

if (Date.now() - startedAt >= timeoutMs) {
  console.error('[auth-login] Timed out waiting for interactive login.');
  await browser.close();
  process.exit(3);
}

// Remove helper button before snapshotting state
await page.evaluate(() => {
  document.getElementById('__aitest_auth_helper__')?.remove();
}).catch(() => {});

await context.storageState({ path: storageStatePath });
const sessionDump = await page.evaluate(() => ({
  origin: window.location.origin,
  url: window.location.href,
  entries: Object.entries(window.sessionStorage),
  localStorageKeys: Object.keys(window.localStorage),
})).catch(() => ({ origin: '', url: page.url(), entries: [], localStorageKeys: [] }));

fs.writeFileSync(sessionStoragePath, JSON.stringify(sessionDump, null, 2) + '\\n', 'utf8');
console.log(JSON.stringify({
  saved: true,
  finalUrl: sessionDump.url,
  storageStatePath,
  sessionStoragePath,
  sessionStorageKeys: sessionDump.entries.map(([k]) => k),
  localStorageKeys: sessionDump.localStorageKeys,
}, null, 2));

await browser.close();
`;

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-auth-login-'));
  const scriptPath = path.join(tmpDir, 'capture-auth.mjs');
  fs.writeFileSync(scriptPath, helperScript, 'utf8');

  console.log(
    lang === 'zh'
      ? `\n[auth-login] 正在打开可视化 Chromium 登录窗口: ${targetUrl}\n` +
        `请在弹出的浏览器中完成验证与登录，然后点击页面右下角绿色按钮「✅ 登录成功后点我保存 QA 会话」（或等待登录后自动跳转保存）。`
      : `\n[auth-login] Opening headed Chromium login window: ${targetUrl}\n` +
        `Complete login in the browser and click "✅ Save QA Session After Login" (or wait after redirect).`
  );

  try {
    const res = await runProcess(process.execPath, [scriptPath], {
      cwd: qaDir,
      inheritStdio: true,
      windowsHide: false,
      timeoutMs: (timeoutSec + 15) * 1000,
    });
    return res.code;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
