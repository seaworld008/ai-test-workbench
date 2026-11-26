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

const REPO_MARKERS = ['.git', 'package.json', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'go.mod', 'pyproject.toml', 'requirements.txt'];

/** @param {'npm' | 'pnpm' | 'yarn' | 'bun'} name @returns {PackageManagerInfo} */
function makePmInfo(name) {
  if (name === 'yarn') return { name: 'yarn', runScript: (s) => `yarn ${s}` };
  if (name === 'bun') return { name: 'bun', runScript: (s) => `bun run ${s}` };
  if (name === 'pnpm') return { name: 'pnpm', runScript: (s) => (s === 'start' ? 'pnpm start' : `pnpm run ${s}`) };
  return { name: 'npm', runScript: (s) => (s === 'start' ? 'npm start' : `npm run ${s}`) };
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
      // fall through
    }
  }
  if (fs.existsSync(path.join(repoDir, 'pnpm-lock.yaml'))) return makePmInfo('pnpm');
  if (fs.existsSync(path.join(repoDir, 'yarn.lock'))) return makePmInfo('yarn');
  if (fs.existsSync(path.join(repoDir, 'bun.lock')) || fs.existsSync(path.join(repoDir, 'bun.lockb'))) return makePmInfo('bun');
  return makePmInfo('npm');
}

/** @param {StackDetectContext} ctx @returns {string | null} */
function pickJsDevOrStartCommand(ctx) {
  if (ctx.scripts.dev) return ctx.pm.runScript('dev');
  if (ctx.scripts.serve) return ctx.pm.runScript('serve');
  if (ctx.scripts.start) return ctx.pm.runScript('start');
  return null;
}

/** @param {StackDetectContext} ctx @returns {boolean} */
function isFastApiOrUvicorn(ctx) {
  if (!ctx.hasFile('pyproject.toml') && !ctx.hasFile('requirements.txt')) return false;
  const combined = `${ctx.readText('pyproject.toml')}\n${ctx.readText('requirements.txt')}`;
  return /\b(?:fastapi|uvicorn)\b/i.test(combined);
}

/** @param {StackDetectContext} ctx @returns {boolean} */
export function isVue2Project(ctx) {
  const ver = String(ctx.deps.vue || '');
  if (/^[\^~>=<\s]*2\./.test(ver)) return true;
  if (ctx.deps['vue-template-compiler']) return true;
  if (ctx.deps['element-ui'] && !ctx.deps['element-plus']) return true;
  return false;
}

/** @param {StackDetectContext} ctx @returns {number | null} */
function readVueCliPort(ctx) {
  for (const cfg of ['vue.config.js', 'vue.config.cjs', 'vue.config.mjs']) {
    if (!ctx.hasFile(cfg)) continue;
    const m = ctx.readText(cfg).match(/\bport\s*:\s*(?:process\.env\.[A-Z0-9_]+\s*\|\|\s*)?(\d{2,5})\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

/** @param {string} pomText @returns {string[]} */
export function extractMavenModules(pomText) {
  const modsMatch = String(pomText || '').match(/<modules>([\s\S]*?)<\/modules>/i);
  if (!modsMatch) return [];
  return [...modsMatch[1].matchAll(/<module>\s*([^<\s]+)\s*<\/module>/gi)].map((m) => m[1].trim()).filter(Boolean);
}

/** @param {string} repoDir @returns {string[]} */
export function detectSiblingRepoDirs(repoDir) {
  if (!repoDir || !fs.existsSync(repoDir)) return [];
  if (REPO_MARKERS.some((m) => fs.existsSync(path.join(repoDir, m)))) return [];
  /** @type {string[]} */
  const subRepos = [];
  try {
    for (const entry of fs.readdirSync(repoDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'qa' || entry.name === 'node_modules') continue;
      const full = path.join(repoDir, entry.name);
      if (REPO_MARKERS.some((m) => fs.existsSync(path.join(full, m)))) subRepos.push(full);
    }
  } catch {
    return [];
  }
  return subRepos.length >= 2 ? subRepos : [];
}

/** @type {StackDescriptor[]} */
export const STACK_DESCRIPTORS = [
  { id: 'nextjs', label: 'Next.js', group: 'js-framework', match: (ctx) => Boolean(ctx.deps.next), defaultPort: 3000, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  { id: 'nuxt', label: 'Nuxt', group: 'js-framework', match: (ctx) => Boolean(ctx.deps.nuxt), defaultPort: 3000, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  { id: 'sveltekit', label: 'SvelteKit', group: 'js-framework', match: (ctx) => Boolean(ctx.deps['@sveltejs/kit']), defaultPort: 5173, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  { id: 'astro', label: 'Astro', group: 'js-framework', match: (ctx) => Boolean(ctx.deps.astro), defaultPort: 4321, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  { id: 'remix', label: 'Remix', group: 'js-framework', match: (ctx) => Boolean(ctx.deps['@remix-run/dev'] || ctx.deps['@react-router/dev']), defaultPort: 5173, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  { id: 'angular', label: 'Angular', group: 'js-framework', match: (ctx) => Boolean(ctx.deps['@angular/core']), defaultPort: 4200, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  {
    id: 'vue2',
    label: 'Vue 2',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.vue) && isVue2Project(ctx),
    defaultPort: (ctx) => (ctx.deps['@vue/cli-service'] ? readVueCliPort(ctx) || 8080 : ctx.deps.vite ? 5173 : 3000),
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  {
    id: 'vue',
    label: 'Vue 3',
    group: 'js-framework',
    match: (ctx) => Boolean(ctx.deps.vue) && !isVue2Project(ctx),
    defaultPort: (ctx) => (ctx.deps['@vue/cli-service'] ? readVueCliPort(ctx) || 8080 : ctx.deps.vite ? 5173 : 3000),
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  { id: 'react', label: 'React', group: 'js-framework', match: (ctx) => Boolean(ctx.deps.react), defaultPort: (ctx) => (ctx.deps.vite || ctx.deps['@vitejs/plugin-react'] ? 5173 : 3000), healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  {
    id: 'nodejs',
    label: 'Node.js',
    group: 'js-framework',
    match: (ctx) => ctx.hasFile('package.json'),
    defaultPort: (ctx) => (ctx.deps['@vue/cli-service'] ? readVueCliPort(ctx) || 8080 : ctx.deps.vite || ctx.deps['@vitejs/plugin-react'] ? 5173 : 3000),
    healthPath: '/',
    defaultCommand: pickJsDevOrStartCommand,
  },
  { id: 'element-ui', label: 'Element UI', match: (ctx) => Boolean(ctx.deps['element-ui']) },
  { id: 'element-plus', label: 'Element Plus', match: (ctx) => Boolean(ctx.deps['element-plus']) },
  { id: 'vue-cli', label: 'Vue CLI', match: (ctx) => Boolean(ctx.deps['@vue/cli-service']), defaultPort: (ctx) => readVueCliPort(ctx) || 8080, healthPath: '/', defaultCommand: pickJsDevOrStartCommand },
  { id: 'python-fastapi', label: 'Python/FastAPI', group: 'python', match: isFastApiOrUvicorn, defaultPort: 8000, healthPath: '/health', defaultCommand: 'uvicorn main:app --host 127.0.0.1 --port 8000' },
  { id: 'python', label: 'Python', group: 'python', match: (ctx) => ctx.hasFile('pyproject.toml') || ctx.hasFile('requirements.txt'), defaultPort: 8000, healthPath: '/health', defaultCommand: 'uvicorn main:app --host 127.0.0.1 --port 8000' },
  { id: 'go', label: 'Go', match: (ctx) => ctx.hasFile('go.mod'), defaultPort: 8080, healthPath: '/healthz', defaultCommand: 'go run .' },
  { id: 'java-spring', label: 'Java/Spring', match: (ctx) => ctx.hasFile('pom.xml') || ctx.hasFile('build.gradle') || ctx.hasFile('build.gradle.kts'), defaultPort: 8080, healthPath: '/actuator/health', defaultCommand: null },
  { id: 'maven-multi-module', label: 'Maven Multi-Module', match: (ctx) => ctx.hasFile('pom.xml') && extractMavenModules(ctx.readText('pom.xml')).length > 0 },
  { id: 'rust', label: 'Rust', match: (ctx) => ctx.hasFile('Cargo.toml'), defaultPort: 3000, healthPath: '/health', defaultCommand: 'cargo run' },
  { id: 'php-thinkphp', label: 'PHP/ThinkPHP', match: (ctx) => ctx.hasFile('composer.json') || ctx.hasFile('think'), defaultPort: 8000, healthPath: '/', defaultCommand: null },
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
export function buildStackDetectContext(repoDir) {
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
      if (!hasFile(rel)) hit = '';
      else {
        try { hit = fs.readFileSync(path.join(repoDir, rel), 'utf8'); } catch { hit = ''; }
      }
      textCache.set(rel, hit);
    }
    return hit;
  };

  /** @type {Record<string, any> | null} */
  let pkg = null;
  if (hasFile('package.json')) {
    try { pkg = JSON.parse(readText('package.json')); } catch { pkg = null; }
  }
  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const scripts = pkg && pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const pm = detectPackageManager(repoDir);
  return { repoDir, pkg, deps, scripts, pm, hasFile, readText };
}

/**
 * Evaluates registered stack descriptors against `repoDir`, including multi-repo sibling workspaces.
 * @param {string} repoDir
 * @returns {{ matched: StackDescriptor[], labels: string[], ctx: StackDetectContext, siblingRepos: string[] }}
 */
export function detectStacksFromDescriptors(repoDir) {
  const ctx = buildStackDetectContext(repoDir);
  if (!repoDir || !fs.existsSync(repoDir)) {
    return { matched: [], labels: [], ctx, siblingRepos: [] };
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

  const siblingRepos = matched.length === 0 ? detectSiblingRepoDirs(repoDir) : [];
  if (siblingRepos.length >= 2) {
    const labelSet = new Set();
    for (const sub of siblingRepos) {
      const subRes = detectStacksFromDescriptors(sub);
      for (const lbl of subRes.labels) labelSet.add(lbl);
      for (const d of subRes.matched) {
        if (!matched.some((m) => m.id === d.id)) matched.push(d);
      }
    }
    labelSet.add('Multi-Repo Workspace');
    return { matched, labels: [...labelSet], ctx, siblingRepos };
  }

  return { matched, labels: matched.map((d) => d.label), ctx, siblingRepos };
}

/**
 * Infers default runtime server settings (`stack`, `packageManager`, `defaultPort`, `healthPath`, `command`).
 * @param {string} repoDir
 * @returns {{ stack: string, stacks: string[], packageManager: PackageManagerInfo['name'], defaultPort: number, healthPath: string, command: string | null }}
 */
export function inferStackRuntimeDefaults(repoDir) {
  const { matched, labels, ctx, siblingRepos } = detectStacksFromDescriptors(repoDir);
  if (siblingRepos.length >= 2) {
    for (const sub of siblingRepos) {
      const subDefaults = inferStackRuntimeDefaults(sub);
      if (subDefaults.command) {
        return { ...subDefaults, stacks: labels.length > 0 ? labels : subDefaults.stacks };
      }
    }
  }

  /** @param {StackDescriptor} d */
  const resolveCmd = (d) => (typeof d.defaultCommand === 'function' ? d.defaultCommand(ctx) : d.defaultCommand ?? null);
  /** @param {StackDescriptor} d */
  const resolvePort = (d) => (typeof d.defaultPort === 'function' ? d.defaultPort(ctx) : d.defaultPort ?? 3000);
  /** @param {StackDescriptor} d */
  const resolveHealth = (d) => (typeof d.healthPath === 'function' ? d.healthPath(ctx) : d.healthPath ?? '/');

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
