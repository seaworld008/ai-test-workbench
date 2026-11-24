// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { groupOutcomesBySpecFile } from './core/playwright-results.mjs';
import { SCHEMA_VERSIONS } from './core/version.mjs';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '.nuxt',
  'out',
  'target',
  'vendor',
  'qa',
  '.sandbox',
  'playwright-report',
  'test-results',
  'coverage',
  '.idea',
  '.vscode',
  '.aitest',
]);

const CODE_EXTS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.vue',
  '.java',
  '.kt',
  '.py',
  '.php',
  '.go',
  '.prisma',
  '.sql',
]);
const VIEW_EXTS = ['', '.vue', '.tsx', '.ts', '.jsx', '.js', '/index.vue', '/index.tsx', '/index.ts', '/index.js'];
const DEFAULT_MAX_SCAN_FILES = 2500;
const MAX_FILE_BYTES = 256 * 1024;
const STALE_RUNTIME_DAYS = 14;

function walkSourceFiles(rootDir, limit = DEFAULT_MAX_SCAN_FILES) {
  /** @type {string[]} */
  const out = [];
  let truncated = false;

  const walk = (dir) => {
    if (!dir || !fs.existsSync(dir)) return;
    if (out.length >= limit) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) {
        truncated = true;
        break;
      }
      if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        out.push(full);
      }
    }
  };

  walk(rootDir);
  return { files: out, truncated };
}

function normalizeSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

export function normalizeRoutePath(routePath) {
  let clean = String(routePath || '').trim().split('?')[0].split('#')[0];
  if (!clean) return '/';
  if (!clean.startsWith('/')) clean = `/${clean}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
}

/**
 * Converts Next.js bracket route segments (`[id]`, `[...slug]`) into parameterized pattern (`:id`, `:slug*`) (`K-03`).
 */
function convertBracketSegment(seg) {
  if (/^\[\[\.\.\.([^\]]+)\]\]$/.test(seg)) return `:${seg.slice(5, -2)}*`;
  if (/^\[\.\.\.([^\]]+)\]$/.test(seg)) return `:${seg.slice(4, -1)}*`;
  if (/^\[([^\]]+)\]$/.test(seg)) return `:${seg.slice(1, -1)}`;
  return seg;
}

/**
 * Matches a concrete runtime URL (`/courses/course-open-101`, `/users/42`) back to a parameterized static route (`/courses/:id`) (`K-03`).
 * @param {string} runtimeRoute
 * @param {string[]} staticPatterns
 */
export function matchRuntimeRouteToPattern(runtimeRoute, staticPatterns) {
  const norm = normalizeRoutePath(runtimeRoute);
  if (staticPatterns.includes(norm)) return norm;

  // Sort dynamic patterns by specificity: more static segments > parameterized > wildcard (`I-06`)
  const rtSegs = norm.split('/').filter(Boolean);
  const candidates = staticPatterns
    .filter((pat) => pat.includes(':'))
    .map((pat) => {
      const patSegs = pat.split('/').filter(Boolean);
      const hasWildcard = patSegs.some((s) => s.endsWith('*'));
      const staticCount = patSegs.filter((s) => !s.startsWith(':')).length;
      return { pat, patSegs, hasWildcard, staticCount };
    })
    .sort((a, b) => {
      if (a.hasWildcard !== b.hasWildcard) return a.hasWildcard ? 1 : -1;
      if (b.staticCount !== a.staticCount) return b.staticCount - a.staticCount;
      return b.patSegs.length - a.patSegs.length;
    });

  for (const { pat, patSegs, hasWildcard } of candidates) {
    if (hasWildcard) {
      const prefixLen = patSegs.length - 1;
      if (rtSegs.length >= prefixLen) {
        const prefixOk = patSegs.slice(0, prefixLen).every((ps, idx) => ps.startsWith(':') || ps === rtSegs[idx]);
        if (prefixOk) return pat;
      }
      continue;
    }
    if (patSegs.length !== rtSegs.length) continue;
    const matched = patSegs.every((ps, idx) => ps.startsWith(':') || ps === rtSegs[idx]);
    if (matched) return pat;
  }
  return norm;
}

function resolveImportCandidate(baseFile, importSpec, repoDir) {
  let resolvedBase = null;
  if (importSpec.startsWith('./') || importSpec.startsWith('../')) {
    resolvedBase = path.resolve(path.dirname(baseFile), importSpec);
  } else if (importSpec.startsWith('@/views/') || importSpec.startsWith('@/pages/') || importSpec.startsWith('@/')) {
    const sub = importSpec.slice(2);
    const srcCandidate = path.join(repoDir, 'src', sub);
    resolvedBase = fs.existsSync(path.join(repoDir, 'src')) ? srcCandidate : path.join(repoDir, sub);
  }
  if (!resolvedBase) return { resolvedRel: null, exists: true };
  for (const ext of VIEW_EXTS) {
    const candidate = `${resolvedBase}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { resolvedRel: normalizeSlash(path.relative(repoDir, candidate)), exists: true };
    }
  }
  return { resolvedRel: normalizeSlash(path.relative(repoDir, resolvedBase)), exists: false };
}

function extractFrontendData(filePath, relFile, text, repoDir) {
  const routes = [];
  const brokenImports = [];
  const apiCalls = [];

  // Next.js App Router & Pages Router file conventions (preserving dynamic [id] -> :id routes! `K-03`)
  const appMatch = relFile.match(/^(?:src\/)?app(?:\/(.*))?\/page\.[jt]sx?$/i);
  if (appMatch) {
    const segs = (appMatch[1] || '')
      .split('/')
      .filter((s) => s && !s.startsWith('(') && !s.startsWith('@'))
      .map(convertBracketSegment);
    routes.push({ route: normalizeRoutePath(`/${segs.join('/')}`), file: relFile, kind: 'nextjs-app' });
  }
  const pageMatch = relFile.match(/^(?:src\/)?pages\/(.+)\.[jt]sx?$/i);
  if (pageMatch && !/\/(?:_app|_document|_error|api\/)/.test(relFile)) {
    const raw = pageMatch[1].replace(/\/index$/i, '');
    const converted = raw
      .split('/')
      .filter(Boolean)
      .map(convertBracketSegment)
      .join('/');
    routes.push({
      route: normalizeRoutePath(raw === 'index' ? '/' : `/${converted}`),
      file: relFile,
      kind: 'nextjs-pages',
    });
  }

  // Vue / React Router object literals (preserving `:param` dynamic routes! `K-03`)
  if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(relFile) && /path\s*:\s*['"`]/.test(text)) {
    const pathPropRe = /path\s*:\s*['"`]([^'"`*?#(]+)['"`]/g;
    for (const match of text.matchAll(pathPropRe)) {
      const routePath = match[1];
      if (!routePath.startsWith('/')) continue;
      const tail = text.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 260);
      const boundedBlock = tail.split(/\bpath\s*:/)[0];
      const importMatch = boundedBlock.match(/import\s*\(\s*['"`]([^'"`]+)['"`]\s*\)/);
      const importSpec = importMatch ? importMatch[1] : null;
      let targetFile = relFile;
      if (importSpec) {
        const chk = resolveImportCandidate(filePath, importSpec, repoDir);
        if (chk.resolvedRel) targetFile = chk.resolvedRel;
        if (!chk.exists) {
          brokenImports.push({
            route: normalizeRoutePath(routePath),
            routerFile: relFile,
            importSpec,
            expectedFile: chk.resolvedRel,
          });
        }
      }
      routes.push({ route: normalizeRoutePath(routePath), file: targetFile, kind: 'router-config' });
    }
  }

  // React Router JSX `<Route path="/users/:id" ... />`
  if (/\.[jt]sx$/.test(relFile) && /<Route\b/.test(text)) {
    for (const m of text.matchAll(/<Route\b[^>]*?\bpath\s*=\s*['"`](\/[^'"`*?]+)['"`]/g)) {
      routes.push({ route: normalizeRoutePath(m[1]), file: relFile, kind: 'react-router-jsx' });
    }
  }

  const apiPatterns = [
    /\bfetch\s*\(\s*['"`]([^'"`$]+)['"`]/g,
    /\baxios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`$]+)['"`]/gi,
    /\brequest\s*\(\s*\{\s*[^}]*?url\s*:\s*['"`]([^'"`$]+)['"`]/gi,
  ];
  for (const m of text.matchAll(apiPatterns[0])) {
    if (m[1].startsWith('/')) apiCalls.push({ method: 'FETCH', path: normalizeRoutePath(m[1]), file: relFile });
  }
  for (const m of text.matchAll(apiPatterns[1])) {
    if (m[2].startsWith('/')) apiCalls.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile });
  }
  for (const m of text.matchAll(apiPatterns[2])) {
    if (m[1].startsWith('/')) apiCalls.push({ method: 'REQUEST', path: normalizeRoutePath(m[1]), file: relFile });
  }

  return { routes, brokenImports, apiCalls };
}

function extractBackendAndDbData(relFile, text) {
  const endpoints = [];
  const entities = [];
  const ext = path.extname(relFile).toLowerCase();

  const nextApi = relFile.match(/^(?:src\/)?app\/(api\/.+)\/route\.[jt]sx?$/i);
  if (nextApi) {
    const converted = nextApi[1].split('/').map(convertBracketSegment).join('/');
    endpoints.push({ method: 'ANY', path: normalizeRoutePath(`/${converted}`), file: relFile, framework: 'nextjs-api' });
  }

  if (ext === '.java' || ext === '.kt') {
    const classPrefixMatch = text.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/);
    const prefix = classPrefixMatch ? classPrefixMatch[1].replace(/\/$/, '') : '';
    const mapRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(mapRe)) {
      const fullPath = normalizeRoutePath(`${prefix}/${m[2].replace(/^\//, '')}`).replace(/\{([^}]+)\}/g, ':$1');
      if (fullPath === prefix && m[1] === 'Request') continue;
      endpoints.push({ method: m[1] === 'Request' ? 'ANY' : m[1].toUpperCase(), path: fullPath, file: relFile, framework: 'spring' });
    }
    for (const m of text.matchAll(/@(?:TableName|Table)\s*\(\s*(?:value\s*=|name\s*=)?\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
      entities.push({ table: m[1], file: relFile, source: 'jpa/mybatis' });
    }
  }

  if (['.ts', '.js', '.mjs'].includes(ext)) {
    const ctrlMatch = text.match(/@Controller\s*\(\s*['"]([^'"]*)['"]/);
    const ctrlPrefix = ctrlMatch ? `/${ctrlMatch[1].replace(/^\/|\/$/g, '')}` : '';
    for (const m of text.matchAll(/\b(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'express/fastify' });
    }
    // Also detect Node http.createServer `pathname === '/...'` routes (e.g. demo-webapp!)
    for (const m of text.matchAll(/\bpathname\s*===\s*['"`](\/[^'"`]+)['"`]/g)) {
      if (m[1].startsWith('/api/')) {
        endpoints.push({ method: 'ANY', path: normalizeRoutePath(m[1]), file: relFile, framework: 'node-http' });
      }
    }
    for (const m of text.matchAll(/@(Get|Post|Put|Delete|Patch)\s*\(\s*['"]([^'"]*)['"]/g)) {
      endpoints.push({
        method: m[1].toUpperCase(),
        path: normalizeRoutePath(`${ctrlPrefix}/${m[2].replace(/^\//, '')}`),
        file: relFile,
        framework: 'nestjs',
      });
    }
    for (const m of text.matchAll(/@Entity\s*\(\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
      entities.push({ table: m[1], file: relFile, source: 'typeorm' });
    }
  }

  if (ext === '.py') {
    for (const m of text.matchAll(/@(?:app|router|bp)\.(get|post|put|delete|patch|route)\s*\(\s*['"]([^'"]+)['"]/g)) {
      endpoints.push({ method: m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'python' });
    }
  }

  if (ext === '.php') {
    for (const m of text.matchAll(/Route::(get|post|put|delete|any)\s*\(\s*['"]([^'"]+)['"]/g)) {
      endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'php' });
    }
  }

  if (ext === '.prisma') {
    for (const m of text.matchAll(/^\s*model\s+([A-Za-z0-9_]+)\s*\{/gm)) {
      entities.push({ table: m[1], file: relFile, source: 'prisma' });
    }
  }
  if (ext === '.sql') {
    for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_.]+)[`"']?/gi)) {
      entities.push({ table: m[1], file: relFile, source: 'sql' });
    }
  }

  return { endpoints, entities };
}

/**
 * Indexes static routes, API calls, backend endpoints, and DB entities from host repository files (`K-05` truncation reporting).
 */
export function indexRepositorySource(repoDir, options = {}) {
  const maxScanFiles = options.maxScanFiles || DEFAULT_MAX_SCAN_FILES;
  const result = {
    repoDir: normalizeSlash(repoDir || ''),
    fileCount: 0,
    truncated: false,
    warnings: /** @type {string[]} */ ([]),
    frontendRoutes: [],
    brokenRouteImports: [],
    frontendApiCalls: [],
    backendEndpoints: [],
    dbEntities: [],
    backendFileTexts: /** @type {Record<string, string>} */ ({}),
  };
  if (!repoDir || !fs.existsSync(repoDir)) return result;

  const walked = walkSourceFiles(repoDir, maxScanFiles);
  result.fileCount = walked.files.length;
  result.truncated = walked.truncated;
  if (walked.truncated) {
    result.warnings.push(`Source scan reached maxScanFiles=${maxScanFiles}; configure a narrower --repo or higher limit.`);
  }

  for (const filePath of walked.files) {
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (stat.size > MAX_FILE_BYTES) continue;
    const text = fs.readFileSync(filePath, 'utf8');
    const relFile = normalizeSlash(path.relative(repoDir, filePath));

    const fe = extractFrontendData(filePath, relFile, text, repoDir);
    result.frontendRoutes.push(...fe.routes);
    result.brokenRouteImports.push(...fe.brokenImports);
    result.frontendApiCalls.push(...fe.apiCalls);

    const be = extractBackendAndDbData(relFile, text);
    result.backendEndpoints.push(...be.endpoints);
    result.dbEntities.push(...be.entities);
    if (be.endpoints.length > 0) {
      result.backendFileTexts[relFile] = text;
    }
  }

  return result;
}

export function indexQaSpecs(qaDir) {
  const testsDir = path.join(qaDir, 'tests');
  const specs = [];
  if (!fs.existsSync(testsDir)) return specs;

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        entry.isFile() &&
        /\.spec\.[jt]s$/.test(entry.name) &&
        entry.name !== 'seed.spec.ts' &&
        !entry.name.endsWith('.official.example.ts')
      ) {
        const rel = normalizeSlash(path.relative(qaDir, full));
        const text = fs.readFileSync(full, 'utf8');
        const uiRoutes = new Set();
        const apiPaths = new Set();

        for (const m of text.matchAll(
          /(?:\.|^|\s)(?:goto|verifyProtectedRouteRedirectsToLogin|visitModuleAndVerifyReady)\s*\([^)]*?['"`](\/[^'"`?#)]*)['"`]/gm
        )) {
          uiRoutes.add(normalizeRoutePath(m[1]));
        }
        for (const m of text.matchAll(
          /(?:\.|^|\s)(?:get|post|put|delete|patch|fetch|verifyGatewayUnauthenticated401)\s*\([^)]*?['"`]((?:https?:\/\/[^'"`]+)?\/[^'"`]+)['"`]/gm
        )) {
          try {
            const p = m[1].startsWith('http') ? new URL(m[1]).pathname : m[1];
            apiPaths.add(normalizeRoutePath(p));
          } catch {
            // ignore dynamic expressions
          }
        }
        specs.push({ specFile: rel, uiRoutes: [...uiRoutes], apiPaths: [...apiPaths] });
      }
    }
  };
  walk(testsDir);
  return specs;
}

function collectTestOutcomesByFile(resultsJson) {
  return groupOutcomesBySpecFile(resultsJson);
}

function computeTopologySnapshotId(topology) {
  if (!topology || typeof topology !== 'object') return null;
  if (topology.snapshotId) return String(topology.snapshotId);
  if (!topology.exploredAt && (!Array.isArray(topology.pages) || topology.pages.length === 0)) return null;
  const raw = JSON.stringify({
    exploredAt: topology.exploredAt || '',
    pages: (topology.pages || []).map((p) => p.route),
    consoleErrors: topology.consoleErrors || [],
    queryAnomalies: topology.queryAnomalies || [],
  });
  return `snap_${crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Precise controller/entity correlation (`K-04`): avoids naive substring pollution (`user` matching `/user-guide`).
 */
function correlateDbTablesForRoute(entry, dbEntities, backendFileTexts = {}) {
  const matched = new Set();
  const routeSegments = entry.route
    .toLowerCase()
    .split('/')
    .filter((s) => s && !s.startsWith(':'));
  const apiSegments = (entry.linkedApis || [])
    .flatMap((a) => a.toLowerCase().split('/'))
    .filter((s) => s && s !== 'api' && !/^v\d+$/.test(s) && !s.startsWith(':'));

  for (const entity of dbEntities || []) {
    const tbl = entity.table;
    const tblLower = tbl.toLowerCase();
    const singular = tblLower.endsWith('s') ? tblLower.slice(0, -1) : tblLower;
    const plural = tblLower.endsWith('s') ? tblLower : `${tblLower}s`;

    // 1. Direct controller file co-location or explicit identifier reference inside linked backend file
    if ((entry.linkedBackendFiles || []).includes(entity.file)) {
      matched.add(tbl);
      continue;
    }
    const controllerRefsEntity = (entry.linkedBackendFiles || []).some((bf) => {
      const src = backendFileTexts[bf];
      return src ? new RegExp(`\\b${escapeRegExp(tbl)}\\b`, 'i').test(src) : false;
    });
    if (controllerRefsEntity) {
      matched.add(tbl);
      continue;
    }

    // 2. Exact path segment match (not loose substring!)
    if (
      routeSegments.includes(tblLower) ||
      routeSegments.includes(singular) ||
      routeSegments.includes(plural) ||
      apiSegments.includes(tblLower) ||
      apiSegments.includes(singular) ||
      apiSegments.includes(plural)
    ) {
      matched.add(tbl);
    }
  }
  return [...matched];
}

function computeCodeMapContentFingerprint(mapCandidate) {
  const canonicalRoutes = Object.fromEntries(
    Object.entries(mapCandidate.routes || {})
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [
        k,
        {
          route: v.route,
          source: v.source,
          archetype: v.archetype,
          frontendFile: v.frontendFile,
          linkedApis: v.linkedApis,
          linkedBackendFiles: v.linkedBackendFiles,
          linkedDbTables: v.linkedDbTables,
          coveringSpecs: v.coveringSpecs,
          lastResult: v.lastResult,
          stale: v.stale,
        },
      ])
  );
  const canonicalDefects = (mapCandidate.defects || []).map((d) => ({
    key: d.key,
    status: d.status,
    seenCount: d.seenCount,
  }));
  return `sha256:${crypto
    .createHash('sha256')
    .update(
      JSON.stringify({
        routes: canonicalRoutes,
        defects: canonicalDefects,
        endpoints: mapCandidate.endpoints || [],
        coverage: mapCandidate.coverage,
        perfCount: (mapCandidate.perfSnapshots || []).length,
      })
    )
    .digest('hex')}`;
}

/**
 * Migrates v3.0 code-map objects cleanly to `schemaVersion: 4` (`A-07`).
 */
export function migrateCodeMapSchema(rawMap) {
  if (!rawMap || typeof rawMap !== 'object') return {};
  return {
    ...rawMap,
    schemaVersion: SCHEMA_VERSIONS.codeMap,
    processedSnapshots: Array.isArray(rawMap.processedSnapshots) ? rawMap.processedSnapshots : [],
  };
}

/**
 * Fuses static code index + runtime exploration topology + test results + perf snapshots into
 * Living Code Map v2 (`schemaVersion: 4`) with dynamic route matching, stale route/spec pruning,
 * snapshot-idempotent defect lifecycle (`open -> resolved-candidate -> closed`), and daily history aggregation (`K-01..K-06`).
 */
export function mergeLivingCodeMap(existingMap, inputs = {}) {
  const now = inputs.nowIso || new Date().toISOString();
  const nowMs = Date.parse(now);
  const base = migrateCodeMapSchema(existingMap);
  const revision = Number(base.revision || 0) + 1;

  const sourceIndex = inputs.sourceIndex || {
    fileCount: 0,
    truncated: false,
    warnings: [],
    frontendRoutes: [],
    brokenRouteImports: [],
    frontendApiCalls: [],
    backendEndpoints: [],
    dbEntities: [],
    backendFileTexts: {},
  };
  const topology = inputs.topology || {};
  const specIndex = Array.isArray(inputs.specIndex) ? inputs.specIndex : [];
  const resultsJson = inputs.resultsJson || null;
  const perfReport = inputs.perfReport || null;
  const outcomesBySpec = collectTestOutcomesByFile(resultsJson);

  const staticPatterns = (sourceIndex.frontendRoutes || []).map((r) => normalizeRoutePath(r.route));
  const hasStaticIndex = (sourceIndex.frontendRoutes || []).length > 0;

  /** @type {Record<string, any>} */
  const routesObj = {};

  const createBlankRoute = (key, source = 'static') => {
    const prev = base.routes?.[key] || {};
    return {
      route: key,
      source,
      title: prev.title || '',
      breadcrumbs: prev.breadcrumbs || [],
      archetype: prev.archetype || 'unknown',
      frontendFile: null,
      tableHeaders: prev.tableHeaders || [],
      filterLabels: prev.filterLabels || [],
      readonlyButtons: prev.readonlyButtons || [],
      mutationButtons: prev.mutationButtons || [],
      linkedApis: [],
      linkedBackendFiles: [],
      linkedDbTables: [],
      coveringSpecs: [],
      lastResult: prev.lastResult || 'untested',
      a11y: prev.a11y || null,
      firstSeenAt: prev.firstSeenAt || now,
      lastSeenAt: prev.lastSeenAt || now,
      stale: false,
      lastUpdatedAt: now,
    };
  };

  const ensureRoute = (rPath, source = 'static') => {
    const normalized = normalizeRoutePath(rPath);
    const key = source === 'runtime' ? matchRuntimeRouteToPattern(normalized, staticPatterns) : normalized;
    if (!routesObj[key]) {
      routesObj[key] = createBlankRoute(key, source);
    } else if (source === 'static') {
      routesObj[key].source = 'static';
    }
    return routesObj[key];
  };

  // 1. Rebuild static frontend routes cleanly from current source scan (deleted static routes are pruned! `K-02`)
  for (const fr of sourceIndex.frontendRoutes || []) {
    const entry = ensureRoute(fr.route, 'static');
    if (fr.file && !entry.frontendFile) entry.frontendFile = fr.file;
    entry.lastSeenAt = now;
  }

  // Carry forward previously discovered runtime-only routes (marking stale if older than STALE_RUNTIME_DAYS)
  for (const [prevKey, prevRoute] of Object.entries(base.routes || {})) {
    if (routesObj[prevKey]) continue;
    // If previous route had a frontendFile that no longer exists in current static scan, prune it (`K-02`)!
    if (hasStaticIndex && prevRoute.frontendFile) {
      continue;
    }
    if (prevRoute.source === 'runtime' || (!prevRoute.frontendFile && prevRoute.archetype !== 'tested-route')) {
      const ageMs = nowMs - Date.parse(prevRoute.lastSeenAt || prevRoute.lastUpdatedAt || now);
      const isStale = Number.isFinite(ageMs) && ageMs > STALE_RUNTIME_DAYS * 86_400_000;
      routesObj[prevKey] = {
        ...prevRoute,
        source: 'runtime',
        coveringSpecs: [],
        stale: isStale,
      };
    }
  }

  // 2. Merge explored runtime topology (normalizing dynamic URLs back to `:param` patterns! `K-03`)
  const exploredRouteKeys = new Set();
  for (const p of topology.pages || []) {
    const entry = ensureRoute(p.route || p.actualPath || '/', 'runtime');
    exploredRouteKeys.add(entry.route);
    if (p.title) entry.title = p.title;
    if (Array.isArray(p.breadcrumbs) && p.breadcrumbs.length > 0) entry.breadcrumbs = p.breadcrumbs;
    if (p.archetype) entry.archetype = p.archetype;
    if (Array.isArray(p.tableHeaders) && p.tableHeaders.length > 0) entry.tableHeaders = p.tableHeaders;
    if (Array.isArray(p.filterLabels) && p.filterLabels.length > 0) entry.filterLabels = p.filterLabels;
    if (Array.isArray(p.readonlyButtons)) entry.readonlyButtons = [...new Set([...entry.readonlyButtons, ...p.readonlyButtons])];
    if (Array.isArray(p.mutationButtons)) entry.mutationButtons = [...new Set([...entry.mutationButtons, ...p.mutationButtons])];
    if (Array.isArray(p.apisObserved)) entry.linkedApis = [...new Set([...entry.linkedApis, ...p.apisObserved])];
    if (p.a11y) entry.a11y = p.a11y;
    entry.lastSeenAt = now;
    entry.stale = false;
    entry.lastUpdatedAt = now;
  }

  // 2b. Index routes covered by CURRENT specs on disk (deleted specs are automatically pruned! `K-02`)
  for (const sp of specIndex) {
    for (const rPath of sp.uiRoutes || []) {
      const entry = ensureRoute(rPath, 'runtime');
      if (entry.archetype === 'unknown') entry.archetype = 'tested-route';
    }
  }

  // 3. Correlate APIs -> Frontend Files -> Backend Controllers -> DB Tables (`K-04`)
  const apiToBackend = new Map();
  for (const be of sourceIndex.backendEndpoints || []) {
    const list = apiToBackend.get(be.path) || [];
    if (!list.includes(be.file)) list.push(be.file);
    apiToBackend.set(be.path, list);
  }

  for (const entry of Object.values(routesObj)) {
    if (entry.frontendFile) {
      const calls = (sourceIndex.frontendApiCalls || []).filter((c) => c.file === entry.frontendFile);
      for (const c of calls) {
        if (!entry.linkedApis.includes(c.path)) entry.linkedApis.push(c.path);
      }
    }
    const beFiles = new Set();
    for (const apiPath of entry.linkedApis) {
      const matchedBePattern = matchRuntimeRouteToPattern(apiPath, [...apiToBackend.keys()]);
      for (const f of apiToBackend.get(matchedBePattern) || []) beFiles.add(f);
    }
    entry.linkedBackendFiles = [...beFiles];
    entry.linkedDbTables = correlateDbTablesForRoute(entry, sourceIndex.dbEntities || [], sourceIndex.backendFileTexts || {});
  }

  // 4. Rebuild `coveringSpecs` strictly from current `specIndex` on disk (`K-02`)
  const staticAndCurrentPatterns = Object.keys(routesObj);
  for (const entry of Object.values(routesObj)) {
    const matchedSpecs = new Set();
    for (const sp of specIndex) {
      const normalizedSpecRoutes = (sp.uiRoutes || []).map((u) => matchRuntimeRouteToPattern(u, staticAndCurrentPatterns));
      if (normalizedSpecRoutes.includes(entry.route)) matchedSpecs.add(sp.specFile);
      if (entry.linkedApis.some((a) => sp.apiPaths.includes(a))) matchedSpecs.add(sp.specFile);
    }
    entry.coveringSpecs = [...matchedSpecs];

    if (entry.coveringSpecs.length > 0 && outcomesBySpec.size > 0) {
      let anyFail = false;
      let anyPass = false;
      for (const sf of entry.coveringSpecs) {
        const out = outcomesBySpec.get(sf);
        if (!out) continue;
        if (out.failed > 0) anyFail = true;
        else if (out.passed > 0) anyPass = true;
      }
      if (anyFail) entry.lastResult = 'failed';
      else if (anyPass) entry.lastResult = 'passed';
    }
  }

  // 5. Portals, Endpoints & Snapshot-Idempotent Convergent Defects (`K-01`)
  const portalsByKey = new Map();
  for (const pt of [...(base.portals || []), ...(topology.portals || [])]) {
    if (!pt || !pt.name) continue;
    const key = `${pt.mode || 'default'}:${pt.id ?? pt.name}`;
    portalsByKey.set(key, { ...(portalsByKey.get(key) || {}), ...pt });
  }

  const endpointMap = new Map();
  for (const ep of [...(base.endpoints || []), ...(topology.endpoints || [])]) {
    if (!ep?.endpoint) continue;
    endpointMap.set(`${ep.method || 'GET'} ${ep.endpoint}`, ep);
  }

  const processedSnapshots = new Set(base.processedSnapshots || []);
  const currentSnapshotId = computeTopologySnapshotId(topology);
  const isNewSnapshot = Boolean(currentSnapshotId && !processedSnapshots.has(currentSnapshotId));
  if (currentSnapshotId) processedSnapshots.add(currentSnapshotId);

  const defectMap = new Map();
  for (const d of base.defects || []) {
    defectMap.set(d.key, { ...d });
  }

  // Static broken-import defects converge immediately against current sourceIndex!
  const currentBrokenKeys = new Set();
  for (const bi of sourceIndex.brokenRouteImports || []) {
    const key = `broken-import:${bi.route}`;
    currentBrokenKeys.add(key);
    const existing = defectMap.get(key);
    if (existing) {
      existing.status = 'open';
      existing.lastSeenAt = now;
    } else {
      defectMap.set(key, {
        key,
        severity: 'P1',
        type: 'broken-route-import',
        route: bi.route,
        source: bi.routerFile,
        message: `Missing dynamic route target "${bi.importSpec}" (${bi.expectedFile})`,
        status: 'open',
        seenCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      });
    }
  }
  for (const [k, d] of defectMap.entries()) {
    if (d.type === 'broken-route-import' && !currentBrokenKeys.has(k)) {
      d.status = 'closed';
      d.resolvedAt = d.resolvedAt || now;
    }
  }

  // Runtime defects only increment/transition when a NEW exploration snapshot arrives (`K-01`)!
  if (isNewSnapshot) {
    const observedRuntimeKeys = new Set();
    for (const ce of topology.consoleErrors || []) {
      const route = matchRuntimeRouteToPattern(ce.route || '/', staticAndCurrentPatterns);
      const msg = String(ce.message || ce).slice(0, 180);
      const key = `console:${route}:${msg.slice(0, 60)}`;
      observedRuntimeKeys.add(key);
      const prev = defectMap.get(key);
      if (prev) {
        prev.status = 'open';
        prev.cleanStreak = 0;
        prev.seenCount = (prev.seenCount || 1) + 1;
        prev.lastSeenAt = now;
        prev.lastSnapshotId = currentSnapshotId;
      } else {
        defectMap.set(key, {
          key,
          severity: 'P1',
          type: 'console-error',
          route,
          message: msg,
          status: 'open',
          cleanStreak: 0,
          seenCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSnapshotId: currentSnapshotId,
        });
      }
    }

    for (const qa of topology.queryAnomalies || []) {
      const route = matchRuntimeRouteToPattern(qa.route || '/', staticAndCurrentPatterns);
      const key = `query-anomaly:${route}:${qa.detail}`;
      observedRuntimeKeys.add(key);
      const prev = defectMap.get(key);
      if (prev) {
        prev.status = 'open';
        prev.cleanStreak = 0;
        prev.seenCount = (prev.seenCount || 1) + 1;
        prev.lastSeenAt = now;
        prev.lastSnapshotId = currentSnapshotId;
      } else {
        defectMap.set(key, {
          key,
          severity: 'P2',
          type: 'malformed-query-param',
          route,
          message: qa.detail,
          status: 'open',
          cleanStreak: 0,
          seenCount: 1,
          firstSeenAt: now,
          lastSeenAt: now,
          lastSnapshotId: currentSnapshotId,
        });
      }
    }

    // Converge previously open runtime defects on routes visited cleanly in this new snapshot:
    // 1st clean snapshot -> `resolved-candidate`, 2nd consecutive clean snapshot -> `closed`
    for (const [k, d] of defectMap.entries()) {
      if (d.type === 'broken-route-import' || d.status === 'closed') continue;
      if (!observedRuntimeKeys.has(k) && exploredRouteKeys.has(d.route)) {
        d.cleanStreak = Number(d.cleanStreak || 0) + 1;
        if (d.cleanStreak >= 2) {
          d.status = 'closed';
          d.resolvedAt = now;
        } else {
          d.status = 'resolved-candidate';
        }
      }
    }
  }

  const activeRoutes = Object.values(routesObj).filter((r) => !r.stale);
  const coveredRoutes = activeRoutes.filter((r) => r.coveringSpecs.length > 0).length;
  const uncoveredRoutes = activeRoutes.filter((r) => r.coveringSpecs.length === 0).map((r) => r.route);
  const coveragePct = activeRoutes.length > 0 ? Math.round((coveredRoutes / activeRoutes.length) * 100) : 0;

  const perfSnapshots = [...(base.perfSnapshots || [])];
  if (perfReport && perfReport.measuredAt && !perfSnapshots.some((p) => p.measuredAt === perfReport.measuredAt)) {
    perfSnapshots.push({
      measuredAt: perfReport.measuredAt,
      budgetPassed: perfReport.budgetPassed,
      apiP95Ms: perfReport.apiBenchmark?.p95Ms ?? null,
      browserSummary: (perfReport.browserMetrics || []).slice(0, 5).map((m) => ({
        route: m.route,
        ttfbMs: m.ttfbMs,
        fcpMs: m.fcpMs,
        lcpMs: m.lcpMs ?? null,
        cls: m.cls ?? 0,
        domNodes: m.domNodes,
      })),
    });
  }

  const dbTables = (sourceIndex.dbEntities || []).map((d) => d.table);
  const openDefectsCount = [...defectMap.values()].filter((d) => d.status === 'open').length;
  const dayBucket = now.slice(0, 10);
  const history = [...(base.history || [])];
  history.push({
    revision,
    day: dayBucket,
    updatedAt: now,
    totalRoutes: activeRoutes.length,
    coveredRoutes,
    coveragePct,
    endpointsCount: endpointMap.size,
    openDefects: openDefectsCount,
  });

  const nextMap = {
    schemaVersion: SCHEMA_VERSIONS.codeMap,
    version: '4.0',
    revision,
    updatedAt: now,
    contentFingerprint: '',
    baseURL: topology.baseURL || base.baseURL || null,
    techStack: [...new Set([...(base.techStack || []), ...(topology.techStack || [])])],
    portals: [...portalsByKey.values()],
    processedSnapshots: [...processedSnapshots].slice(-50),
    sourceSummary: {
      repoFilesScanned: sourceIndex.fileCount || base.sourceSummary?.repoFilesScanned || 0,
      truncated: Boolean(sourceIndex.truncated),
      warnings: sourceIndex.warnings || [],
      backendEndpointsCount: (sourceIndex.backendEndpoints || []).length || base.sourceSummary?.backendEndpointsCount || 0,
      dbEntities: dbTables.length > 0 ? [...new Set(dbTables)] : base.sourceSummary?.dbEntities || [],
    },
    routes: routesObj,
    endpoints: [...endpointMap.values()],
    defects: [...defectMap.values()],
    duplicateWaterfalls: topology.duplicateWaterfalls || base.duplicateWaterfalls || [],
    coverage: {
      totalRoutes: activeRoutes.length,
      coveredRoutes,
      uncoveredCount: uncoveredRoutes.length,
      uncoveredRoutes,
      coveragePct,
      staleRoutesCount: Object.values(routesObj).filter((r) => r.stale).length,
    },
    perfSnapshots: perfSnapshots.slice(-15),
    history: history.slice(-30),
  };

  nextMap.contentFingerprint = computeCodeMapContentFingerprint(nextMap);
  return nextMap;
}

export function syncImpactMapFromCodeMap(impactMapPath, codeMap) {
  let current = {
    description:
      'Maps changed repository files to targeted Playwright spec files. Custom manual rules are preserved; autoGenerated rules sync from knowledge/code-map.json.',
    rules: [],
  };
  if (fs.existsSync(impactMapPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(impactMapPath, 'utf8'));
      if (parsed && Array.isArray(parsed.rules)) current = parsed;
    } catch {
      // fall back cleanly
    }
  }

  const manualRules = current.rules.filter((r) => !r.autoGenerated);
  const autoRules = [];
  const seenKey = new Set();

  for (const r of Object.values(codeMap.routes || {})) {
    if (!r.coveringSpecs || r.coveringSpecs.length === 0) continue;
    const sources = [r.frontendFile, ...(r.linkedBackendFiles || [])].filter(Boolean);
    if (sources.length === 0) continue;
    const key = `${[...sources].sort().join(',')}->${[...r.coveringSpecs].sort().join(',')}`;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    autoRules.push({
      autoGenerated: true,
      route: r.route,
      match: sources,
      specs: r.coveringSpecs,
    });
  }

  const next = { ...current, rules: [...manualRules, ...autoRules] };
  fs.mkdirSync(path.dirname(impactMapPath), { recursive: true });
  fs.writeFileSync(impactMapPath, JSON.stringify(next, null, 2) + '\n', 'utf8');
  return { manualRulesCount: manualRules.length, autoRulesCount: autoRules.length };
}

export function generateLivingSystemMapMarkdown(codeMap, lang = 'zh') {
  const isZh = lang === 'zh';
  const routes = Object.values(codeMap.routes || {}).filter((r) => !r.stale);
  const defects = (codeMap.defects || []).filter((d) => d.status === 'open' || d.status === 'resolved-candidate');
  const cov = codeMap.coverage || { totalRoutes: routes.length, coveredRoutes: 0, coveragePct: 0, uncoveredRoutes: [] };

  const lines = [
    isZh
      ? `# 活体系统与代码知识地图 (SYSTEM_MAP · Revision v${codeMap.revision || 1})`
      : `# Living System & Code Knowledge Map (Revision v${codeMap.revision || 1})`,
    '',
    isZh
      ? `> 自动同步演进 (Schema v${codeMap.schemaVersion || 4}) · 更新时间：\`${codeMap.updatedAt}\` · 目标：\`${codeMap.baseURL || '未绑定远端 URL'}\``
      : `> Auto-evolving Agent Memory (Schema v${codeMap.schemaVersion || 4}) · Updated: \`${codeMap.updatedAt}\` · Target: \`${codeMap.baseURL || 'local/unconfigured'}\``,
    '',
    isZh ? '## 1. 系统演进与测试覆盖总览' : '## 1. System Evolution & Coverage Summary',
    isZh
      ? `- **当前地图修订号**：\`Revision #${codeMap.revision}\`（累计历史记录 \`${(codeMap.history || []).length}\` 次）`
      : `- **Knowledge Revision**: \`#${codeMap.revision}\` (${(codeMap.history || []).length} recorded revisions)`,
    isZh
      ? `- **路由与源码规模**：已测绘 \`${cov.totalRoutes}\` 条活跃路由 · 已覆盖 \`${cov.coveredRoutes}\` 条（覆盖率 **${cov.coveragePct}%**）· 扫描仓库源码 \`${codeMap.sourceSummary?.repoFilesScanned ?? 0}\` 个${codeMap.sourceSummary?.truncated ? ' *(已达扫描上限截断)*' : ''} · 后端端点 \`${codeMap.sourceSummary?.backendEndpointsCount ?? 0}\` 个 · 数据表 \`${(codeMap.sourceSummary?.dbEntities || []).length}\` 张`
      : `- **Topology & Source Scale**: ${cov.totalRoutes} active routes (${cov.coveredRoutes} covered, **${cov.coveragePct}%**) · ${codeMap.sourceSummary?.repoFilesScanned ?? 0} repo files${codeMap.sourceSummary?.truncated ? ' *(TRUNCATED)*' : ''} · ${codeMap.sourceSummary?.backendEndpointsCount ?? 0} backend endpoints · ${(codeMap.sourceSummary?.dbEntities || []).length} DB entities`,
    isZh
      ? `- **待治理隐患（Open / Candidate）**：\`${defects.length}\` 项`
      : `- **Active Defects (Open / Candidate)**: \`${defects.length}\``,
    '',
    isZh ? '## 2. 全链路路由 ↔ 源码 ↔ 接口 ↔ 用例映射表' : '## 2. Full-Link Route ↔ Code ↔ API ↔ Spec Matrix',
    isZh
      ? '| 路由 | 原型 | 前端源文件 | 关联 API / 后端 | 覆盖用例 | 最近状态 |'
      : '| Route | Archetype | Frontend File | Linked APIs / Backend | Covering Specs | Last Status |',
    '|---|---|---|---|---|---|',
  ];

  for (const r of routes.slice(0, 100)) {
    const apis = [...(r.linkedApis || []).slice(0, 3), ...(r.linkedBackendFiles || []).slice(0, 2)].join(', ') || '-';
    const specs = (r.coveringSpecs || []).join(', ') || (isZh ? '*(待补全)*' : '*(uncovered)*');
    lines.push(
      `| \`${r.route}\` | \`${r.archetype || 'unknown'}\` | \`${r.frontendFile || '-'}\` | ${apis.replace(/\|/g, '\\|')} | ${specs} | \`${r.lastResult || 'untested'}\` |`
    );
  }
  lines.push('');

  lines.push(isZh ? '## 3. 未覆盖优先探索目标 (Uncovered Queue)' : '## 3. Uncovered High-Priority Targets', '');
  if ((cov.uncoveredRoutes || []).length === 0) {
    lines.push(isZh ? '- 所有已测绘活跃路由均已有测试覆盖。' : '- All active mapped routes have spec coverage.', '');
  } else {
    for (const u of cov.uncoveredRoutes.slice(0, 25)) {
      lines.push(`- \`${u}\``);
    }
    lines.push('');
  }

  lines.push(isZh ? '## 4. 已知缺陷与接口瀑布冗余账本' : '## 4. Known Defects & Redundant Waterfall Ledger', '');
  if (defects.length === 0 && (codeMap.duplicateWaterfalls || []).length === 0) {
    lines.push(isZh ? '- 暂未发现断链路由、Console 报错或重复 API 瀑布。' : '- No broken route imports, console errors, or duplicate API waterfalls recorded.', '');
  } else {
    for (const d of defects.slice(0, 30)) {
      lines.push(`- **[${d.severity || 'P2'} · ${d.type} · ${d.status}]** \`${d.route}\` (seen ${d.seenCount}x): ${d.message}`);
    }
    for (const w of (codeMap.duplicateWaterfalls || []).slice(0, 15)) {
      lines.push(`- **[Waterfall]** \`${w.route}\`: \`${w.endpoint}\` fired ${w.count}x on single view load`);
    }
    lines.push('');
  }

  if ((codeMap.perfSnapshots || []).length > 0) {
    const latest = codeMap.perfSnapshots[codeMap.perfSnapshots.length - 1];
    lines.push(
      isZh ? '## 5. 最新性能与 SLO 基线' : '## 5. Latest Performance & SLO Baseline',
      `- Measured At: \`${latest.measuredAt}\` · Budget Passed: \`${latest.budgetPassed}\` · API P95: \`${latest.apiP95Ms ?? '-'} ms\` · LCP: \`${latest.browserSummary?.[0]?.lcpMs ?? '-'} ms\``,
      ''
    );
  }

  return lines.join('\n');
}

function readJsonOptional(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Synchronizes `<qaDir>/knowledge/code-map.json`, `<qaDir>/knowledge/SYSTEM_MAP.md`, and `impact-map.json`.
 * Supports content-hash idempotency (`skipWriteIfUnchanged: true`, `K-06`).
 */
export function syncLivingCodeMap(qaDir, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const repoDir = options.repoDir || path.dirname(qaDir);
  const knowledgeDir = path.join(qaDir, 'knowledge');
  const codeMapPath = path.join(knowledgeDir, 'code-map.json');
  const systemMapMdPath = path.join(knowledgeDir, 'SYSTEM_MAP.md');

  const existingMap = readJsonOptional(codeMapPath);
  const sourceIndex = indexRepositorySource(repoDir, { maxScanFiles: options.maxScanFiles });
  const specIndex = indexQaSpecs(qaDir);
  const topology = readJsonOptional(path.join(qaDir, 'reports', 'system-topology.json'));
  const resultsJson = readJsonOptional(path.join(qaDir, 'reports', 'results.json'));
  const perfReport = readJsonOptional(path.join(qaDir, 'reports', 'perf-report.json'));

  const nextMap = mergeLivingCodeMap(existingMap, {
    sourceIndex,
    specIndex,
    topology,
    resultsJson,
    perfReport,
  });

  if (options.skipWriteIfUnchanged && existingMap?.contentFingerprint === nextMap.contentFingerprint) {
    return {
      codeMapPath,
      systemMapMdPath,
      revision: existingMap.revision,
      unchanged: true,
      truncated: Boolean(sourceIndex.truncated),
      warnings: sourceIndex.warnings || [],
      coverage: existingMap.coverage,
      impactSync: { manualRulesCount: 0, autoRulesCount: 0 },
      openDefects: (existingMap.defects || []).filter((d) => d.status === 'open').length,
    };
  }

  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(codeMapPath, JSON.stringify(nextMap, null, 2) + '\n', 'utf8');
  fs.writeFileSync(systemMapMdPath, generateLivingSystemMapMarkdown(nextMap, lang), 'utf8');

  let impactSync = { manualRulesCount: 0, autoRulesCount: 0 };
  if (options.syncImpact !== false) {
    const impactPath = path.join(qaDir, 'impact-map.json');
    const lockPath = path.join(qaDir, '.aitest', 'governance.lock');
    let impactLocked = false;
    if (fs.existsSync(lockPath)) {
      try {
        const lockObj = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        impactLocked = Boolean(lockObj?.files && 'impact-map.json' in lockObj.files);
      } catch {
        impactLocked = true;
      }
    }

    // Never silently mutate a governance-locked `impact-map.json`; write suggestions to `knowledge/impact-map.suggested.json` (`I-01`)!
    if (impactLocked && options.syncImpact !== 'force') {
      const existing = readJsonOptional(impactPath);
      const manualCount = Array.isArray(existing?.rules) ? existing.rules.filter((r) => !r.autoGenerated).length : 0;
      const suggestedPath = path.join(knowledgeDir, 'impact-map.suggested.json');
      const sug = syncImpactMapFromCodeMap(suggestedPath, nextMap);
      impactSync = {
        manualRulesCount: Math.max(manualCount, sug.manualRulesCount),
        autoRulesCount: sug.autoRulesCount,
        mode: 'suggested-only',
        suggestedPath,
      };
    } else {
      impactSync = syncImpactMapFromCodeMap(impactPath, nextMap);
    }
  }

  return {
    codeMapPath,
    systemMapMdPath,
    revision: nextMap.revision,
    unchanged: false,
    truncated: Boolean(sourceIndex.truncated),
    warnings: sourceIndex.warnings || [],
    coverage: nextMap.coverage,
    impactSync,
    openDefects: nextMap.defects.filter((d) => d.status === 'open').length,
  };
}

export async function runMapCommand(options = {}) {
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

  const repoDir = options.repo ? path.resolve(options.repo) : path.dirname(qaDir);
  const out = syncLivingCodeMap(qaDir, {
    lang,
    repoDir,
    syncImpact: !options.noSyncImpact,
    skipWriteIfUnchanged: options.force ? false : true,
  });

  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    for (const w of out.warnings || []) console.warn(`[CodeMap WARN] ${w}`);
    console.log(
      lang === 'zh'
        ? `\n[CodeMap] 活体代码知识图谱已更新至 Revision #${out.revision}：共 ${out.coverage.totalRoutes} 条活跃路由，覆盖 ${out.coverage.coveredRoutes} 条 (${out.coverage.coveragePct}%)，开放缺陷 ${out.openDefects} 项。`
        : `\n[CodeMap] Living Code Map updated to Revision #${out.revision}: ${out.coverage.coveredRoutes}/${out.coverage.totalRoutes} active routes covered (${out.coverage.coveragePct}%), ${out.openDefects} open defect(s).`
    );
    console.log(`  JSON Knowledge : ${out.codeMapPath}`);
    console.log(`  System Map MD  : ${out.systemMapMdPath}`);
  }
  return 0;
}
