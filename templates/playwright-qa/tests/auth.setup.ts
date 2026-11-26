import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as setup, expect } from './fixtures/base';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.resolve(__dirname, '..', 'playwright', '.auth', 'user.json');

type StorageStateDoc = {
  cookies?: Array<{
    name?: string;
    value?: string;
    domain?: string;
    path?: string;
    expires?: number;
    secure?: boolean;
  }>;
  origins?: Array<{
    origin?: string;
    localStorage?: Array<{ name?: string; value?: string }>;
  }>;
};

export function hasNonEmptyStorageState(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StorageStateDoc;
    const cookieCount = Array.isArray(data.cookies) ? data.cookies.length : 0;
    const originCount = Array.isArray(data.origins)
      ? data.origins.filter((o) => Array.isArray(o.localStorage) && o.localStorage.length > 0).length
      : 0;
    return cookieCount > 0 || originCount > 0;
  } catch {
    return false;
  }
}

function buildPingAuthHeaders(filePath: string, pingUrl: URL): Record<string, string> {
  const headers: Record<string, string> = {};
  let data: StorageStateDoc;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as StorageStateDoc;
  } catch {
    return headers;
  }

  const nowSec = Date.now() / 1000;
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  const host = pingUrl.hostname.toLowerCase();
  const matchedCookies = cookies.filter((c) => {
    if (!c?.name) return false;
    if (typeof c.expires === 'number' && c.expires > 0 && c.expires < nowSec) return false;
    if (c.secure && pingUrl.protocol !== 'https:') return false;
    const dom = String(c.domain || '').trim().toLowerCase();
    const domMatch = dom.startsWith('.')
      ? host === dom.slice(1) || host.endsWith(dom)
      : host === dom;
    return domMatch && pingUrl.pathname.startsWith(String(c.path || '/'));
  });
  if (matchedCookies.length > 0) {
    headers.cookie = matchedCookies.map((c) => `${c.name}=${c.value ?? ''}`).join('; ');
  }

  const origins = Array.isArray(data.origins) ? data.origins : [];
  const orderedOrigins = [
    ...origins.filter((o) => String(o?.origin || '').toLowerCase() === pingUrl.origin.toLowerCase()),
    ...origins.filter((o) => String(o?.origin || '').toLowerCase() !== pingUrl.origin.toLowerCase()),
  ];
  const lsMap = new Map<string, string>();
  for (const originEntry of orderedOrigins) {
    for (const item of originEntry.localStorage || []) {
      if (item?.name && item.value !== undefined && !lsMap.has(item.name)) {
        lsMap.set(item.name, String(item.value));
      }
    }
  }

  for (const tokenKey of ['ACCESS_TOKEN', 'accessToken', 'token']) {
    const val = lsMap.get(tokenKey)?.trim();
    if (val) {
      headers.authorization = /^Bearer\s+/i.test(val) ? val : `Bearer ${val}`;
      break;
    }
  }

  const platformId = lsMap.get('PLATFORM_ID')?.trim();
  if (platformId) {
    headers['platform-id'] = platformId;
  }

  return headers;
}

/**
 * Establishes reusable `storageState` (`playwright/.auth/user.json`).
 * - Preserves an existing non-empty storageState (e.g., captured via `auth-login` for SMS/SSO portals)
 *   when `E2E_USERNAME` is not configured, optionally verifying session freshness via `E2E_SESSION_PING_PATH`.
 * - Only posts credentials when `E2E_USERNAME` is explicitly set in `.env`.
 */
setup('establish QA session storageState', async ({ request, page, baseURL }) => {
  if (!baseURL) {
    throw new Error('TEST_BASE_URL is required for authentication setup.');
  }

  fs.mkdirSync(path.dirname(authFile), { recursive: true });

  const username = process.env.E2E_USERNAME?.trim() || '';
  const password = process.env.E2E_PASSWORD ?? '';
  const loginPath = process.env.E2E_AUTH_LOGIN_PATH?.trim() || '/api/login';
  const sessionPingPath = process.env.E2E_SESSION_PING_PATH?.trim() || '';

  if (!username) {
    if (fs.existsSync(authFile) && sessionPingPath) {
      const pingUrl = new URL(sessionPingPath, baseURL);
      const pingHeaders = buildPingAuthHeaders(authFile, pingUrl);
      const pingRes = await request.get(pingUrl.toString(), { headers: pingHeaders });
      const status = pingRes.status();
      const body = (await pingRes.json().catch(() => null)) as { code?: unknown } | null;
      const bodyCode = body && typeof body === 'object' ? body.code : undefined;
      if (status === 401 || status === 403 || bodyCode === 401 || bodyCode === 403) {
        throw new Error(
          `[Session Expired] Saved QA storageState failed session ping GET ${pingUrl.pathname} (http=${status}, code=${String(bodyCode ?? 'n/a')}). Re-run "npx ai-test-workbench@6.5.0 auth-login --target <repo>" to refresh playwright/.auth/user.json.`
        );
      }
    }
    if (hasNonEmptyStorageState(authFile)) {
      expect(fs.existsSync(authFile)).toBe(true);
      return;
    }
    await page.context().storageState({ path: authFile });
    expect(fs.existsSync(authFile)).toBe(true);
    return;
  }

  const loginRes = await request.post(loginPath, {
    data: { username, password },
  });

  if (!loginRes.ok()) {
    throw new Error(
      `QA API login failed (${loginRes.status()}) at ${loginPath} for user "${username}". Check E2E_USERNAME / E2E_PASSWORD / E2E_AUTH_LOGIN_PATH.`
    );
  }

  const payload = (await loginRes.json()) as { token?: string; user?: Record<string, unknown> };
  await page.goto('/');
  await page.evaluate(
    ({ token, user }) => {
      if (token) localStorage.setItem('qa_auth_token', token);
      if (user) localStorage.setItem('qa_auth_user', JSON.stringify(user));
    },
    { token: payload.token || '', user: payload.user || { username } }
  );

  await page.context().storageState({ path: authFile });
  expect(fs.existsSync(authFile)).toBe(true);
});
