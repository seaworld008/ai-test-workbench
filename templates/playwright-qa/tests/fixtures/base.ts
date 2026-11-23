import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from '@playwright/test';
import {
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  DEFAULT_BLOCKED_ENDPOINTS,
  parseCsvList,
  parseLowerCsvList,
} from '../../support/target-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sessionAuthFile = path.resolve(__dirname, '..', '..', 'playwright', '.auth', 'session.json');

export type WorkbenchOptions = {
  failOnPageError: boolean;
  failOnServerError: boolean;
};

type InternalFixtures = {
  workbenchGuard: void;
};

function compileOptionalRegexList(raw: string | undefined): RegExp[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern, 'i'));
}

function buildRequestGuardConfig(baseURL: string | undefined) {
  const deniedOrigins = parseLowerCsvList(process.env.TEST_DENIED_ORIGINS ?? '');
  const blockedRules = compileBlockedEndpointRules(
    process.env.TEST_BLOCKED_ENDPOINTS ?? DEFAULT_BLOCKED_ENDPOINTS
  );
  const strictReadonly =
    process.env.TEST_STRICT_READONLY === '1' || process.env.TEST_STRICT_READONLY === 'true';
  const safeWritePaths = parseCsvList(
    process.env.TEST_SAFE_WRITE_PATHS ?? '/api/login,/api/auth/login,/graphql,/__test__/reset'
  );
  return { baseURL, deniedOrigins, blockedRules, strictReadonly, safeWritePaths };
}

function wrapApiRequestContext(
  rawRequest: APIRequestContext,
  guardConfig: ReturnType<typeof buildRequestGuardConfig>
): APIRequestContext {
  const interceptedMethods = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'fetch']);

  return new Proxy(rawRequest, {
    get(target, prop, receiver) {
      const orig = Reflect.get(target, prop, receiver);
      if (typeof prop !== 'string' || !interceptedMethods.has(prop) || typeof orig !== 'function') {
        return typeof orig === 'function' ? orig.bind(target) : orig;
      }

      return async (urlOrReq: string | { url(): string; method(): string }, options?: Record<string, unknown>) => {
        const rawUrl = typeof urlOrReq === 'string' ? urlOrReq : urlOrReq.url();
        const method =
          prop === 'fetch'
            ? String(options?.method || (typeof urlOrReq === 'string' ? 'GET' : urlOrReq.method()) || 'GET')
            : prop.toUpperCase();

        const check = checkOutgoingRequestSafety(method, rawUrl, guardConfig);
        if (check.blocked) {
          throw new Error(`[AI Test Workbench Request Guard] ${check.reason}`);
        }
        return orig.call(target, urlOrReq, options);
      };
    },
  });
}

function loadSavedSessionStorage(): { origin: string; entries: Array<[string, string]> } | null {
  if (!fs.existsSync(sessionAuthFile)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(sessionAuthFile, 'utf8')) as {
      origin?: string;
      entries?: Array<[string, string]>;
    };
    if (parsed.origin && Array.isArray(parsed.entries) && parsed.entries.length > 0) {
      return { origin: parsed.origin, entries: parsed.entries };
    }
    return null;
  } catch {
    return null;
  }
}

export const test = base.extend<WorkbenchOptions & InternalFixtures>({
  failOnPageError: [process.env.FAIL_ON_PAGEERROR !== '0', { option: true }],
  failOnServerError: [process.env.FAIL_ON_SERVER_5XX !== '0', { option: true }],

  request: async ({ request, baseURL }, use) => {
    const guardConfig = buildRequestGuardConfig(baseURL);
    const wrapped = wrapApiRequestContext(request, guardConfig);
    await use(wrapped);
  },

  workbenchGuard: [
    async ({ page, baseURL, failOnPageError, failOnServerError }, use, testInfo) => {
      const onlineProjects = new Set(['e2e', 'api', 'setup']);
      if (onlineProjects.has(testInfo.project.name) && !baseURL) {
        throw new Error(
          `[AI Test Workbench Config Error] Project "${testInfo.project.name}" requires TEST_BASE_URL to be configured.`
        );
      }

      // Restore captured sessionStorage for interactive SMS/SSO logins when running e2e/seed
      if (testInfo.project.name === 'e2e' || testInfo.project.name === 'seed') {
        const sessionData = loadSavedSessionStorage();
        if (sessionData) {
          await page.context().addInitScript(
            ({ targetOrigin, entries }) => {
              if (window.location.origin === targetOrigin) {
                for (const [k, v] of entries) {
                  window.sessionStorage.setItem(k, v);
                }
              }
            },
            { targetOrigin: sessionData.origin, entries: sessionData.entries }
          );
        }
      }

      const guardConfig = buildRequestGuardConfig(baseURL);
      const ignorePageErrorPatterns = compileOptionalRegexList(process.env.TEST_IGNORE_PAGEERROR_PATTERNS);
      const ignore5xxPatterns = compileOptionalRegexList(process.env.TEST_IGNORE_5XX_PATTERNS);

      const blockedRequests: string[] = [];
      const pageErrors: string[] = [];
      const serverErrors: string[] = [];

      const baseOrigin = baseURL ? new URL(baseURL).origin.toLowerCase() : null;

      await page.route('**/*', async (route) => {
        const req = route.request();
        const check = checkOutgoingRequestSafety(req.method(), req.url(), guardConfig);
        if (check.blocked && check.reason) {
          blockedRequests.push(check.reason);
          await route.abort('blockedbyclient');
          return;
        }
        await route.continue();
      });

      page.on('pageerror', (err) => {
        const msg = err?.stack || err?.message || String(err);
        if (!ignorePageErrorPatterns.some((re) => re.test(msg))) {
          pageErrors.push(msg);
        }
      });

      page.on('response', (res) => {
        const status = res.status();
        if (status < 500) return;
        const url = res.url();
        try {
          const resOrigin = new URL(url).origin.toLowerCase();
          if (baseOrigin && resOrigin !== baseOrigin) return;
        } catch {
          return;
        }
        const summary = `${status} ${res.request().method()} ${url}`;
        if (!ignore5xxPatterns.some((re) => re.test(summary))) {
          serverErrors.push(summary);
        }
      });

      await use();

      if (blockedRequests.length > 0 || pageErrors.length > 0 || serverErrors.length > 0) {
        await testInfo.attach('workbench-runtime-guard.json', {
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({ blockedRequests, pageErrors, serverErrors }, null, 2),
            'utf8'
          ),
        });
      }

      if (blockedRequests.length > 0) {
        throw new Error(`[AI Test Workbench Network Guard]\n${blockedRequests.join('\n')}`);
      }
      if (failOnPageError && pageErrors.length > 0) {
        throw new Error(`[Uncaught PageError Guard]\n${pageErrors.join('\n')}`);
      }
      if (failOnServerError && serverErrors.length > 0) {
        throw new Error(`[Same-Origin 5xx Guard]\n${serverErrors.join('\n')}`);
      }
    },
    { auto: true },
  ],
});

export { expect };

/**
 * Runs an automated axe-core scan for WCAG 2.0/2.1/2.2 Level A & AA rules.
 * Note: Automated axe checks catch machine-detectable violations (~40-50% of WCAG issues)
 * and do not by themselves constitute full legal accessibility certification.
 */
export async function expectAccessible(
  page: Page,
  options: { exclude?: string[]; disableRules?: string[] } = {}
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag22aa']);
  for (const selector of options.exclude || []) {
    builder = builder.exclude(selector);
  }
  if (options.disableRules && options.disableRules.length > 0) {
    builder = builder.disableRules(options.disableRules);
  }
  const results = await builder.analyze();
  const summary = results.violations.map(
    (v) => `[${v.impact || 'unknown'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`
  );
  expect(summary, `Automated WCAG A/AA axe violations:\n${summary.join('\n')}`).toEqual([]);
}

/**
 * Validates HTTP status and JSON contract shape cleanly without external schema libraries.
 */
export async function expectApiContract<T = unknown>(
  response: APIResponse,
  expectedStatus: number,
  validator?: (body: T) => void
): Promise<T> {
  expect(
    response.status(),
    `Expected HTTP ${expectedStatus} from ${response.url()}, got ${response.status()}`
  ).toBe(expectedStatus);
  const body = (await response.json()) as T;
  if (validator) {
    validator(body);
  }
  return body;
}
