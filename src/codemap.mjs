import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';

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
]);

const CODE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.vue', '.java', '.kt', '.py', '.php', '.go', '.prisma', '.sql']);
const VIEW_EXTS = ['', '.vue', '.tsx', '.ts', '.jsx', '.js', '/index.vue', '/index.tsx', '/index.ts', '/index.js'];
const MAX_SCAN_FILES = 2000;
const MAX_FILE_BYTES = 256 * 1024;

function walkSourceFiles(rootDir, out = [], limit = MAX_SCAN_FILES) {
  if (!rootDir || !fs.existsSync(rootDir) || out.length >= limit) return out;
  let entries;
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (out.length >= limit) break;
    if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out, limit);
    } else if (entry.isFile() && CODE_EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function normalizeSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

function normalizeRoutePath(routePath) {
  let clean = String(routePath || '').trim().split('?')[0].split('#')[0];
  if (!clean) return '/';
  if (!clean.startsWith('/')) clean = `/${clean}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
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

  // Next.js App Router & Pages Router file conventions
  const appMatch = relFile.match(/^(?:src\/)?app(?:\/(.*))?\/page\.[jt]sx?$/i);
  if (appMatch) {
    const segs = (appMatch[1] || '')
      .split('/')
      .filter((s) => s && !s.startsWith('(') && !s.startsWith('['));
    routes.push({ route: normalizeRoutePath(`/${segs.join('/')}`), file: relFile, kind: 'nextjs-app' });
  }
  const pageMatch = relFile.match(/^(?:src\/)?pages\/(.+)\.[jt]sx?$/i);
  if (pageMatch && !/\/(?:_app|_document|_error|api\/)/.test(relFile)) {
    const raw = pageMatch[1].replace(/\/index$/i, '');
    if (!raw.includes('[')) {
      routes.push({ route: normalizeRoutePath(raw === 'index' ? '/' : `/${raw}`), file: relFile, kind: 'nextjs-pages' });
    }
  }

  // Vue / React Router object literals + lazy import check
  if (/\.(?:ts|tsx|js|jsx|mjs)$/.test(relFile) && /path\s*:\s*['"`]/.test(text)) {
    const pathPropRe = /path\s*:\s*['"`]([^'"`*?:#]+)['"`]/g;
    for (const match of text.matchAll(pathPropRe)) {
      const routePath = match[1];
      if (!routePath.startsWith('/')) continue;
      const tail = text.slice(match.index + match[0].length, match.index + match[0].length + 260);
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

  // Frontend API calls
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

  // Next.js App API routes
  const nextApi = relFile.match(/^(?:src\/)?app\/(api\/.+)\/route\.[jt]sx?$/i);
  if (nextApi) {
    endpoints.push({ method: 'ANY', path: normalizeRoutePath(`/${nextApi[1]}`), file: relFile, framework: 'nextjs-api' });
  }

  // Java Spring Boot Controllers
  if (ext === '.java' || ext === '.kt') {
    const classPrefixMatch = text.match(/@RequestMapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/);
    const prefix = classPrefixMatch ? classPrefixMatch[1].replace(/\/$/, '') : '';
    const mapRe = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*\(\s*(?:value\s*=\s*)?['"]([^'"]+)['"]/g;
    for (const m of text.matchAll(mapRe)) {
      const fullPath = normalizeRoutePath(`${prefix}/${m[2].replace(/^\//, '')}`);
      if (fullPath === prefix && m[1] === 'Request') continue;
      endpoints.push({ method: m[1] === 'Request' ? 'ANY' : m[1].toUpperCase(), path: fullPath, file: relFile, framework: 'spring' });
    }
    for (const m of text.matchAll(/@(?:TableName|Table)\s*\(\s*(?:value\s*=|name\s*=)?\s*['"]([a-zA-Z0-9_]+)['"]/g)) {
      entities.push({ table: m[1], file: relFile, source: 'jpa/mybatis' });
    }
  }

  // Node Express / Fastify / NestJS
  if (['.ts', '.js', '.mjs'].includes(ext)) {
    const ctrlMatch = text.match(/@Controller\s*\(\s*['"]([^'"]*)['"]/);
    const ctrlPrefix = ctrlMatch ? `/${ctrlMatch[1].replace(/^\/|\/$/g, '')}` : '';
    for (const m of text.matchAll(/\b(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
      endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'express/fastify' });
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

  // Python FastAPI / Flask
  if (ext === '.py') {
    for (const m of text.matchAll(/@(?:app|router|bp)\.(get|post|put|delete|patch|route)\s*\(\s*['"]([^'"]+)['"]/g)) {
      endpoints.push({ method: m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'python' });
    }
  }

  // PHP Routes
  if (ext === '.php') {
    for (const m of text.matchAll(/Route::(get|post|put|delete|any)\s*\(\s*['"]([^'"]+)['"]/g)) {
      endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'php' });
    }
  }

  // Prisma & SQL schemas
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
 * Indexes static routes, API calls, backend endpoints, and DB entities from host repository files.
 */
export function indexRepositorySource(repoDir) {
  const result = {
    repoDir: normalizeSlash(repoDir || ''),
    fileCount: 0,
    frontendRoutes: [],
    brokenRouteImports: [],
    frontendApiCalls: [],
    backendEndpoints: [],
    dbEntities: [],
  };
  if (!repoDir || !fs.existsSync(repoDir)) return result;

  const files = walkSourceFiles(repoDir);
  result.fileCount = files.length;

  for (const filePath of files) {
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
  }

  return result;
}

/**
 * Indexes Playwright test specs inside `<qaDir>/tests` to determine which UI routes and APIs are tested.
 */
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

        for (const m of text.matchAll(/(?:\.|^|\s)(?:goto|verifyProtectedRouteRedirectsToLogin|visitModuleAndVerifyReady)\s*\([^)]*?['"`](\/[^'"`?#)]*)['"`]/gm)) {
          uiRoutes.add(normalizeRoutePath(m[1]));
        }
        for (const m of text.matchAll(/(?:\.|^|\s)(?:get|post|put|delete|patch|fetch|verifyGatewayUnauthenticated401)\s*\([^)]*?['"`]((?:https?:\/\/[^'"`]+)?\/[^'"`]+)['"`]/gm)) {
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
  const map = new Map();
  if (!resultsJson || !Array.isArray(resultsJson.suites)) return map;
  const walkSuite = (suite, fileHint = '') => {
    const curFile = normalizeSlash(suite.file || fileHint);
    for (const spec of suite.specs || []) {
      const f = normalizeSlash(spec.file || curFile);
      const specKey = f.startsWith('tests/') ? f : f ? `tests/${f}` : 'unknown';
      const statuses = (spec.tests || []).map((t) => t.status);
      const prev = map.get(specKey) || { passed: 0, failed: 0, flaky: 0 };
      for (const s of statuses) {
        if (s === 'expected') prev.passed += 1;
        else if (s === 'unexpected') prev.failed += 1;
        else if (s === 'flaky') prev.flaky += 1;
      }
      map.set(specKey, prev);
    }
    for (const child of suite.suites || []) walkSuite(child, curFile);
  };
  for (const s of resultsJson.suites) walkSuite(s);
  return map;
}

function upsertDefect(defectMap, key, item) {
  const existing = defectMap.get(key);
  if (existing) {
    existing.status = 'open';
    existing.seenCount = (existing.seenCount || 1) + 1;
    existing.lastSeenAt = item.lastSeenAt;
    return;
  }
  defectMap.set(key, { ...item, key, status: 'open', seenCount: 1 });
}

/**
 * Incrementally fuses static code index + runtime exploration topology + test results + perf snapshots
 * into a self-evolving Knowledge Map (`knowledge/code-map.json`).
 */
export function mergeLivingCodeMap(existingMap, inputs = {}) {
  const now = new Date().toISOString();
  const base = existingMap && typeof existingMap === 'object' ? existingMap : {};
  const revision = Number(base.revision || 0) + 1;

  const sourceIndex = inputs.sourceIndex || {
    fileCount: 0,
    frontendRoutes: [],
    brokenRouteImports: [],
    frontendApiCalls: [],
    backendEndpoints: [],
    dbEntities: [],
  };
  const topology = inputs.topology || {};
  const specIndex = Array.isArray(inputs.specIndex) ? inputs.specIndex : [];
  const resultsJson = inputs.resultsJson || null;
  const perfReport = inputs.perfReport || null;
  const outcomesBySpec = collectTestOutcomesByFile(resultsJson);

  const routesObj = { ...(base.routes || {}) };
  const ensureRoute = (rPath) => {
    const key = normalizeRoutePath(rPath);
    if (!routesObj[key]) {
      routesObj[key] = {
        route: key,
        title: '',
        breadcrumbs: [],
        archetype: 'unknown',
        frontendFile: null,
        tableHeaders: [],
        filterLabels: [],
        readonlyButtons: [],
        mutationButtons: [],
        linkedApis: [],
        linkedBackendFiles: [],
        linkedDbTables: [],
        coveringSpecs: [],
        lastResult: 'untested',
        a11y: null,
        lastUpdatedAt: now,
      };
    }
    return routesObj[key];
  };

  // 1. Merge static frontend routes & source files
  for (const fr of sourceIndex.frontendRoutes || []) {
    const entry = ensureRoute(fr.route);
    if (fr.file && !entry.frontendFile) entry.frontendFile = fr.file;
    entry.lastUpdatedAt = now;
  }

  // 2. Merge explored runtime topology (preserves multi-portal routes cumulatively)
  for (const p of topology.pages || []) {
    const entry = ensureRoute(p.route || p.actualPath || '/');
    if (p.title) entry.title = p.title;
    if (Array.isArray(p.breadcrumbs) && p.breadcrumbs.length > 0) entry.breadcrumbs = p.breadcrumbs;
    if (p.archetype) entry.archetype = p.archetype;
    if (Array.isArray(p.tableHeaders) && p.tableHeaders.length > 0) entry.tableHeaders = p.tableHeaders;
    if (Array.isArray(p.filterLabels) && p.filterLabels.length > 0) entry.filterLabels = p.filterLabels;
    if (Array.isArray(p.readonlyButtons)) entry.readonlyButtons = [...new Set([...entry.readonlyButtons, ...p.readonlyButtons])];
    if (Array.isArray(p.mutationButtons)) entry.mutationButtons = [...new Set([...entry.mutationButtons, ...p.mutationButtons])];
    if (Array.isArray(p.apisObserved)) entry.linkedApis = [...new Set([...entry.linkedApis, ...p.apisObserved])];
    if (p.a11y) entry.a11y = p.a11y;
    entry.lastUpdatedAt = now;
  }

  // 2b. Ensure routes covered by existing specs or deep test summaries are also indexed in the Living Code Map
  for (const sp of specIndex) {
    for (const rPath of sp.uiRoutes || []) {
      const entry = ensureRoute(rPath);
      if (entry.archetype === 'unknown') entry.archetype = 'tested-route';
    }
  }
  const deepGroups = topology.deepFunctionalTests || {};
  for (const list of Object.values(deepGroups)) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item && typeof item.route === 'string') {
        const entry = ensureRoute(item.route);
        if (entry.archetype === 'unknown') entry.archetype = 'crud-table';
      }
    }
  }

  // 3. Correlate APIs -> Frontend Files -> Backend Controllers -> DB Tables
  const apiToBackend = new Map();
  for (const be of sourceIndex.backendEndpoints || []) {
    const list = apiToBackend.get(be.path) || [];
    if (!list.includes(be.file)) list.push(be.file);
    apiToBackend.set(be.path, list);
  }
  const dbTables = (sourceIndex.dbEntities || []).map((d) => d.table);
  for (const entry of Object.values(routesObj)) {
    if (entry.frontendFile) {
      const calls = (sourceIndex.frontendApiCalls || []).filter((c) => c.file === entry.frontendFile);
      for (const c of calls) {
        if (!entry.linkedApis.includes(c.path)) entry.linkedApis.push(c.path);
      }
    }
    const beFiles = new Set(entry.linkedBackendFiles || []);
    for (const apiPath of entry.linkedApis) {
      for (const f of apiToBackend.get(apiPath) || []) beFiles.add(f);
    }
    entry.linkedBackendFiles = [...beFiles];

    if (entry.route === '/' && entry.linkedApis.length === 0 && (topology.endpoints || []).length > 0) {
      // keep global discovery concise
    }
    const matchedTables = dbTables.filter((t) =>
      entry.route.toLowerCase().includes(t.toLowerCase()) ||
      entry.linkedApis.some((a) => a.toLowerCase().includes(t.toLowerCase()))
    );
    entry.linkedDbTables = [...new Set([...(entry.linkedDbTables || []), ...matchedTables])];
  }

  // 4. Correlate Specs & Test Results
  for (const entry of Object.values(routesObj)) {
    const matchedSpecs = new Set(entry.coveringSpecs || []);
    for (const sp of specIndex) {
      if (sp.uiRoutes.includes(entry.route)) matchedSpecs.add(sp.specFile);
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

  // 5. Portals, Endpoints & Defects
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

  const defectMap = new Map();
  for (const d of base.defects || []) {
    defectMap.set(d.key, { ...d });
  }
  for (const bi of sourceIndex.brokenRouteImports || []) {
    upsertDefect(defectMap, `broken-import:${bi.route}`, {
      severity: 'P1',
      type: 'broken-route-import',
      route: bi.route,
      source: bi.routerFile,
      message: `Missing dynamic route target "${bi.importSpec}" (${bi.expectedFile})`,
      lastSeenAt: now,
    });
  }
  for (const ce of topology.consoleErrors || []) {
    const route = ce.route || '/';
    const msg = String(ce.message || ce).slice(0, 180);
    upsertDefect(defectMap, `console:${route}:${msg.slice(0, 60)}`, {
      severity: 'P1',
      type: 'console-error',
      route,
      message: msg,
      lastSeenAt: now,
    });
  }
  for (const qa of topology.queryAnomalies || []) {
    upsertDefect(defectMap, `query-anomaly:${qa.route || '/'}:${qa.detail}`, {
      severity: 'P2',
      type: 'malformed-query-param',
      route: qa.route || '/',
      message: qa.detail,
      lastSeenAt: now,
    });
  }

  const allRoutes = Object.values(routesObj);
  const coveredRoutes = allRoutes.filter((r) => r.coveringSpecs.length > 0).length;
  const uncoveredRoutes = allRoutes.filter((r) => r.coveringSpecs.length === 0).map((r) => r.route);
  const coveragePct = allRoutes.length > 0 ? Math.round((coveredRoutes / allRoutes.length) * 100) : 0;

  const perfSnapshots = [...(base.perfSnapshots || [])];
  if (perfReport && perfReport.measuredAt) {
    perfSnapshots.push({
      measuredAt: perfReport.measuredAt,
      budgetPassed: perfReport.budgetPassed,
      apiP95Ms: perfReport.apiBenchmark?.p95Ms ?? null,
      browserSummary: (perfReport.browserMetrics || []).slice(0, 5).map((m) => ({
        route: m.route,
        ttfbMs: m.ttfbMs,
        fcpMs: m.fcpMs,
        domNodes: m.domNodes,
      })),
    });
  }

  const history = [...(base.history || [])];
  const openDefectsCount = [...defectMap.values()].filter((d) => d.status === 'open').length;
  history.push({
    revision,
    updatedAt: now,
    totalRoutes: allRoutes.length,
    coveredRoutes,
    coveragePct,
    endpointsCount: endpointMap.size,
    openDefects: openDefectsCount,
  });

  return {
    version: '3.0',
    revision,
    updatedAt: now,
    baseURL: topology.baseURL || base.baseURL || null,
    techStack: [...new Set([...(base.techStack || []), ...(topology.techStack || [])])],
    portals: [...portalsByKey.values()],
    sourceSummary: {
      repoFilesScanned: sourceIndex.fileCount || base.sourceSummary?.repoFilesScanned || 0,
      backendEndpointsCount: (sourceIndex.backendEndpoints || []).length || base.sourceSummary?.backendEndpointsCount || 0,
      dbEntities: dbTables.length > 0 ? [...new Set(dbTables)] : base.sourceSummary?.dbEntities || [],
    },
    routes: routesObj,
    endpoints: [...endpointMap.values()],
    defects: [...defectMap.values()],
    duplicateWaterfalls: topology.duplicateWaterfalls || base.duplicateWaterfalls || [],
    coverage: {
      totalRoutes: allRoutes.length,
      coveredRoutes,
      uncoveredCount: uncoveredRoutes.length,
      uncoveredRoutes,
      coveragePct,
    },
    perfSnapshots: perfSnapshots.slice(-15),
    history: history.slice(-30),
  };
}

/**
 * Updates `<qaDir>/impact-map.json` non-destructively: preserves user rules and refreshes `autoGenerated: true` rules.
 */
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
    const key = `${sources.sort().join(',')}->${r.coveringSpecs.sort().join(',')}`;
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

/**
 * Generates human- and AI-readable Living System Knowledge Atlas (`knowledge/SYSTEM_MAP.md`).
 */
export function generateLivingSystemMapMarkdown(codeMap, lang = 'zh') {
  const isZh = lang === 'zh';
  const routes = Object.values(codeMap.routes || {});
  const defects = (codeMap.defects || []).filter((d) => d.status === 'open');
  const cov = codeMap.coverage || { totalRoutes: routes.length, coveredRoutes: 0, coveragePct: 0, uncoveredRoutes: [] };

  const lines = [
    isZh
      ? `# 活体系统与代码知识地图 (SYSTEM_MAP · Revision v${codeMap.revision || 1})`
      : `# Living System & Code Knowledge Map (Revision v${codeMap.revision || 1})`,
    '',
    isZh
      ? `> 自动同步演进 · 更新时间：\`${codeMap.updatedAt}\` · 目标：\`${codeMap.baseURL || '未绑定远端 URL'}\``
      : `> Auto-evolving Agent Memory · Updated: \`${codeMap.updatedAt}\` · Target: \`${codeMap.baseURL || 'local/unconfigured'}\``,
    '',
    isZh ? '## 1. 系统演进与测试覆盖总览' : '## 1. System Evolution & Coverage Summary',
    isZh
      ? `- **当前地图修订号**：\`Revision #${codeMap.revision}\`（累计历史记录 \`${(codeMap.history || []).length}\` 次）`
      : `- **Knowledge Revision**: \`#${codeMap.revision}\` (${(codeMap.history || []).length} recorded revisions)`,
    isZh
      ? `- **路由与源码规模**：已测绘 \`${cov.totalRoutes}\` 条路由 · 已覆盖 \`${cov.coveredRoutes}\` 条（覆盖率 **${cov.coveragePct}%**）· 扫描仓库源码 \`${codeMap.sourceSummary?.repoFilesScanned ?? 0}\` 个 · 后端端点 \`${codeMap.sourceSummary?.backendEndpointsCount ?? 0}\` 个 · 数据表 \`${(codeMap.sourceSummary?.dbEntities || []).length}\` 张`
      : `- **Topology & Source Scale**: ${cov.totalRoutes} routes (${cov.coveredRoutes} covered, **${cov.coveragePct}%**) · ${codeMap.sourceSummary?.repoFilesScanned ?? 0} repo files · ${codeMap.sourceSummary?.backendEndpointsCount ?? 0} backend endpoints · ${(codeMap.sourceSummary?.dbEntities || []).length} DB entities`,
    isZh
      ? `- **待治理隐患（Open）**：\`${defects.length}\` 项（含断链路由、Console 错误、畸形参数）`
      : `- **Open Defects**: \`${defects.length}\` (broken imports, console errors, malformed query params)`,
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
    lines.push(isZh ? '- 所有已测绘路由均已有测试覆盖。' : '- All mapped routes have spec coverage.', '');
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
      lines.push(`- **[${d.severity || 'P2'} · ${d.type}]** \`${d.route}\` (seen ${d.seenCount}x): ${d.message}`);
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
      `- Measured At: \`${latest.measuredAt}\` · Budget Passed: \`${latest.budgetPassed}\` · API P95: \`${latest.apiP95Ms ?? '-'} ms\``,
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
 */
export function syncLivingCodeMap(qaDir, options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const repoDir = options.repoDir || path.dirname(qaDir);
  const knowledgeDir = path.join(qaDir, 'knowledge');
  const codeMapPath = path.join(knowledgeDir, 'code-map.json');
  const systemMapMdPath = path.join(knowledgeDir, 'SYSTEM_MAP.md');

  const existingMap = readJsonOptional(codeMapPath);
  const sourceIndex = indexRepositorySource(repoDir);
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

  fs.mkdirSync(knowledgeDir, { recursive: true });
  fs.writeFileSync(codeMapPath, JSON.stringify(nextMap, null, 2) + '\n', 'utf8');
  fs.writeFileSync(systemMapMdPath, generateLivingSystemMapMarkdown(nextMap, lang), 'utf8');

  let impactSync = { manualRulesCount: 0, autoRulesCount: 0 };
  if (options.syncImpact !== false) {
    impactSync = syncImpactMapFromCodeMap(path.join(qaDir, 'impact-map.json'), nextMap);
  }

  return {
    codeMapPath,
    systemMapMdPath,
    revision: nextMap.revision,
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
  });

  if (options.json) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(
      lang === 'zh'
        ? `\n[CodeMap] 活体代码知识图谱已更新至 Revision #${out.revision}：共 ${out.coverage.totalRoutes} 条路由，覆盖 ${out.coverage.coveredRoutes} 条 (${out.coverage.coveragePct}%)，开放缺陷 ${out.openDefects} 项。`
        : `\n[CodeMap] Living Code Map updated to Revision #${out.revision}: ${out.coverage.coveredRoutes}/${out.coverage.totalRoutes} routes covered (${out.coverage.coveragePct}%), ${out.openDefects} open defect(s).`
    );
    console.log(`  JSON Knowledge : ${out.codeMapPath}`);
    console.log(`  System Map MD  : ${out.systemMapMdPath}`);
  }
  return 0;
}
