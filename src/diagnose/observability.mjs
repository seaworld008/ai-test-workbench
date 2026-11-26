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
  for (const m of txt.matchAll(/https?:\/\/[^/\s"'`)]+(\/[^\s"'`),?]+)/gi)) {
    paths.add(m[1].split('?')[0]);
  }
  for (const m of txt.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE|HEAD)\s+(\/[^\s"'`),?]+)/gi)) {
    paths.add(m[1].split('?')[0]);
  }
  for (const m of txt.matchAll(/(?:^|[\s'"`(])(\/(?:api|v\d+)\/[^\s"'`),?]+)/gi)) {
    paths.add(m[1].split('?')[0]);
  }
  return [...paths];
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

/**
 * Loads CodeMap correlations strictly scoped to the failing test (`specFile`, `coveringSpecs`,
 * and any URL/API paths explicitly referenced in `errorText`), avoiding global route dumps (`WB-P1-06`).
 * @param {string} qaDir
 * @param {string} specFile
 * @param {{ errorText?: string }} [options]
 */
export function loadCodeMapCorrelations(qaDir, specFile, options = {}) {
  const cmPath = path.join(qaDir, 'knowledge', 'code-map.json');
  if (!fs.existsSync(cmPath)) return null;
  try {
    const cm = JSON.parse(fs.readFileSync(cmPath, 'utf8'));
    const allRoutes = Object.values(cm.routes || {});
    const errorPaths = extractErrorReferencedPaths(options.errorText || '');
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

    if (matchedRoutes.length === 0) return null;
    const allApis = /** @type {string[]} */ ([...new Set(matchedRoutes.flatMap((r) => r.linkedApis || []))]);
    const scopedApis =
      errorPaths.length > 0 && allApis.some((a) => matchesErrorPath(a, errorPaths))
        ? allApis.filter((a) => matchesErrorPath(a, errorPaths))
        : allApis;

    return {
      routes: /** @type {string[]} */ (matchedRoutes.map((r) => r.route)),
      frontendFiles: /** @type {string[]} */ ([...new Set(matchedRoutes.map((r) => r.frontendFile).filter(Boolean))]),
      backendFiles: /** @type {string[]} */ ([...new Set(matchedRoutes.flatMap((r) => r.linkedBackendFiles || []))]),
      dbTables: /** @type {string[]} */ ([...new Set(matchedRoutes.flatMap((r) => r.linkedDbTables || []))]),
      apis: scopedApis,
    };
  } catch {
    return null;
  }
}
