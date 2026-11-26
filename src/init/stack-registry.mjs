// @ts-check
import fs from 'node:fs';
import path from 'node:path';

/**
 * @typedef {{
 *   name: 'npm' | 'pnpm' | 'yarn' | 'bun',
 *   runScript: (scriptName: string) => string,
 * }} PackageManagerInfo
 *
 * @typedef {{
 *   repoDir: string,
 *   pkg: Record<string, any> | null,
 *   deps: Record<string, string>,
 *   scripts: Record<string, string>,
 *   pm: PackageManagerInfo,
 *   hasFile: (rel: string) => boolean,
 *   readText: (rel: string) => string,
 * }} StackDetectContext
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   group?: string,
 *   match: (ctx: StackDetectContext) => boolean,
 *   defaultPort?: number | ((ctx: StackDetectContext) => number),
 *   healthPath?: string | ((ctx: StackDetectContext) => string),
 *   defaultCommand?: string | null | ((ctx: StackDetectContext) => string | null),
 * }} StackDescriptor
 */

/** @param {'npm' | 'pnpm' | 'yarn' | 'bun'} name @returns {PackageManagerInfo} */
function makePmInfo(name) {
  if (name === 'yarn') {
    return { name: 'yarn', runScript: (scriptName) => `yarn ${scriptName}` };
  }
  if (name === 'bun') {
    return { name: 'bun', runScript: (scriptName) => `bun run ${scriptName}` };
  }
  if (name === 'pnpm') {
    return {
      name: 'pnpm',
      runScript: (scriptName) => (scriptName === 'start' ? 'pnpm start' : `pnpm run ${scriptName}`),
    };
  }
  return {
    name: 'npm',
    runScript: (scriptName) => (scriptName === 'start' ? 'npm start' : `npm run ${scriptName}`),
  };
}

/**
 * Detects the host repository's Node package manager from `package.json#packageManager`
 * or lockfiles (`pnpm-lock.yaml`, `yarn.lock`, `bun.lock` / `bun.lockb`, fallback `npm`).
 * @param {string} repoDir
 * @returns {PackageManagerInfo}
 */
export function detectPackageManager(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return makePmInfo('npm');
  const pkgPath = path.join(repoDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (typeof pkg.packageManager === 'string') {
        const pmRaw = pkg.packageManager.trim().toLowerCase();
        if (pmRaw.startsWith('pnpm@') || pmRaw === 'pnpm') return makePmInfo('pnpm');
        if (pmRaw.startsWith('yarn@') || pmRaw === 'yarn') return makePmInfo('yarn');
        if (pmRaw.startsWith('bun@') || pmRaw === 'bun') return makePmInfo('bun');
        if (pmRaw.startsWith('npm@') || pmRaw === 'npm') return makePmInfo('npm');
      }
    } catch {
      // fall through to lockfile inspection
    }
  }
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return makePmInfo('pnpm');
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) return makePmInfo('yarn');
  if (fs.existsSync(path.join(repoDir, 'bun.lock')) || fs.existsSync(path.join(repoDir, 'bun.lockb'))) {
    return makePmInfo('bun');
  }
  return makePmInfo('npm');
}

/** @param {StackDetectContext} ctx @returns {string | null} */
function pickJsDevOrStartCommand(ctx) {
  if (ctx.scripts.dev) return ctx.pm.runScript('dev');
  if (ctx.scripts.start) return ctx.pm.runScript('start');
  return null;
}

/** @param {StackDetectContext} ctx @returns {boolean} */
function isFastApiOrUvicorn(ctx) {
  if (!ctx.hasFile('pyproject.toml') && !ctx.hasFile('requirements.txt')) return false;
  const combined = `${ctx.readText('pyproject.toml')}\n${ctx.readText('requirements.txt')}`;
  return /\b(?:fastapi|uvicorn)\b/i.test(combined);
}

/** @type {StackDescriptor[]} */
export const STACK_DESCRIPTORS = [
  {
    id: 'nextjs',
    label: 'Next.js',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.next),
    defaultPort: 3000,
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'nuxt',
    label: 'Nuxt',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.nuxt),
    defaultPort: 3000,
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'sveltekit',
    label: 'SvelteKit',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps['@sveltejs/kit']),
    defaultPort: 5173,
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'astro',
    label: 'Astro',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.astro),
    defaultPort: 4321,
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'remix',
    label: 'Remix',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps['@remix-run/dev'] || ctx.deps['@react-router/dev']),
    defaultPort: 5173,
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'angular',
    label: 'Angular',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps['@angular/core']),
    defaultPort: 4200,
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'vue',
    label: 'Vue/H5',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.vue),
    defaultPort: (ctx) => (ctx.deps.vite ? 5173 : 3000),
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'react',
    label: 'React',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.react),
    defaultPort: (ctx) => (ctx.deps.vite || ctx.deps['@vitejs/plugin-react'] ? 5173 : 3000),
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'nodejs',
    label: 'Node.js',
    group: 'js-framework',
    match: (ctx) => ctx.hasFile('package.json'),
    defaultPort: (ctx) => (ctx.deps.vite || ctx.deps['@vitejs/plugin-react'] ? 5173 : 3000),
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'python-fastapi',
    label: 'Python/FastAPI',
    group: 'python',
    match: isFastApiOrUvicorn,
    defaultPort: 8000,
    healthPath: '/health',
    defaultCommand: 'uvicorn main:app --host 127.0.0.1 --port 8000',
  },
  {
    id: 'python',
    label: 'Python',
    group: 'python',
    match: (ctx) => ctx.hasFile('pyproject.toml') || ctx.hasFile('requirements.txt'),
    defaultPort: 8000,
    healthPath: '/health',
    defaultCommand: 'uvicorn main:app --host 127.0.0.1 --port 8000',
  },
  {
    id: 'go',
    label: 'Go',
    match: (ctx) => ctx.hasFile('go.mod'),
    defaultPort: 8080,
    healthPath: '/healthz',
    defaultCommand: 'go run .',
  },
  {
    id: 'java-spring',
    label: 'Java/Spring',
    match: (ctx) => ctx.hasFile('pom.xml') || ctx.hasFile('build.gradle') || ctx.hasFile('build.gradle.kts'),
    defaultPort: 8080,
    healthPath: '/actuator/health',
    defaultCommand: null,
  },
  {
    id: 'rust',
    label: 'Rust',
    match: (ctx) => ctx.hasFile('Cargo.toml'),
    defaultPort: 3000,
    healthPath: '/health',
    defaultCommand: 'cargo run',
  },
  {
    id: 'php-thinkphp',
    label: 'PHP/ThinkPHP',
    match: (ctx) => ctx.hasFile('composer.json') || ctx.hasFile('think'),
    defaultPort: 8000,
    healthPath: '/',
    defaultCommand: null,
  },
];

/**
 * Registers a declarative stack descriptor. Replaces an existing descriptor with the same `id`.
 * @param {StackDescriptor} descriptor
 * @param {{ prepend?: boolean }} [options]
 * @returns {string}
 */
export function registerStackDescriptor(descriptor, options = {}) {
  if (!descriptor || typeof descriptor !== 'object' || typeof descriptor.id !== 'string' || !descriptor.id.trim()) {
    throw new TypeError('StackDescriptor must define a non-empty string "id".');
  }
  if (typeof descriptor.label !== 'string' || !descriptor.label.trim()) {
    throw new TypeError(`StackDescriptor "${descriptor.id}" must define a non-empty string "label".`);
  }
  if (typeof descriptor.match !== 'function') {
    throw new TypeError(`StackDescriptor "${descriptor.id}" must define a "match(ctx)" function.`);
  }
  const idx = STACK_DESCRIPTORS.findIndex((d) => d.id === descriptor.id);
  if (idx >= 0) STACK_DESCRIPTORS.splice(idx, 1);
  if (options.prepend) STACK_DESCRIPTORS.unshift(descriptor);
  else STACK_DESCRIPTORS.push(descriptor);
  return descriptor.id;
}

/**
 * Unregisters a stack descriptor by `id`.
 * @param {string} id
 * @returns {boolean}
 */
export function unregisterStackDescriptor(id) {
  const idx = STACK_DESCRIPTORS.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  STACK_DESCRIPTORS.splice(idx, 1);
  return true;
}

/** @param {string} repoDir @returns {StackDetectContext} */
function buildStackDetectContext(repoDir) {
  /** @type {Map<string, boolean>} */
  const existsCache = new Map();
  /** @type {Map<string, string>} */
  const textCache = new Map();
  const hasFile = (/** @type {string} */ rel) => {
    let hit = existsCache.get(rel);
    if (hit === undefined) {
      hit = Boolean(repoDir) && fs.existsSync(path.join(repoDir, rel));
      existsCache.set(rel, hit);
    }
    return hit;
  };
  const readText = (/** @type {string} */ rel) => {
    let hit = textCache.get(rel);
    if (hit === undefined) {
      if (!hasFile(rel)) {
        hit = '';
      } else {
        try {
          hit = fs.readFileSync(path.join(repoDir, rel), 'utf8');
        } catch {
          hit = '';
        }
      }
      textCache.set(rel, hit);
    }
    return hit;
  };

  /** @type {Record<string, any> | null} */
  let pkg = null;
  if (hasFile('package.json')) {
    try {
      pkg = JSON.parse(readText('package.json'));
    } catch {
      pkg = null;
    }
  }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = detectPackageManager(repoDir);
  return { repoDir, pkg, deps, scripts, pm, hasFile, readText };
}

/**
 * Evaluates registered stack descriptors against `repoDir`, respecting exclusive descriptor groups.
 * @param {string} repoDir
 * @returns {{ matched: StackDescriptor[], labels: string[], ctx: StackDetectContext }}
 */
export function detectStacksFromDescriptors(repoDir) {
  const ctx = buildStackDetectContext(repoDir);
  if (!repoDir || !fs.existsSync(repoDir)) {
    return { matched: [], labels: [], ctx };
  }
  /** @type {StackDescriptor[]} */
  const matched = [];
  /** @type {Set<string>} */
  const matchedGroups = new Set();

  for (const desc of STACK_DESCRIPTORS) {
    if (desc.group && matchedGroups.has(desc.group)) continue;
    if (desc.match(ctx)) {
      matched.push(desc);
      if (desc.group) matchedGroups.add(desc.group);
    }
  }

  return {
    matched,
    labels: matched.map((d) => d.label),
    ctx,
  };
}

/**
 * Infers default runtime server settings (`stack`, `packageManager`, `defaultPort`, `healthPath`, `command`)
 * from registered stack descriptors and detected package manager.
 * @param {string} repoDir
 * @returns {{ stack: string, stacks: string[], packageManager: PackageManagerInfo['name'], defaultPort: number, healthPath: string, command: string | null }}
 */
export function inferStackRuntimeDefaults(repoDir) {
  const { matched, labels, ctx } = detectStacksFromDescriptors(repoDir);
  /** @param {StackDescriptor} d */
  const resolveCmd = (d) =>
    typeof d.defaultCommand === 'function' ? d.defaultCommand(ctx) : d.defaultCommand ?? null;
  /** @param {StackDescriptor} d */
  const resolvePort = (d) =>
    typeof d.defaultPort === 'function' ? d.defaultPort(ctx) : d.defaultPort ?? 3000;
  /** @param {StackDescriptor} d */
  const resolveHealth = (d) =>
    typeof d.healthPath === 'function' ? d.healthPath(ctx) : d.healthPath ?? '/';

  const withCmd = matched.find((d) => Boolean(resolveCmd(d))) || null;
  const primary = withCmd || matched[0] || null;

  return {
    stack: labels[0] || 'Generic Web',
    stacks: labels.length > 0 ? labels : ['Generic Web'],
    packageManager: ctx.pm.name,
    defaultPort: primary ? resolvePort(primary) : 3000,
    healthPath: primary ? resolveHealth(primary) : '/',
    command: primary ? resolveCmd(primary) : null,
  };
}
