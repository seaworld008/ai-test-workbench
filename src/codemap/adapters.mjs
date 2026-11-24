// @ts-check
import fs from 'node:fs';
import path from 'node:path';

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
export const DEFAULT_MAX_SCAN_FILES = 2500;
const MAX_FILE_BYTES = 256 * 1024;

/** @param {string | null | undefined} p @returns {string} */
export function normalizeSlash(p) {
  return String(p || '').replace(/\\/g, '/');
}

/** @param {string | null | undefined} routePath @returns {string} */
export function normalizeRoutePath(routePath) {
  let clean = String(routePath || '').trim().split('?')[0].split('#')[0];
  if (!clean) return '/';
  if (!clean.startsWith('/')) clean = `/${clean}`;
  if (clean.length > 1 && clean.endsWith('/')) clean = clean.slice(0, -1);
  return clean;
}

/**
 * Converts Next.js bracket route segments (`[id]`, `[...slug]`) into parameterized pattern (`:id`, `:slug*`) (`K-03`).
 * @param {string} seg
 * @returns {string}
 */
export function convertBracketSegment(seg) {
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

/** @param {string} rootDir @param {number} [limit] */
export function walkSourceFiles(rootDir, limit = DEFAULT_MAX_SCAN_FILES) {
  /** @type {string[]} */
  const out = [];
  let truncated = false;

  const walk = (/** @type {string} */ dir) => {
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

/** @param {string} baseFile @param {string} importSpec @param {string} repoDir */
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

// --- Frontend Framework Adapters ---

/** @param {string} relFile */
function extractNextjsRoutes(relFile) {
  /** @type {Array<{ route: string, file: string, kind: string }>} */
  const routes = [];
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
    const converted = raw.split('/').filter(Boolean).map(convertBracketSegment).join('/');
    routes.push({
      route: normalizeRoutePath(raw === 'index' ? '/' : `/${converted}`),
      file: relFile,
      kind: 'nextjs-pages',
    });
  }
  return routes;
}

/** @param {string} filePath @param {string} relFile @param {string} text @param {string} repoDir */
function extractRouterConfigRoutes(filePath, relFile, text, repoDir) {
  /** @type {Array<{ route: string, file: string, kind: string }>} */
  const routes = [];
  /** @type {Array<{ route: string, routerFile: string, importSpec: string, expectedFile: string | null }>} */
  const brokenImports = [];
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
  if (/\.[jt]sx$/.test(relFile) && /<Route\b/.test(text)) {
    for (const m of text.matchAll(/<Route\b[^>]*?\bpath\s*=\s*['"`](\/[^'"`*?]+)['"`]/g)) {
      routes.push({ route: normalizeRoutePath(m[1]), file: relFile, kind: 'react-router-jsx' });
    }
  }
  return { routes, brokenImports };
}

/** @param {string} relFile @param {string} text */
function extractFrontendApiCalls(relFile, text) {
  /** @type {Array<{ method: string, path: string, file: string }>} */
  const apiCalls = [];
  for (const m of text.matchAll(/\bfetch\s*\(\s*['"`]([^'"`$]+)['"`]/g)) {
    if (m[1].startsWith('/')) apiCalls.push({ method: 'FETCH', path: normalizeRoutePath(m[1]), file: relFile });
  }
  for (const m of text.matchAll(/\baxios\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`$]+)['"`]/gi)) {
    if (m[2].startsWith('/')) apiCalls.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile });
  }
  for (const m of text.matchAll(/\brequest\s*\(\s*\{\s*[^}]*?url\s*:\s*['"`]([^'"`$]+)['"`]/gi)) {
    if (m[1].startsWith('/')) apiCalls.push({ method: 'REQUEST', path: normalizeRoutePath(m[1]), file: relFile });
  }
  return apiCalls;
}

/** @param {string} filePath @param {string} relFile @param {string} text @param {string} repoDir */
export function extractFrontendData(filePath, relFile, text, repoDir) {
  const nextRoutes = extractNextjsRoutes(relFile);
  const routerRes = extractRouterConfigRoutes(filePath, relFile, text, repoDir);
  const apiCalls = extractFrontendApiCalls(relFile, text);
  return {
    routes: [...nextRoutes, ...routerRes.routes],
    brokenImports: routerRes.brokenImports,
    apiCalls,
  };
}

// --- Backend & DB Framework Adapters ---

/** @param {string} relFile @param {string} text */
function extractSpringAdapter(relFile, text) {
  /** @type {Array<{ method: string, path: string, file: string, framework: string }>} */
  const endpoints = [];
  /** @type {Array<{ table: string, file: string, source: string }>} */
  const entities = [];
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
  return { endpoints, entities };
}

/** @param {string} relFile @param {string} text */
function extractNodeBackendAdapter(relFile, text) {
  /** @type {Array<{ method: string, path: string, file: string, framework: string }>} */
  const endpoints = [];
  /** @type {Array<{ table: string, file: string, source: string }>} */
  const entities = [];
  const ctrlMatch = text.match(/@Controller\s*\(\s*['"]([^'"]*)['"]/);
  const ctrlPrefix = ctrlMatch ? `/${ctrlMatch[1].replace(/^\/|\/$/g, '')}` : '';
  for (const m of text.matchAll(/\b(?:app|router)\.(get|post|put|delete|patch)\s*\(\s*['"`]([^'"`]+)['"`]/g)) {
    endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'express/fastify' });
  }
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
  return { endpoints, entities };
}

/** @param {string} relFile @param {string} text */
export function extractBackendAndDbData(relFile, text) {
  /** @type {Array<{ method: string, path: string, file: string, framework: string }>} */
  const endpoints = [];
  /** @type {Array<{ table: string, file: string, source: string }>} */
  const entities = [];
  const ext = path.extname(relFile).toLowerCase();

  const nextApi = relFile.match(/^(?:src\/)?app\/(api\/.+)\/route\.[jt]sx?$/i);
  if (nextApi) {
    const converted = nextApi[1].split('/').map(convertBracketSegment).join('/');
    endpoints.push({ method: 'ANY', path: normalizeRoutePath(`/${converted}`), file: relFile, framework: 'nextjs-api' });
  }

  if (ext === '.java' || ext === '.kt') {
    const res = extractSpringAdapter(relFile, text);
    endpoints.push(...res.endpoints);
    entities.push(...res.entities);
  } else if (['.ts', '.js', '.mjs'].includes(ext)) {
    const res = extractNodeBackendAdapter(relFile, text);
    endpoints.push(...res.endpoints);
    entities.push(...res.entities);
  } else if (ext === '.py') {
    for (const m of text.matchAll(/@(?:app|router|bp)\.(get|post|put|delete|patch|route)\s*\(\s*['"]([^'"]+)['"]/g)) {
      endpoints.push({ method: m[1] === 'route' ? 'ANY' : m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'python' });
    }
  } else if (ext === '.php') {
    for (const m of text.matchAll(/Route::(get|post|put|delete|any)\s*\(\s*['"]([^'"]+)['"]/g)) {
      endpoints.push({ method: m[1].toUpperCase(), path: normalizeRoutePath(m[2]), file: relFile, framework: 'php' });
    }
  } else if (ext === '.prisma') {
    for (const m of text.matchAll(/^\s*model\s+([A-Za-z0-9_]+)\s*\{/gm)) {
      entities.push({ table: m[1], file: relFile, source: 'prisma' });
    }
  } else if (ext === '.sql') {
    for (const m of text.matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[`"']?([a-zA-Z0-9_.]+)[`"']?/gi)) {
      entities.push({ table: m[1], file: relFile, source: 'sql' });
    }
  }

  return { endpoints, entities };
}

/**
 * Indexes static routes, API calls, backend endpoints, and DB entities from host repository files (`K-05` truncation reporting).
 * @param {string} repoDir
 * @param {{ maxScanFiles?: number }} [options]
 */
export function indexRepositorySource(repoDir, options = {}) {
  const maxScanFiles = options.maxScanFiles || DEFAULT_MAX_SCAN_FILES;
  const result = {
    repoDir: normalizeSlash(repoDir || ''),
    fileCount: 0,
    truncated: false,
    warnings: /** @type {string[]} */ ([]),
    frontendRoutes: /** @type {Array<{ route: string, file: string, kind: string }>} */ ([]),
    brokenRouteImports: /** @type {Array<{ route: string, routerFile: string, importSpec: string, expectedFile: string | null }>} */ ([]),
    frontendApiCalls: /** @type {Array<{ method: string, path: string, file: string }>} */ ([]),
    backendEndpoints: /** @type {Array<{ method: string, path: string, file: string, framework: string }>} */ ([]),
    dbEntities: /** @type {Array<{ table: string, file: string, source: string }>} */ ([]),
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

/** @param {string} qaDir */
export function indexQaSpecs(qaDir) {
  const testsDir = path.join(qaDir, 'tests');
  /** @type {Array<{ specFile: string, uiRoutes: string[], apiPaths: string[] }>} */
  const specs = [];
  if (!fs.existsSync(testsDir)) return specs;

  const walk = (/** @type {string} */ dir) => {
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
        /** @type {Set<string>} */
        const uiRoutes = new Set();
        /** @type {Set<string>} */
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
