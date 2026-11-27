// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { discoverMonorepoSubProjects } from '../init/stack-registry.mjs';
import { normalizeRoutePath, normalizeSlash } from './route-matcher.mjs';

const ALWAYS_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
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
const ROOT_ONLY_OUTPUT_DIRS = new Set(['dist', 'build', 'out', 'target']);
const IGNORED_VENDOR_DIR_SUFFIXES = ['public/libs', 'public/static', 'static/libs'];
export const SPRING_CFG_FILE_RE = /^(?:application|bootstrap)(?:-[a-z0-9_.-]+)?\.(?:ya?ml|properties)$/i;

const CODE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.svelte', '.astro',
  '.java', '.kt', '.py', '.php', '.go', '.prisma', '.sql', '.xml',
]);

export const DEFAULT_MAX_SCAN_FILES = 10000;
export const DEFAULT_PER_REPO_SCAN_FILES = 16000;

/**
 * Detects independent child frontend/backend repository roots under a multi-repo parent
 * or polyglot monorepo root (delegating to `discoverMonorepoSubProjects`).
 * @param {string} parentDir
 * @returns {string[]}
 */
export function detectMultiRepoRoots(parentDir) {
  return discoverMonorepoSubProjects(parentDir);
}

/**
 * Walks source files in a repo while preserving `build`/`dist`/`out`/`target` under `src/`
 * and ignoring vendor bundle folders and `*.min.js`.
 * @param {string} rootDir
 * @param {number} [limit]
 */
export function walkSourceFiles(rootDir, limit = DEFAULT_PER_REPO_SCAN_FILES) {
  /** @type {string[]} */
  const out = [];
  let truncated = false;
  const rootStartsInSrc = path.basename(path.resolve(rootDir)) === 'src';

  const walk = (/** @type {string} */ dir, /** @type {string} */ relDir, /** @type {boolean} */ hasSrcAncestor) => {
    if (!dir || !fs.existsSync(dir)) return;
    if (out.length >= limit) { truncated = true; return; }
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= limit) { truncated = true; break; }
      if (ALWAYS_IGNORE_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      const childRel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (ROOT_ONLY_OUTPUT_DIRS.has(entry.name) && !hasSrcAncestor) continue;
        if (IGNORED_VENDOR_DIR_SUFFIXES.some((sfx) => childRel === sfx || childRel.endsWith(`/${sfx}`))) continue;
        walk(path.join(dir, entry.name), childRel, hasSrcAncestor || entry.name === 'src');
      } else if (entry.isFile()) {
        if (/\.min\.[mc]?js$/i.test(entry.name)) continue;
        const ext = path.extname(entry.name).toLowerCase();
        if (CODE_EXTS.has(ext) || SPRING_CFG_FILE_RE.test(entry.name)) {
          out.push(path.join(dir, entry.name));
        }
      }
    }
  };

  walk(rootDir, '', rootStartsInSrc);
  return { files: out, truncated };
}

/**
 * Extracts balanced `(...)` argument text for `waitForResponse(...)` / `waitForRequest(...)` calls.
 * @param {string} text
 * @returns {string[]}
 */
function extractWaitForArgBlocks(text) {
  /** @type {string[]} */
  const blocks = [];
  for (const m of text.matchAll(/\.(?:waitForResponse|waitForRequest)\s*\(/g)) {
    const start = (m.index || 0) + m[0].length - 1;
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "'" || ch === '"' || ch === '`') {
        const q = ch;
        i += 1;
        while (i < text.length) {
          if (text[i] === '\\') i += 1;
          else if (text[i] === q) break;
          i += 1;
        }
        continue;
      }
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) {
          blocks.push(text.slice(start + 1, i));
          break;
        }
      }
    }
  }
  return blocks;
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
        for (const block of extractWaitForArgBlocks(text)) {
          for (const sm of block.matchAll(/['"`]((?:https?:\/\/[^'"`\s]+|\*\*|)?\/[^'"`\s*?#]+)\*?['"`]/g)) {
            const raw = sm[1].replace(/^\*\*/, '');
            try {
              const p = raw.startsWith('http') ? new URL(raw).pathname : raw;
              if (p.length > 1 && !/\.(?:png|jpe?g|svg|css|js|woff2?)$/i.test(p)) {
                apiPaths.add(normalizeRoutePath(p));
              }
            } catch {
              // ignore malformed URL
            }
          }
          for (const rm of block.matchAll(/\/((?:\\\/[A-Za-z0-9_.:-]+){2,})/g)) {
            apiPaths.add(normalizeRoutePath(rm[1].replace(/\\\//g, '/')));
          }
        }
        specs.push({ specFile: rel, uiRoutes: [...uiRoutes], apiPaths: [...apiPaths] });
      }
    }
  };
  walk(testsDir);
  return specs;
}
