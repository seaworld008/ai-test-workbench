// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { BUILTIN_BACKEND_ADAPTERS } from './backend-adapters.mjs';
import { convertBracketSegment, normalizeRoutePath, normalizeSlash } from './route-matcher.mjs';
import { extractFrontendImportsAndApis } from './vue-api-extractor.mjs';
import { extractVueRouterRoutes } from './vue-extractor.mjs';

const VIEW_EXTS = [
  '',
  '.vue',
  '.svelte',
  '.astro',
  '.tsx',
  '.ts',
  '.jsx',
  '.js',
  '/index.vue',
  '/index.tsx',
  '/index.ts',
  '/index.jsx',
  '/index.js',
];

/**
 * @typedef {{ route: string, file: string, kind: string }} FrontendRouteEntry
 * @typedef {{ route: string, routerFile: string, importSpec: string, expectedFile: string | null }} BrokenRouteImport
 * @typedef {{ method: string, path: string, file: string, fnName?: string }} FrontendApiCall
 * @typedef {{ relSet?: Set<string>, lowerToRel?: Map<string, string>, hasSrcDir?: boolean, truncated?: boolean }} SourceFileIndex
 * @typedef {{ filePath: string, relFile: string, ext: string, text: string, repoDir: string, fileIndex?: SourceFileIndex }} FrontendAdapterContext
 * @typedef {{ routes?: FrontendRouteEntry[], brokenImports?: BrokenRouteImport[], apiCalls?: FrontendApiCall[], imports?: string[], axiosPrefixes?: string[] }} FrontendAdapterResult
 * @typedef {{ id: string, description?: string, extract: (ctx: FrontendAdapterContext) => FrontendAdapterResult | null | undefined }} FrontendCodeMapAdapter
 * @typedef {import('./backend-adapters.mjs').BackendEndpoint} BackendEndpoint
 * @typedef {import('./backend-adapters.mjs').DbEntity} DbEntity
 * @typedef {import('./backend-adapters.mjs').JavaFileMeta} JavaFileMeta
 * @typedef {import('./backend-adapters.mjs').MybatisMapperMeta} MybatisMapperMeta
 * @typedef {import('./backend-adapters.mjs').BackendCodeMapAdapter} BackendCodeMapAdapter
 */

/**
 * @param {string} baseFile
 * @param {string} importSpec
 * @param {string} repoDir
 * @param {SourceFileIndex} [fileIndex]
 */
export function resolveImportCandidate(baseFile, importSpec, repoDir, fileIndex) {
  let resolvedBase = null;
  if (importSpec.startsWith('./') || importSpec.startsWith('../')) {
    resolvedBase = path.resolve(path.dirname(baseFile), importSpec);
  } else if (importSpec.startsWith('@/')) {
    const sub = importSpec.slice(2);
    const hasSrc = fileIndex?.hasSrcDir !== undefined ? fileIndex.hasSrcDir : fs.existsSync(path.join(repoDir, 'src'));
    resolvedBase = hasSrc ? path.join(repoDir, 'src', sub) : path.join(repoDir, sub);
  }
  if (!resolvedBase) return { resolvedRel: null, exists: true };
  const baseRel = normalizeSlash(path.relative(repoDir, resolvedBase));
  if (fileIndex?.relSet) {
    for (const ext of VIEW_EXTS) {
      const candRel = `${baseRel}${ext}`;
      if (fileIndex.relSet.has(candRel)) return { resolvedRel: candRel, exists: true };
      const ciRel = fileIndex.lowerToRel?.get(candRel.toLowerCase());
      if (ciRel) return { resolvedRel: ciRel, exists: true };
    }
    if (!fileIndex.truncated) return { resolvedRel: baseRel, exists: false };
  }
  for (const ext of VIEW_EXTS) {
    const candidate = `${resolvedBase}${ext}`;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return { resolvedRel: normalizeSlash(path.relative(repoDir, candidate)), exists: true };
    }
  }
  return { resolvedRel: baseRel, exists: false };
}

/** @type {FrontendCodeMapAdapter[]} */
const BUILTIN_FRONTEND_ADAPTERS = [
  {
    id: 'nextjs',
    description: 'Next.js App Router (app/**/page.*) & Pages Router (pages/**/*.*)',
    extract({ relFile }) {
      /** @type {FrontendRouteEntry[]} */
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
      return { routes };
    },
  },
  {
    id: 'sveltekit',
    description: 'SvelteKit file-based routes ((src/)?routes/**/+page.svelte)',
    extract({ relFile }) {
      const m = relFile.match(/^(?:src\/)?routes(?:\/(.*))?\/\+page\.svelte$/i);
      if (!m) return null;
      const segs = (m[1] || '')
        .split('/')
        .filter((s) => s && !s.startsWith('('))
        .map(convertBracketSegment);
      return { routes: [{ route: normalizeRoutePath(`/${segs.join('/')}`), file: relFile, kind: 'sveltekit' }] };
    },
  },
  {
    id: 'nuxt-astro',
    description: 'Nuxt & Astro file-based pages ((src/)?pages/**/*.vue|*.astro)',
    extract({ relFile }) {
      const m = relFile.match(/^(?:src\/)?pages\/(.+)\.(vue|astro)$/i);
      if (!m) return null;
      const raw = m[1].replace(/\/index$/i, '');
      const converted = raw.split('/').filter(Boolean).map(convertBracketSegment).join('/');
      const kind = m[2].toLowerCase() === 'astro' ? 'astro-pages' : 'nuxt-pages';
      return {
        routes: [{ route: normalizeRoutePath(raw === 'index' ? '/' : `/${converted}`), file: relFile, kind }],
      };
    },
  },
  {
    id: 'router-config',
    description: 'Declarative JS/TS/Vue nested & regex router configs + JSX <Route>',
    extract({ filePath, relFile, text, repoDir, fileIndex }) {
      const vueOut = extractVueRouterRoutes({ filePath, relFile, text, repoDir, fileIndex, resolveImportCandidate });
      const routes = [...vueOut.routes];
      if (/\.[jt]sx$/.test(relFile) && /<Route\b/.test(text)) {
        for (const m of text.matchAll(/<Route\b[^>]*?\bpath\s*=\s*['"`](\/[^'"`*?]+)['"`]/g)) {
          routes.push({ route: normalizeRoutePath(m[1]), file: relFile, kind: 'react-router-jsx' });
        }
      }
      return { routes, brokenImports: vueOut.brokenImports };
    },
  },
  {
    id: 'frontend-api-calls',
    description: 'Frontend fetch / axios / request({ url }) API calls, static imports & axios wrapper prefixes',
    extract({ filePath, relFile, ext, text, repoDir, fileIndex }) {
      return extractFrontendImportsAndApis({
        filePath,
        relFile,
        ext,
        text,
        repoDir,
        fileIndex,
        resolveImportCandidate,
      });
    },
  },
];

/** @type {FrontendCodeMapAdapter[]} */
const frontendAdapters = [...BUILTIN_FRONTEND_ADAPTERS];
/** @type {BackendCodeMapAdapter[]} */
const backendAdapters = [...BUILTIN_BACKEND_ADAPTERS];

/**
 * Registers a pluggable frontend or backend CodeMap adapter.
 * Re-registering an existing `id` replaces it cleanly.
 * @param {'frontend' | 'backend'} kind
 * @param {FrontendCodeMapAdapter | BackendCodeMapAdapter} adapter
 * @param {{ prepend?: boolean }} [options]
 * @returns {string}
 */
export function registerCodeMapAdapter(kind, adapter, options = {}) {
  if (kind !== 'frontend' && kind !== 'backend') {
    throw new TypeError(`Invalid CodeMap adapter kind "${String(kind)}": expected "frontend" or "backend".`);
  }
  if (!adapter || typeof adapter !== 'object' || typeof adapter.id !== 'string' || !adapter.id.trim()) {
    throw new TypeError('CodeMap adapter must define a non-empty string "id".');
  }
  if (typeof adapter.extract !== 'function') {
    throw new TypeError(`CodeMap adapter "${adapter.id}" must define an "extract(ctx)" function.`);
  }

  const list = /** @type {Array<{ id: string }>} */ (kind === 'frontend' ? frontendAdapters : backendAdapters);
  const existingIdx = list.findIndex((a) => a.id === adapter.id);
  if (existingIdx >= 0) list.splice(existingIdx, 1);
  if (options.prepend) list.unshift(adapter);
  else list.push(adapter);
  return adapter.id;
}

/**
 * Unregisters a previously registered CodeMap adapter by `kind` and `id`.
 * @param {'frontend' | 'backend'} kind
 * @param {string} id
 * @returns {boolean}
 */
export function unregisterCodeMapAdapter(kind, id) {
  if (kind !== 'frontend' && kind !== 'backend') {
    throw new TypeError(`Invalid CodeMap adapter kind "${String(kind)}": expected "frontend" or "backend".`);
  }
  const list = kind === 'frontend' ? frontendAdapters : backendAdapters;
  const idx = list.findIndex((a) => a.id === id);
  if (idx < 0) return false;
  list.splice(idx, 1);
  return true;
}

/**
 * Lists currently active CodeMap adapters by category.
 * @returns {{ frontend: Array<{ id: string, description: string }>, backend: Array<{ id: string, description: string }> }}
 */
export function listCodeMapAdapters() {
  return {
    frontend: frontendAdapters.map((a) => ({ id: a.id, description: a.description || '' })),
    backend: backendAdapters.map((a) => ({ id: a.id, description: a.description || '' })),
  };
}

/** @returns {{ frontend: readonly FrontendCodeMapAdapter[], backend: readonly BackendCodeMapAdapter[] }} */
export function getCodeMapAdapters() {
  return { frontend: frontendAdapters, backend: backendAdapters };
}
