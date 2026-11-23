import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test as setup, expect } from './fixtures/base';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const authFile = path.resolve(__dirname, '..', 'playwright', '.auth', 'user.json');

export function hasNonEmptyStorageState(filePath: string): boolean {
  if (!fs.existsSync(filePath)) return false;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as {
      cookies?: unknown[];
      origins?: Array<{ localStorage?: unknown[] }>;
    };
    const cookieCount = Array.isArray(data.cookies) ? data.cookies.length : 0;
    const originCount = Array.isArray(data.origins)
      ? data.origins.filter((o) => Array.isArray(o.localStorage) && o.localStorage.length > 0).length
      : 0;
    return cookieCount > 0 || originCount > 0;
  } catch {
    return false;
  }
}

/**
 * Establishes reusable `storageState` (`playwright/.auth/user.json`).
 * - Preserves an existing non-empty storageState (e.g., captured via `aitest auth-login` for SMS/SSO portals)
 *   when `E2E_USERNAME` is not configured.
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

  if (!username) {
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
