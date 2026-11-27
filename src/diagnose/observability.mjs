// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { extractQueryableTraceId } from './classifier.mjs';

/**
 * Extracts Playwright `trace.zip`, `error-context.md`, runtime-guard signals, trace IDs,
 * and test execution time window from a single Playwright result entry.
 * @param {Record<string, any>} resultObj
 * @param {string} qaDir
 */
export function extractAttachmentsAndErrorContext(resultObj, qaDir) {
  /** @type {string | null} */
  let tracePath = null;
  /** @type {string | null} */
  let errorContextText = null;
  /** @type {string[]} */
  let traceIds = [];
  /** @type {string | null} */
  let injectedTraceId = null;
  /** @type {{ startedAt?: string, finishedAt?: string } | null} */
  let timeWindow = null;
  /** @type {{ serverErrors: string[], blockedRequests: string[], pageErrors: string[] } | null} */
  let guardSignals = null;

  for (const att of resultObj.attachments || []) {
    let parsedGuard = null;
    if (att.name === 'workbench-runtime-guard.json' || att.name === 'workbench-trace-context.json') {
      try {
        if (att.body) {
          parsedGuard = JSON.parse(Buffer.from(att.body, 'base64').toString('utf8'));
        } else if (att.path) {
          const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
          if (fs.existsSync(resolved)) parsedGuard = JSON.parse(fs.readFileSync(resolved, 'utf8'));
        }
      } catch {
        parsedGuard = null;
      }
      if (parsedGuard) {
        if (Array.isArray(parsedGuard.traceIds)) traceIds.push(...parsedGuard.traceIds);
        if (parsedGuard.injectedTraceId) injectedTraceId = parsedGuard.injectedTraceId;
        if (parsedGuard.timeWindow) timeWindow = parsedGuard.timeWindow;
        if (att.name === 'workbench-runtime-guard.json') {
          guardSignals = {
            serverErrors: parsedGuard.serverErrors || [],
            blockedRequests: parsedGuard.blockedRequests || [],
            pageErrors: parsedGuard.pageErrors || [],
          };
        }
      }
    }

    if (!att.path) continue;
    const resolved = path.isAbsolute(att.path) ? att.path : path.resolve(qaDir, att.path);
    if (att.name === 'trace' || resolved.endsWith('trace.zip')) {
      tracePath = resolved;
    }
    if ((att.name === 'error-context' || resolved.endsWith('error-context.md')) && fs.existsSync(resolved)) {
      errorContextText = fs.readFileSync(resolved, 'utf8');
    }
  }

  if (!errorContextText && tracePath) {
    const candidate = path.join(path.dirname(tracePath), 'error-context.md');
    if (fs.existsSync(candidate)) {
      errorContextText = fs.readFileSync(candidate, 'utf8');
    }
  }

  return {
    tracePath,
    errorContextText,
    traceIds: [...new Set(traceIds)],
    injectedTraceId,
    timeWindow,
    guardSignals,
  };
}

/**
 * Prioritizes server-returned `trace-id` / `x-trace-id` / `tid` and decoded `sw8` trace headers
 * ahead of synthetic client-injected `injectedTraceId` (`WB-P1-06`).
 * @param {string[]} traceIds
 * @param {string | null | undefined} injectedTraceId
 * @returns {string}
 */
export function selectPrimaryQueryableTraceId(traceIds = [], injectedTraceId = null) {
  const normInjected = injectedTraceId ? extractQueryableTraceId(String(injectedTraceId)) : null;
  /** @type {Array<{ rank: number, id: string }>} */
  const ranked = [];

  for (const raw of traceIds || []) {
    if (!raw || typeof raw !== 'string') continue;
    const colonIdx = raw.indexOf(':');
    const header = colonIdx >= 0 ? raw.slice(0, colonIdx).trim().toLowerCase() : '';
    const extracted = extractQueryableTraceId(raw);
    if (!extracted || extracted === '<trace-id>') continue;

    let rank = 4;
    if (header === 'trace-id' || header === 'x-trace-id' || header === 'tid') rank = 1;
    else if (header === 'sw8' || header === 'x-skywalking-traceid' || header === 'x-b3-traceid' || /^[01]-[A-Za-z0-9+/=_-]+-/.test(raw.trim())) {
      rank = 2;
    } else if (extracted !== normInjected) {
      rank = 3;
    }
    ranked.push({ rank, id: extracted });
  }

  ranked.sort((a, b) => a.rank - b.rank);
  if (ranked.length > 0 && ranked[0].rank <= 3) {
    return ranked[0].id;
  }
  if (normInjected && normInjected !== '<trace-id>') {
    return normInjected;
  }
  return ranked[0]?.id || '<trace-id>';
}

/**
 * Builds correlated Grafana Loki (`LogQL`), VictoriaLogs (`LogsQL`), and Prometheus queries (`WB-P1-06`).
 * @param {string} queryTraceId
 * @param {{ startedAt?: string, finishedAt?: string } | null} [timeWindow]
 */
export function buildObservabilityQueries(queryTraceId, timeWindow = null) {
  const safeId = queryTraceId || '<trace-id>';
  return {
    traceId: safeId === '<trace-id>' ? null : safeId,
    lokiLogQl: `{env=~"staging|test"} |= "${safeId}"`,
    victoriaLogsQl: [`_msg:"${safeId}"`, `_time:15m "${safeId}"`],
    prometheusPromQl: 'sum(rate(http_server_requests_seconds_count{status=~"5.."}[5m]))',
    sentryWindow: `${timeWindow?.startedAt || 'last 15m'} -> ${timeWindow?.finishedAt || 'now'}`,
  };
}

/** @param {string} errorText @returns {string[]} */
function extractErrorReferencedPaths(errorText) {
  /** @type {Set<string>} */
  const paths = new Set();
  const txt = String(errorText || '');
  const cleanPath = (/** @type {string} */ p) => p.split('?')[0].replace(/[:;.,]+$/, '');
  for (const m of txt.matchAll(/https?:\/\/[^/\s"'`)]+(\/[^\s"'`),?]+)/gi)) {
    paths.add(cleanPath(m[1]));
  }
  for (const m of txt.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s"'`),?]+)/gi)) {
    paths.add(cleanPath(m[1]));
  }
  for (const m of txt.matchAll(/(?:^|[\s'"`(])(\/(?:api|v\d+)\/[^\s"'`),?]+)/gi)) {
    paths.add(cleanPath(m[1]));
  }
  return [...paths].filter(Boolean);
}

/** @param {string} specFile @param {string} candidateSpec */
function matchesSpecFile(specFile, candidateSpec) {
  const a = String(specFile || '').replace(/\\/g, '/').replace(/^\.\//, '');
  const b = String(candidateSpec || '').replace(/\\/g, '/').replace(/^\.\//, '');
  if (!a || !b) return false;
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

/** @param {string} candidate @param {string[]} errorPaths */
function matchesErrorPath(candidate, errorPaths) {
  const clean = String(candidate || '').replace(/^(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+/i, '').split('?')[0];
  if (!clean) return false;
  return errorPaths.some((ep) => ep === clean || ep.endsWith(clean) || clean.endsWith(ep));
}

const TENANT_AUTH_ERROR_RE =
  /(?:tenant|租户|tenant-id|platform-id|401|403|unauthorized|forbidden|token|令牌|未登[录陆]|auth|sign|签名|permission|权限)/i;
const TENANT_SPECIFIC_RE = /(?:tenant|租户|tenant-id|platform-id)/i;
const AUTH_SPECIFIC_RE = /(?:401|403|unauthorized|forbidden|token|令牌|未登[录陆]|auth|sign|签名|permission|权限)/i;

/**
 * Formats a CodeMap v5 service chain into a concise `Vue -> API -> Controller -> Service -> Feign -> Mapper/XML -> Table` trace.
 * @param {Record<string, any>} chain
 * @returns {string}
 */
export function formatServiceChain(chain) {
  if (!chain || typeof chain !== 'object') return '';
  /** @type {string[]} */
  const parts = [];
  const view = chain.viewFile || chain.frontendFile || chain.route || '';
  if (view) parts.push(`Vue(${view})`);
  const apiPath = chain.apiPath || chain.endpoint || '';
  const apiMethod = chain.apiMethod || chain.httpMethod || '';
  const apiFn = chain.apiFnName || chain.frontendApiFn || '';
  if (apiPath || apiFn) {
    const apiBody = [apiMethod ? String(apiMethod).toUpperCase() : '', apiPath, apiFn ? `#${apiFn}` : ''].filter(Boolean).join(' ');
    parts.push(`API(${apiBody})`);
  }
  const ctrl = chain.controllerMethod ? `${chain.controllerFile || ''}#${chain.controllerMethod}` : chain.controllerFile || '';
  if (ctrl) parts.push(`Controller(${ctrl})`);
  const services = Array.isArray(chain.serviceFiles) ? chain.serviceFiles : chain.serviceMethods || (chain.service ? [chain.service] : []);
  if (services.length > 0) parts.push(`Service(${services.slice(0, 3).join(', ')})`);
  const feigns = Array.isArray(chain.feignFiles) ? chain.feignFiles : chain.feignTargets || (chain.feign ? [chain.feign] : []);
  if (feigns.length > 0) parts.push(`Feign(${feigns.slice(0, 3).join(', ')})`);
  const mappers = [
    ...(Array.isArray(chain.mapperFiles) ? chain.mapperFiles : chain.mapperMethods || []),
    ...(Array.isArray(chain.xmlFiles) ? chain.xmlFiles : []),
  ];
  if (mappers.length > 0) parts.push(`Mapper/XML(${[...new Set(mappers)].slice(0, 3).join(', ')})`);
  const tables = Array.isArray(chain.dbTables) ? chain.dbTables : chain.tables || [];
  if (tables.length > 0) parts.push(`Table(${[...new Set(tables)].slice(0, 5).join(', ')})`);
  return parts.join(' -> ');
}

/**
 * Produces concrete tenant/auth filter & interceptor investigation hints when error text mentions tenant/auth/sign/token.
 * @param {string} errorText
 * @param {Record<string, any> | null} [codeMap]
 * @param {Record<string, any> | null} [graphIndex]
 * @returns {string[]}
 */
export function detectTenantAuthFilterHints(errorText, codeMap = null, graphIndex = null) {
  const txt = String(errorText || '');
  if (!TENANT_AUTH_ERROR_RE.test(txt)) return [];
  /** @type {string[]} */
  const hints = [];
  const indexedFilters = [
    ...new Set(
      [
        ...(Array.isArray(codeMap?.securityFilters) ? codeMap.securityFilters : []),
        ...(Array.isArray(codeMap?.globalInfra?.springAutoConfigTargets) ? codeMap.globalInfra.springAutoConfigTargets : []),
        ...(Array.isArray(graphIndex?.globalInfra?.springAutoConfigTargets) ? graphIndex.globalInfra.springAutoConfigTargets : []),
        ...(Array.isArray(graphIndex?.globalInfra?.globalFiles) ? graphIndex.globalInfra.globalFiles : []),
      ].filter(Boolean)
    ),
  ];
  if (indexedFilters.length > 0) {
    const isTenant = TENANT_SPECIFIC_RE.test(txt);
    const isAuth = AUTH_SPECIFIC_RE.test(txt);
    const rankScore = (/** @type {string} */ f) => {
      let s = 0;
      if (isTenant && /tenant/i.test(f)) s += 100;
      if (isAuth && /(?:auth|security|token|sign|permission|oauth)/i.test(f)) s += 80;
      if (/(?:WebFilter|Filter|Interceptor|Advice)\./i.test(f)) s += 40;
      if (/AutoConfiguration\./i.test(f)) s += 20;
      return s;
    };
    const ranked = indexedFilters.sort((a, b) => rankScore(b) - rankScore(a) || (a < b ? -1 : a > b ? 1 : 0));
    hints.push(`Indexed Global Filter/AutoConfig Targets: ${ranked.slice(0, 5).join(', ')}`);
  }
  if (TENANT_SPECIFIC_RE.test(txt)) {
    hints.push(
      'Tenant Filter Check: inspect TenantSecurityWebFilter / TenantContextWebFilter (META-INF/spring.factories -> TenantAutoConfiguration), tenant-id / platform-id headers, and MyBatis tenant SQL interceptor.'
    );
  }
  if (AUTH_SPECIFIC_RE.test(txt)) {
    hints.push(
      'Auth/Sign Filter Check: inspect TokenAuthenticationFilter / SignWebFilter / SecurityConfiguration, Vue request.js & platformRequest.js Authorization/header injection, and src/permission.js route guards.'
    );
  }
  return hints;
}

/**
 * Loads CodeMap correlations strictly scoped to the failing test (`specFile`, `coveringSpecs`,
 * CodeMap v5 `serviceChains`, tenant/auth filter hints, and any URL/API paths explicitly referenced in `errorText`).
 * @param {string} qaDir
 * @param {string} specFile
 * @param {{ errorText?: string }} [options]
 */
export function loadCodeMapCorrelations(qaDir, specFile, options = {}) {
  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (!fs.existsSync(cmPath)) return null;
  try {
    const cm = JSON.parse(fs.readFileSync(cmPath, 'utf8'));
    const errorText = String(options.errorText || '');
    const allRoutes = Object.values(cm.routes || {});
    const errorPaths = extractErrorReferencedPaths(errorText);
    const specMatched = allRoutes.filter((r) =>
      (r.coveringSpecs || []).some((/** @type {string} */ s) => matchesSpecFile(specFile, s))
    );

    let matchedRoutes = specMatched;
    if (errorPaths.length > 0) {
      const errorScoped = (specMatched.length > 0 ? specMatched : allRoutes).filter(
        (r) =>
          matchesErrorPath(r.route, errorPaths) ||
          (r.linkedApis || []).some((/** @type {string} */ api) => matchesErrorPath(api, errorPaths))
      );
      if (errorScoped.length > 0) {
        matchedRoutes = errorScoped;
      }
    }

    const matchedRouteSet = new Set(matchedRoutes.map((r) => r.route));
    const rawChains = [
      ...(Array.isArray(cm.serviceChains) ? cm.serviceChains : Object.values(cm.serviceChains || {})),
      ...matchedRoutes.flatMap((r) => (Array.isArray(r.serviceChains) ? r.serviceChains : [])),
    ];
    const specOrRouteChains = rawChains.filter((ch) => {
      if (!ch || typeof ch !== 'object') return false;
      const specHit = (ch.coveringSpecs || []).some((/** @type {string} */ s) => matchesSpecFile(specFile, s));
      const routeHit = Boolean(ch.route && matchedRouteSet.has(ch.route));
      return specHit || routeHit;
    });
    let matchedChains = specOrRouteChains;
    if (errorPaths.length > 0) {
      const errorScopedChains = (specOrRouteChains.length > 0 ? specOrRouteChains : rawChains).filter(
        (ch) => ch && typeof ch === 'object' && ch.apiPath && matchesErrorPath(ch.apiPath, errorPaths)
      );
      if (errorScopedChains.length > 0) matchedChains = errorScopedChains;
    }
    const serviceChains = [...new Set(matchedChains.map(formatServiceChain).filter(Boolean))];

    let graphIndex = null;
    if (TENANT_AUTH_ERROR_RE.test(errorText)) {
      const giPath = path.join(qaDir, 'knowledge', 'graph-impact-index.json');
      if (fs.existsSync(giPath)) {
        try { graphIndex = JSON.parse(fs.readFileSync(giPath, 'utf8')); } catch { graphIndex = null; }
      }
    }
    const tenantAuthHints = detectTenantAuthFilterHints(errorText, cm, graphIndex);

    if (matchedRoutes.length === 0 && serviceChains.length === 0 && tenantAuthHints.length === 0) return null;

    const allApis = /** @type {string[]} */ ([
      ...new Set([
        ...matchedRoutes.flatMap((r) => r.linkedApis || []),
        ...matchedChains.map((c) => c.apiPath).filter(Boolean),
      ]),
    ]);
    const scopedApis =
      errorPaths.length > 0 && allApis.some((a) => matchesErrorPath(a, errorPaths))
        ? allApis.filter((a) => matchesErrorPath(a, errorPaths))
        : allApis;

    return {
      routes: /** @type {string[]} */ ([...new Set([...matchedRoutes.map((r) => r.route), ...matchedChains.map((c) => c.route).filter(Boolean)])]),
      frontendFiles: /** @type {string[]} */ ([
        ...new Set([...matchedRoutes.map((r) => r.frontendFile), ...matchedChains.map((c) => c.viewFile || c.frontendFile)].filter(Boolean)),
      ]),
      backendFiles: /** @type {string[]} */ ([
        ...new Set([
          ...matchedRoutes.flatMap((r) => r.linkedBackendFiles || []),
          ...matchedChains.flatMap((c) => [c.controllerFile, ...(c.serviceFiles || []), ...(c.feignFiles || [])].filter(Boolean)),
        ]),
      ]),
      dbTables: /** @type {string[]} */ ([
        ...new Set([
          ...matchedRoutes.flatMap((r) => r.linkedDbTables || []),
          ...matchedChains.flatMap((c) => c.dbTables || c.tables || []),
        ]),
      ]),
      apis: scopedApis,
      serviceChains,
      tenantAuthHints,
    };
  } catch {
    return null;
  }
}
