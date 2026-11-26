import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import {
  test as base,
  expect,
  type APIRequestContext,
  type APIResponse,
  type BrowserContext,
  type Page,
  type TestInfo,
} from '@playwright/test';
import {
  MAX_REDIRECT_HOPS,
  REDIRECT_STATUSES,
  checkOutgoingRequestSafety,
  compileBlockedEndpointRules,
  computeNextRedirectRequest,
  DEFAULT_BLOCKED_ENDPOINTS,
  DEFAULT_SAFE_WRITE_PATHS,
  loadMergedQaEnv,
  parseCsvList,
  parseLowerCsvList,
  resolveDefaultMutationPolicy,
  shouldAbortThirdPartyRequest,
} from '../../support/target-guard.mjs';
import {
  extractOpenApiResponseSchema,
  validateJsonSchema,
} from '../../support/schema-validator.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const qaRootDir = path.resolve(__dirname, '..', '..');
const sessionAuthFile = path.resolve(qaRootDir, 'playwright', '.auth', 'session.json');
const aitestConfigFile = path.resolve(qaRootDir, 'aitest.config.json');

/**
 * Locked WCAG 2.0 / 2.1 / 2.2 Level A & AA axe-core tag set (`P-03`).
 */
export const WCAG_AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] as const;

const TRACE_HEADER_NAMES = [
  'traceparent',
  'x-trace-id',
  'trace-id',
  'x-correlation-id',
  'x-request-id',
  'tid',
  'sw8',
  'eagleeye-traceid',
  'x-b3-traceid',
] as const;

const MAX_TRACE_IDS = 24;

export type WorkbenchOptions = {
  failOnPageError: boolean;
  failOnServerError: boolean;
};

type InternalFixtures = {
  workbenchGuard: void;
};

type TraceProtocol = 'w3c' | 'sw8' | 'all';

type TestTraceState = {
  traceId: string;
  spanId: string;
  traceparent: string;
  traceProtocol: TraceProtocol;
  observedTraceIds: string[];
  seenTraceIds: Set<string>;
  recordResponseHeaders: (headers: Record<string, string | undefined>) => void;
  buildTraceIds: (sw8Used: string | null) => string[];
};

const testTraceStateMap = new WeakMap<TestInfo, TestTraceState>();

function compileOptionalRegexList(raw: string | undefined): RegExp[] {
  if (!raw || !raw.trim()) return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pattern) => new RegExp(pattern, 'i'));
}

function resolveTraceProtocol(mergedEnv: Record<string, string | undefined>): TraceProtocol {
  const fromEnv = String(mergedEnv.TEST_TRACE_PROTOCOL || '').trim().toLowerCase();
  if (fromEnv === 'w3c' || fromEnv === 'sw8' || fromEnv === 'all') {
    return fromEnv;
  }
  if (fs.existsSync(aitestConfigFile)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(aitestConfigFile, 'utf8')) as {
        observability?: { traceProtocol?: string };
      };
      const fromCfg = String(cfg?.observability?.traceProtocol || '').trim().toLowerCase();
      if (fromCfg === 'w3c' || fromCfg === 'sw8' || fromCfg === 'all') {
        return fromCfg;
      }
    } catch {
      // ignore malformed config here; gate checks it separately
    }
  }
  return 'w3c';
}

function buildSkyWalkingSw8Header(traceId: string, spanId: string, targetHost: string): string {
  const b64 = (v: string) => Buffer.from(v, 'utf8').toString('base64');
  return [
    '1',
    b64(traceId),
    b64(`${traceId}.${spanId}`),
    '0',
    b64('ai-test-workbench'),
    b64('playwright-qa'),
    b64('/'),
    b64(targetHost || 'localhost'),
  ].join('-');
}

function getOrCreateTraceState(testInfo: TestInfo, mergedEnv: Record<string, string | undefined>): TestTraceState {
  const existing = testTraceStateMap.get(testInfo);
  if (existing) return existing;

  const traceId = crypto.randomBytes(16).toString('hex');
  const spanId = crypto.randomBytes(8).toString('hex');
  const traceparent = `00-${traceId}-${spanId}-01`;
  const traceProtocol = resolveTraceProtocol(mergedEnv);
  const observedTraceIds: string[] = [];
  const seenTraceIds = new Set<string>();

  const state: TestTraceState = {
    traceId,
    spanId,
    traceparent,
    traceProtocol,
    observedTraceIds,
    seenTraceIds,
    recordResponseHeaders(headers) {
      if (!headers || typeof headers !== 'object') return;
      const lowerHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(headers)) {
        if (typeof v === 'string' && v.trim()) {
          lowerHeaders[k.toLowerCase()] = v.trim();
        }
      }
      for (const hName of TRACE_HEADER_NAMES) {
        const hVal = lowerHeaders[hName];
        if (!hVal) continue;
        const entry = `${hName}:${hVal.slice(0, 128)}`;
        if (!seenTraceIds.has(entry) && observedTraceIds.length < MAX_TRACE_IDS) {
          seenTraceIds.add(entry);
          observedTraceIds.push(entry);
        }
      }
    },
    buildTraceIds(sw8Used) {
      const combined = [...observedTraceIds];
      const fallbackTp = `traceparent:${traceparent}`;
      if (combined.length < MAX_TRACE_IDS && !seenTraceIds.has(fallbackTp)) {
        combined.push(fallbackTp);
      }
      if (sw8Used && combined.length < MAX_TRACE_IDS) {
        const fallbackSw8 = `sw8:${sw8Used}`;
        if (!seenTraceIds.has(fallbackSw8)) {
          combined.push(fallbackSw8);
        }
      }
      return combined.slice(0, MAX_TRACE_IDS);
    },
  };

  testTraceStateMap.set(testInfo, state);
  return state;
}

function buildRequestGuardConfig(
  baseURL: string | undefined,
  envMap: Record<string, string | undefined>
) {
  let defaultAllowedHosts = ['127.0.0.1', 'localhost'];
  if (baseURL && envMap.TEST_ALLOWED_HOSTS === undefined) {
    try {
      const bp = new URL(baseURL);
      const h = bp.hostname.toLowerCase();
      if ((h === '127.0.0.1' || h === 'localhost' || h === '::1') && bp.port) {
        defaultAllowedHosts = [`127.0.0.1:${bp.port}`, `localhost:${bp.port}`];
      }
    } catch {
      // fallback to default loopback hosts
    }
  }
  const allowedHosts =
    envMap.TEST_ALLOWED_HOSTS !== undefined
      ? parseLowerCsvList(envMap.TEST_ALLOWED_HOSTS)
      : defaultAllowedHosts;
  const allowedOrigins = parseLowerCsvList(envMap.TEST_ALLOWED_ORIGINS ?? '');
  const deniedOrigins = parseLowerCsvList(envMap.TEST_DENIED_ORIGINS ?? '');
  const extraEgressHosts = parseLowerCsvList(envMap.TEST_EGRESS_EXTRA_HOSTS ?? envMap.TEST_EGRESS_ALLOW_HOSTS ?? '');
  const egressMode = (envMap.TEST_EGRESS_MODE ?? 'allowlist').trim().toLowerCase();
  const blockedRules = compileBlockedEndpointRules(
    envMap.TEST_BLOCKED_ENDPOINTS ?? DEFAULT_BLOCKED_ENDPOINTS
  );
  const mutationPolicy = resolveDefaultMutationPolicy(envMap, baseURL);
  const strictReadonly = mutationPolicy.strictReadonly;
  const safeWritePaths = parseCsvList(
    envMap.TEST_SAFE_WRITE_PATHS ?? DEFAULT_SAFE_WRITE_PATHS
  );
  const allowGraphqlQuery = envMap.TEST_ALLOW_GRAPHQL_QUERY === '1';

  return {
    baseURL,
    allowedHosts,
    allowedOrigins,
    deniedOrigins,
    extraEgressHosts,
    egressMode,
    blockedRules,
    strictReadonly,
    safeWritePaths,
    allowGraphqlQuery,
  };
}

function isAllowedTraceTarget(
  rawUrl: string,
  guardConfig: ReturnType<typeof buildRequestGuardConfig>
): { allowed: boolean; targetHost: string } {
  try {
    const parsed = new URL(rawUrl, guardConfig.baseURL || 'http://localhost');
    const origin = parsed.origin.toLowerCase();
    const host = parsed.hostname.toLowerCase();
    const hostPort = parsed.host.toLowerCase();
    const baseOrigin = guardConfig.baseURL ? new URL(guardConfig.baseURL).origin.toLowerCase() : null;
    const allowed =
      Boolean(baseOrigin && origin === baseOrigin) ||
      guardConfig.allowedOrigins.includes(origin) ||
      guardConfig.allowedHosts.includes(host) ||
      guardConfig.allowedHosts.includes(hostPort) ||
      guardConfig.extraEgressHosts.includes(host) ||
      guardConfig.extraEgressHosts.includes(hostPort);
    return { allowed, targetHost: hostPort || 'localhost' };
  } catch {
    return { allowed: false, targetHost: 'localhost' };
  }
}

function injectTraceHeaders(
  headers: Record<string, string>,
  rawUrl: string,
  guardConfig: ReturnType<typeof buildRequestGuardConfig>,
  traceState: TestTraceState
): string | null {
  const hasKey = (name: string) =>
    Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase());
  const target = isAllowedTraceTarget(rawUrl, guardConfig);
  if (!target.allowed) return null;

  if (!hasKey('traceparent')) {
    headers.traceparent = traceState.traceparent;
  }
  if ((traceState.traceProtocol === 'sw8' || traceState.traceProtocol === 'all') && !hasKey('sw8')) {
    const sw8 = buildSkyWalkingSw8Header(traceState.traceId, traceState.spanId, target.targetHost);
    headers.sw8 = sw8;
    return sw8;
  }
  return null;
}

function serializeBodyOption(dataOpt: unknown): string | null {
  if (dataOpt === undefined || dataOpt === null) return null;
  if (typeof dataOpt === 'string') return dataOpt;
  try {
    return JSON.stringify(dataOpt);
  } catch {
    return null;
  }
}

function wrapApiRequestContext(
  rawRequest: APIRequestContext,
  guardConfig: ReturnType<typeof buildRequestGuardConfig>,
  traceState: TestTraceState
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
        const initialMethod =
          prop === 'fetch'
            ? String(options?.method || (typeof urlOrReq === 'string' ? 'GET' : urlOrReq.method()) || 'GET').toUpperCase()
            : prop.toUpperCase();
        const initialHeaders: Record<string, string> = {
          ...((options?.headers as Record<string, string> | undefined) || {}),
        };
        injectTraceHeaders(initialHeaders, rawUrl, guardConfig, traceState);

        let curMethod = initialMethod;
        let curUrl = rawUrl;
        let curHeaders = initialHeaders;
        let curData: unknown = options?.data;
        let curBodyText = serializeBodyOption(curData);

        const initCheck = checkOutgoingRequestSafety(curMethod, curUrl, { ...guardConfig, postData: curBodyText });
        if (initCheck.blocked) {
          throw new Error(`[AI Test Workbench Request Guard] ${initCheck.reason}`);
        }

        const firstOptions: Record<string, unknown> = {
          ...(options || {}),
          headers: curHeaders,
          maxRedirects: 0,
        };
        let response: APIResponse = await orig.call(target, urlOrReq, firstOptions);

        for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
          const status = response.status();
          const location = response.headers()?.location;
          if (!REDIRECT_STATUSES.has(status) || !location) {
            traceState.recordResponseHeaders(response.headers());
            return response;
          }
          const resolvedBase = new URL(curUrl, guardConfig.baseURL || 'http://localhost').toString();
          const next = computeNextRedirectRequest(curMethod, status, location, resolvedBase, curHeaders);
          curMethod = next.method;
          curUrl = next.url;
          curHeaders = next.headers;
          if (next.dropBody) {
            curData = undefined;
            curBodyText = null;
          }
          const hopCheck = checkOutgoingRequestSafety(curMethod, curUrl, {
            ...guardConfig,
            postData: curBodyText,
          });
          if (hopCheck.blocked) {
            throw new Error(`[AI Test Workbench Request Guard] Redirect hop blocked: ${hopCheck.reason}`);
          }
          response = await target.fetch(curUrl, {
            method: curMethod,
            headers: curHeaders,
            ...(curData !== undefined ? { data: curData } : {}),
            maxRedirects: 0,
          });
        }

        const finalStatus = response.status();
        if (REDIRECT_STATUSES.has(finalStatus) && response.headers()?.location) {
          throw new Error(`[AI Test Workbench Request Guard] Redirect chain exceeded ${MAX_REDIRECT_HOPS} hops`);
        }
        traceState.recordResponseHeaders(response.headers());
        return response;
      };
    },
  });
}

/**
 * Wraps `.request` getter on `BrowserContext` or `Page` so `page.request` and `context.request`
 * cannot bypass `checkOutgoingRequestSafety` (`S-04`).
 */
function guardRequestPropertyOnObject(
  owner: BrowserContext | Page,
  guardConfig: ReturnType<typeof buildRequestGuardConfig>,
  traceState: TestTraceState
): void {
  try {
    const rawReq = owner.request;
    if (!rawReq) return;
    const wrapped = wrapApiRequestContext(rawReq, guardConfig, traceState);
    Object.defineProperty(owner, 'request', {
      configurable: true,
      enumerable: true,
      get: () => wrapped,
    });
  } catch {
    // non-configurable fallback
  }
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

  request: async ({ request, baseURL }, use, testInfo) => {
    const mergedEnv = loadMergedQaEnv(qaRootDir, process.env as Record<string, string | undefined>);
    const guardConfig = buildRequestGuardConfig(baseURL, mergedEnv);
    const traceState = getOrCreateTraceState(testInfo, mergedEnv);
    const wrapped = wrapApiRequestContext(request, guardConfig, traceState);
    await use(wrapped);
  },

  workbenchGuard: [
    async ({ page, context, baseURL, failOnPageError, failOnServerError }, use, testInfo) => {
      const onlineProjects = new Set(['e2e', 'api', 'setup']);
      if (onlineProjects.has(testInfo.project.name) && !baseURL) {
        throw new Error(
          `[AI Test Workbench Config Error] Project "${testInfo.project.name}" requires TEST_BASE_URL to be configured.`
        );
      }

      const mergedEnv = loadMergedQaEnv(qaRootDir, process.env as Record<string, string | undefined>);
      const abortEnv = {
        ...mergedEnv,
        ...(baseURL ? { TEST_BASE_URL: mergedEnv.TEST_BASE_URL || baseURL } : {}),
      };
      const traceState = getOrCreateTraceState(testInfo, mergedEnv);
      const guardConfig = buildRequestGuardConfig(baseURL, mergedEnv);
      const preserveIdleTimestamps = mergedEnv.TEST_PRESERVE_IDLE_TIMESTAMPS === '1';

      // Pre-install buffered PerformanceObserver for real LCP / CLS / INP collection (`P-01`)
      // and refresh client-side numeric idle timestamps unless TEST_PRESERVE_IDLE_TIMESTAMPS=1
      await context.addInitScript(({ preserveIdle }) => {
        if (!preserveIdle) {
          try {
            const nowStr = String(Date.now());
            for (const key of ['lastRecordTime', 'lastActiveTime', 'lastActivityTime']) {
              const cur = window.localStorage.getItem(key);
              if (cur !== null && /^\d{10,13}$/.test(cur.trim())) {
                window.localStorage.setItem(key, nowStr);
              }
            }
          } catch {
            // ignore opaque storage origins
          }
        }

        const w = window as unknown as {
          __aitestVitals?: { lcpMs: number | null; cls: number; inpMs: number | null };
        };
        w.__aitestVitals = { lcpMs: null, cls: 0, inpMs: null };
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as Array<PerformanceEntry & { renderTime?: number; loadTime?: number }>) {
              const t = entry.renderTime || entry.loadTime || entry.startTime;
              if (typeof t === 'number') w.__aitestVitals!.lcpMs = Math.round(t);
            }
          }).observe({ type: 'largest-contentful-paint', buffered: true });
        } catch {
          // unsupported entry type
        }
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as Array<PerformanceEntry & { hadRecentInput?: boolean; value?: number }>) {
              if (!entry.hadRecentInput && typeof entry.value === 'number') {
                w.__aitestVitals!.cls += entry.value;
              }
            }
          }).observe({ type: 'layout-shift', buffered: true });
        } catch {
          // unsupported entry type
        }
        try {
          new PerformanceObserver((list) => {
            for (const entry of list.getEntries() as Array<PerformanceEntry & { interactionId?: number }>) {
              if (entry.interactionId && typeof entry.duration === 'number') {
                w.__aitestVitals!.inpMs = Math.max(w.__aitestVitals!.inpMs ?? 0, Math.round(entry.duration));
              }
            }
          }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
        } catch {
          // unsupported entry type
        }
      }, { preserveIdle: preserveIdleTimestamps });

      // Restore captured sessionStorage for interactive SMS/SSO logins when running e2e/seed
      if (testInfo.project.name === 'e2e' || testInfo.project.name === 'seed') {
        const sessionData = loadSavedSessionStorage();
        if (sessionData) {
          await context.addInitScript(
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

      const ignorePageErrorPatterns = compileOptionalRegexList(mergedEnv.TEST_IGNORE_PAGEERROR_PATTERNS);
      const ignore5xxPatterns = compileOptionalRegexList(mergedEnv.TEST_IGNORE_5XX_PATTERNS);

      const blockedRequests: string[] = [];
      const pageErrors: string[] = [];
      const serverErrors: string[] = [];
      let sw8Used: string | null = null;
      const startedAtIso = new Date().toISOString();

      const isWatched5xxOrigin = (url: string): boolean => isAllowedTraceTarget(url, guardConfig).allowed;

      const attachPageRuntimeGuards = (targetPage: Page) => {
        guardRequestPropertyOnObject(targetPage, guardConfig, traceState);
        targetPage.on('pageerror', (err) => {
          const msg = err?.stack || err?.message || String(err);
          if (!ignorePageErrorPatterns.some((re) => re.test(msg))) {
            pageErrors.push(msg);
          }
        });
        targetPage.on('response', (res) => {
          traceState.recordResponseHeaders(res.headers());

          const status = res.status();
          if (status < 500) return;
          const url = res.url();
          if (!isWatched5xxOrigin(url)) return;
          const summary = `${status} ${res.request().method()} ${url}`;
          if (!ignore5xxPatterns.some((re) => re.test(summary))) {
            serverErrors.push(summary);
          }
        });
      };

      // Guard ALL pages/frames/popups in BrowserContext (`E-03`)
      guardRequestPropertyOnObject(context, guardConfig, traceState);
      attachPageRuntimeGuards(page);
      context.on('page', (popupPage) => {
        attachPageRuntimeGuards(popupPage);
      });

      // Block non-allowlisted WebSockets (`E-03`)
      if (typeof context.routeWebSocket === 'function') {
        await context.routeWebSocket('**/*', (ws) => {
          const check = checkOutgoingRequestSafety('GET', ws.url(), guardConfig);
          if (check.blocked && check.reason) {
            blockedRequests.push(check.reason);
            void ws.close({ code: 1008, reason: 'Blocked by AI Test Workbench egress guard' });
            return;
          }
          ws.connectToServer();
        });
      }

      // Guard ALL HTTP(S) requests & redirect hops in BrowserContext + inject W3C/sw8 trace headers (`D-02`, `S-03`, `WU-03`)
      const redirectHopTracker = new Map<string, { depth: number; ts: number }>();
      await context.route('**/*', async (route) => {
        const req = route.request();
        const curMethod = req.method().toUpperCase();
        const curUrl = req.url();
        const curBodyText = req.postData() || null;
        const resourceType = req.resourceType();

        if (shouldAbortThirdPartyRequest(curUrl, abortEnv)) {
          await route.abort('blockedbyclient');
          return;
        }

        const curHeaders: Record<string, string> = { ...req.headers() };
        const injectedSw8 = injectTraceHeaders(curHeaders, curUrl, guardConfig, traceState);
        if (injectedSw8 && !sw8Used) sw8Used = injectedSw8;

        const initCheck = checkOutgoingRequestSafety(curMethod, curUrl, {
          ...guardConfig,
          postData: curBodyText,
        });
        if (initCheck.blocked && initCheck.reason) {
          blockedRequests.push(initCheck.reason);
          await route.abort('blockedbyclient');
          return;
        }

        if (!/^https?:/i.test(curUrl)) {
          await route.continue({ headers: curHeaders });
          return;
        }

        const trackedKey = `${resourceType}:${curUrl}`;
        const trackedEntry = redirectHopTracker.get(trackedKey);
        const redirectDepth = trackedEntry && Date.now() - trackedEntry.ts < 30_000 ? trackedEntry.depth : 0;
        redirectHopTracker.delete(trackedKey);
        if (redirectDepth >= MAX_REDIRECT_HOPS) {
          blockedRequests.push(`Blocked redirect loop exceeding ${MAX_REDIRECT_HOPS} hops (${curUrl})`);
          await route.abort('blockedbyclient');
          return;
        }

        try {
          const res = await route.fetch({ maxRedirects: 0, headers: curHeaders });
          const status = res.status();
          const location = res.headers()?.location;
          if (REDIRECT_STATUSES.has(status) && location) {
            const nextDepth = redirectDepth + 1;
            if (nextDepth > MAX_REDIRECT_HOPS) {
              blockedRequests.push(`Blocked redirect loop exceeding ${MAX_REDIRECT_HOPS} hops (${curUrl})`);
              await route.abort('blockedbyclient');
              return;
            }
            const next = computeNextRedirectRequest(curMethod, status, location, curUrl, curHeaders);
            const hopBodyText = next.dropBody ? null : curBodyText;
            const hopCheck = checkOutgoingRequestSafety(next.method, next.url, {
              ...guardConfig,
              postData: hopBodyText,
            });
            if (hopCheck.blocked && hopCheck.reason) {
              blockedRequests.push(hopCheck.reason);
              await route.abort('blockedbyclient');
              return;
            }
            if (redirectHopTracker.size > 200) redirectHopTracker.clear();
            redirectHopTracker.set(`${resourceType}:${next.url}`, { depth: nextDepth, ts: Date.now() });
          }
          // Return checked 3xx/non-3xx response directly so Chromium natively follows redirects & preserves real origin/page.url()
          await route.fulfill({ response: res });
        } catch {
          try {
            await route.abort('failed');
          } catch {
            // route or browser closed
          }
        }
      });

      await use();

      const finishedAtIso = new Date().toISOString();
      const traceContext = {
        injectedTraceId: traceState.traceId,
        traceparent: traceState.traceparent,
        ...(sw8Used ? { sw8: sw8Used } : {}),
        timeWindow: { startedAt: startedAtIso, finishedAt: finishedAtIso },
        observedTraceIds: [...traceState.observedTraceIds],
        traceIds: traceState.buildTraceIds(sw8Used),
      };

      if (blockedRequests.length > 0 || pageErrors.length > 0 || serverErrors.length > 0) {
        await testInfo.attach('workbench-runtime-guard.json', {
          contentType: 'application/json',
          body: Buffer.from(
            JSON.stringify({ blockedRequests, pageErrors, serverErrors, ...traceContext }, null, 2),
            'utf8'
          ),
        });
      } else if (testInfo.status !== testInfo.expectedStatus) {
        await testInfo.attach('workbench-trace-context.json', {
          contentType: 'application/json',
          body: Buffer.from(JSON.stringify(traceContext, null, 2), 'utf8'),
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
 * Verifies Navigation Timing, buffered Web Vitals (LCP / CLS), & DOM complexity stay within SLO budgets (`P-01`).
 */
export async function expectPerformanceBudget(
  page: Page,
  budget: {
    maxTtfbMs?: number;
    maxFcpMs?: number;
    maxLcpMs?: number;
    maxCls?: number;
    maxDomNodes?: number;
  } = {}
): Promise<void> {
  const maxTtfbMs = budget.maxTtfbMs ?? 1500;
  const maxFcpMs = budget.maxFcpMs ?? 2500;
  const maxLcpMs = budget.maxLcpMs ?? 4000;
  const maxCls = budget.maxCls ?? 0.25;
  const maxDomNodes = budget.maxDomNodes ?? 5000;

  const snap = await page.evaluate(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const w = window as unknown as {
      __aitestVitals?: { lcpMs: number | null; cls: number; inpMs: number | null };
    };
    let lcpMs = w.__aitestVitals?.lcpMs ?? null;
    const cls = w.__aitestVitals?.cls ?? 0;

    if (lcpMs === null) {
      await new Promise<void>((resolve) => {
        try {
          const obs = new PerformanceObserver((list) => {
            for (const e of list.getEntries() as Array<PerformanceEntry & { renderTime?: number; loadTime?: number }>) {
              const t = e.renderTime || e.loadTime || e.startTime;
              if (typeof t === 'number') lcpMs = Math.round(t);
            }
          });
          obs.observe({ type: 'largest-contentful-paint', buffered: true });
          setTimeout(() => {
            obs.disconnect();
            resolve();
          }, 80);
        } catch {
          resolve();
        }
      });
    }

    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    return {
      ttfbMs: nav ? Math.round(nav.responseStart) : 0,
      fcpMs: fcp ? Math.round(fcp.startTime) : 0,
      lcpMs,
      cls: Number(cls.toFixed(4)),
      domNodes: document.getElementsByTagName('*').length,
    };
  });

  expect(snap.ttfbMs, `TTFB ${snap.ttfbMs}ms exceeded ${maxTtfbMs}ms`).toBeLessThanOrEqual(maxTtfbMs);
  if (snap.fcpMs > 0) {
    expect(snap.fcpMs, `FCP ${snap.fcpMs}ms exceeded ${maxFcpMs}ms`).toBeLessThanOrEqual(maxFcpMs);
  }
  if (snap.lcpMs !== null) {
    expect(snap.lcpMs, `LCP ${snap.lcpMs}ms exceeded ${maxLcpMs}ms`).toBeLessThanOrEqual(maxLcpMs);
  }
  expect(snap.cls, `CLS ${snap.cls} exceeded ${maxCls}`).toBeLessThanOrEqual(maxCls);
  expect(snap.domNodes, `DOM node count ${snap.domNodes} exceeded ${maxDomNodes}`).toBeLessThanOrEqual(maxDomNodes);
}

/**
 * Runs an automated axe-core scan for WCAG 2.0 / 2.1 / 2.2 Level A & AA rules (`P-03`).
 */
export async function expectAccessible(
  page: Page,
  options: { exclude?: string[]; disableRules?: string[] } = {}
): Promise<void> {
  let builder = new AxeBuilder({ page }).withTags([...WCAG_AXE_TAGS]);
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
  expect(summary, `Automated WCAG 2.0/2.1/2.2 A/AA axe violations:\n${summary.join('\n')}`).toEqual([]);
}

export interface ContractVerifiableResponse {
  status(): number;
  url(): string;
  json(): Promise<unknown>;
}

export type ContractSchemaSpec<T> =
  | ((body: T) => void)
  | { schema: Record<string, unknown>; validator?: (body: T) => void }
  | { openApi: Record<string, unknown>; path: string; method?: string; validator?: (body: T) => void };

/**
 * Validates HTTP status and JSON contract shape via callback, JSON Schema, or OpenAPI 3.x document (`P-04`).
 */
export async function expectApiContract<T = unknown>(
  response: ContractVerifiableResponse,
  expectedStatus: number,
  validatorOrSpec?: ContractSchemaSpec<T>
): Promise<T> {
  expect(
    response.status(),
    `Expected HTTP ${expectedStatus} from ${response.url()}, got ${response.status()}`
  ).toBe(expectedStatus);
  const body = (await response.json()) as T;

  if (typeof validatorOrSpec === 'function') {
    validatorOrSpec(body);
  } else if (validatorOrSpec && typeof validatorOrSpec === 'object') {
    if ('schema' in validatorOrSpec && validatorOrSpec.schema) {
      const check = validateJsonSchema(body, validatorOrSpec.schema);
      expect(check.errors, `JSON Schema contract violation(s) on ${response.url()}:\n${check.errors.join('\n')}`).toEqual([]);
    } else if ('openApi' in validatorOrSpec && validatorOrSpec.openApi) {
      const schema = extractOpenApiResponseSchema(
        validatorOrSpec.openApi,
        validatorOrSpec.path,
        validatorOrSpec.method || 'get',
        expectedStatus
      );
      expect(schema, `Missing OpenAPI response schema for ${validatorOrSpec.method || 'GET'} ${validatorOrSpec.path} (${expectedStatus})`).toBeTruthy();
      if (schema) {
        const check = validateJsonSchema(body, schema, { rootDoc: validatorOrSpec.openApi });
        expect(check.errors, `OpenAPI contract drift on ${validatorOrSpec.path}:\n${check.errors.join('\n')}`).toEqual([]);
      }
    }
    if (validatorOrSpec.validator) {
      validatorOrSpec.validator(body);
    }
  }

  return body;
}
