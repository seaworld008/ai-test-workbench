// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import {
  getCodeMapAdapters,
  listCodeMapAdapters,
  registerCodeMapAdapter,
  unregisterCodeMapAdapter,
} from './registry.mjs';
import {
  convertBracketSegment,
  createRoutePatternMatcher,
  matchRuntimeRouteToPattern,
  normalizeRoutePath,
  normalizeSlash,
} from './route-matcher.mjs';

export {
  convertBracketSegment,
  createRoutePatternMatcher,
  listCodeMapAdapters,
  matchRuntimeRouteToPattern,
  normalizeRoutePath,
  normalizeSlash,
  registerCodeMapAdapter,
  unregisterCodeMapAdapter,
};

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
  '.svelte',
  '.astro',
  '.java',
  '.kt',
  '.py',
  '.php',
  '.go',
  '.prisma',
  '.sql',
]);

export const DEFAULT_MAX_SCAN_FILES = 10000;
const MAX_FILE_BYTES = 256 * 1024;

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

/**
 * @param {string} filePath
 * @param {string} relFile
 * @param {string} text
 * @param {string} repoDir
 * @param {import('./registry.mjs').SourceFileIndex} [fileIndex]
 */
export function extractFrontendData(filePath, relFile, text, repoDir, fileIndex) {
  /** @type {import('./registry.mjs').FrontendRouteEntry[]} */
  const routes = [];
  /** @type {import('./registry.mjs').BrokenRouteImport[]} */
  const brokenImports = [];
  /** @type {import('./registry.mjs').FrontendApiCall[]} */
  const apiCalls = [];
  const ext = path.extname(relFile).toLowerCase();
  const ctx = { filePath, relFile, ext, text, repoDir, fileIndex };

  for (const adapter of getCodeMapAdapters().frontend) {
    const out = adapter.extract(ctx);
    if (!out) continue;
    if (out.routes?.length) routes.push(...out.routes);
    if (out.brokenImports?.length) brokenImports.push(...out.brokenImports);
    if (out.apiCalls?.length) apiCalls.push(...out.apiCalls);
  }
  return { routes, brokenImports, apiCalls };
}

/** @param {string} relFile @param {string} text */
export function extractBackendAndDbData(relFile, text) {
  /** @type {import('./registry.mjs').BackendEndpoint[]} */
  const endpoints = [];
  /** @type {import('./registry.mjs').DbEntity[]} */
  const entities = [];
  const ext = path.extname(relFile).toLowerCase();
  const ctx = { relFile, ext, text };

  for (const adapter of getCodeMapAdapters().backend) {
    const out = adapter.extract(ctx);
    if (!out) continue;
    if (out.endpoints?.length) endpoints.push(...out.endpoints);
    if (out.entities?.length) entities.push(...out.entities);
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
    frontendRoutes: /** @type {import('./registry.mjs').FrontendRouteEntry[]} */ ([]),
    brokenRouteImports: /** @type {import('./registry.mjs').BrokenRouteImport[]} */ ([]),
    frontendApiCalls: /** @type {import('./registry.mjs').FrontendApiCall[]} */ ([]),
    backendEndpoints: /** @type {import('./registry.mjs').BackendEndpoint[]} */ ([]),
    dbEntities: /** @type {import('./registry.mjs').DbEntity[]} */ ([]),
    backendFileTexts: /** @type {Record<string, string>} */ ({}),
  };
  if (!repoDir || !fs.existsSync(repoDir)) return result;

  const walked = walkSourceFiles(repoDir, maxScanFiles);
  result.fileCount = walked.files.length;
  result.truncated = walked.truncated;
  if (walked.truncated) {
    result.warnings.push(`Source scan reached maxScanFiles=${maxScanFiles}; configure a narrower --repo or higher limit.`);
  }

  const fileIndex = {
    relSet: new Set(walked.files.map((fp) => normalizeSlash(path.relative(repoDir, fp)))),
    hasSrcDir: fs.existsSync(path.join(repoDir, 'src')),
    truncated: walked.truncated,
  };

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

    const fe = extractFrontendData(filePath, relFile, text, repoDir, fileIndex);
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
