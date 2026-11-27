// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../core/proc.mjs';
import { REPO_ROOT as WORKBENCH_ROOT } from '../core/version.mjs';
import {
  STACK_DESCRIPTORS,
  buildStackDetectContext,
  detectPackageManager,
  detectSiblingRepoDirs,
  detectStacksFromDescriptors,
  extractMavenModules,
  inferStackRuntimeDefaults,
  isVue2Project,
  registerStackDescriptor,
  unregisterStackDescriptor,
} from './stack-registry.mjs';

export {
  STACK_DESCRIPTORS,
  detectPackageManager,
  detectStacksFromDescriptors,
  inferStackRuntimeDefaults,
  registerStackDescriptor,
  unregisterStackDescriptor,
};

export const TEMPLATE_DIR = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa');
export const DEMO_PRESET_DIR = path.join(WORKBENCH_ROOT, 'examples', 'demo-webapp', 'qa-preset');

const SKIP_COPY_NAMES = new Set([
  'node_modules',
  'playwright-report',
  'test-results',
  'reports',
  '.aitest',
  '.env',
  '.gitignore',
]);

const FLAT_ESLINT_CONFIGS = ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.ts'];
const LEGACY_ESLINT_CONFIGS = ['.eslintrc.js', '.eslintrc.cjs', '.eslintrc.json', '.eslintrc.yml', '.eslintrc'];

/** @param {ReturnType<typeof buildStackDetectContext>} ctx @returns {boolean} */
function hasPytestConfig(ctx) {
  if (ctx.hasFile('pytest.ini') || ctx.hasFile('conftest.py')) return true;
  if (!ctx.hasFile('pyproject.toml') && !ctx.hasFile('requirements.txt')) return false;
  return /\bpytest\b/i.test(`${ctx.readText('pyproject.toml')}\n${ctx.readText('requirements.txt')}`);
}

/** @param {string} dir @returns {boolean} */
function hasDirectory(dir) {
  try {
    return Boolean(dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory());
  } catch {
    return false;
  }
}

/**
 * @param {string} repoDir
 * @returns {string[]}
 */
export function detectProjectStack(repoDir) {
  const { labels, ctx, siblingRepos } = detectStacksFromDescriptors(repoDir);
  const stacks = [...labels];
  if (ctx.deps.vitest && !stacks.includes('Vitest')) stacks.push('Vitest');
  if (ctx.deps.jest && !stacks.includes('Jest')) stacks.push('Jest');
  if (hasPytestConfig(ctx) && !stacks.includes('Pytest')) stacks.push('Pytest');
  for (const sub of siblingRepos) {
    const subCtx = buildStackDetectContext(sub);
    if (subCtx.deps.vitest && !stacks.includes('Vitest')) stacks.push('Vitest');
    if (subCtx.deps.jest && !stacks.includes('Jest')) stacks.push('Jest');
    if (hasPytestConfig(subCtx) && !stacks.includes('Pytest')) stacks.push('Pytest');
  }
  return stacks.length > 0 ? stacks : ['Generic Web'];
}

/**
 * Inspects host tooling metadata (ESLint flat & legacy configs, jsconfig, tests/, lockfiles, Vue 2/3, Maven modules, sibling repos).
 * @param {string} repoDir
 */
export function detectHostTooling(repoDir) {
  const ctx = buildStackDetectContext(repoDir);
  const lockfileNames = ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', 'package-lock.json'];
  const siblingRepos = detectSiblingRepoDirs(repoDir);
  const subContexts = siblingRepos.map((sub) => buildStackDetectContext(sub));
  const allContexts = [ctx, ...subContexts];

  const lockfile =
    lockfileNames.find((f) => ctx.hasFile(f)) ||
    subContexts.map((sc) => lockfileNames.find((f) => sc.hasFile(f)) || null).find(Boolean) ||
    null;
  const rootHasJsPm = ctx.hasFile('package.json') || lockfileNames.some((f) => ctx.hasFile(f));
  const pmFromSub = !rootHasJsPm
    ? subContexts.find((sc) => sc.hasFile('package.json') || lockfileNames.some((f) => sc.hasFile(f)))?.pm.name
    : undefined;
  const packageManager = pmFromSub || ctx.pm.name;

  const eslintConfigs = [...FLAT_ESLINT_CONFIGS, ...LEGACY_ESLINT_CONFIGS].filter((f) => ctx.hasFile(f));
  const mavenModules = allContexts
    .flatMap((c) => (c.hasFile('pom.xml') ? extractMavenModules(c.readText('pom.xml')) : []));
  const vueCtx = allContexts.find((c) => Boolean(c.deps.vue)) || null;
  const vueVersion = vueCtx ? (isVue2Project(vueCtx) ? 'vue2' : 'vue3') : null;
  const uiLibrary =
    allContexts.map((c) => (c.deps['element-ui'] ? 'element-ui' : c.deps['element-plus'] ? 'element-plus' : null)).find(Boolean) ||
    null;

  return {
    packageManager,
    lockfile,
    eslintConfigs,
    hasEslintIgnore: ctx.hasFile('.eslintignore'),
    hasTsConfig: ctx.hasFile('tsconfig.json'),
    hasJsConfig: ctx.hasFile('jsconfig.json'),
    hasExistingTestsDir: Boolean(
      (repoDir && hasDirectory(path.join(repoDir, 'tests'))) ||
        siblingRepos.some((sub) => hasDirectory(path.join(sub, 'tests')))
    ),
    vueVersion,
    uiLibrary,
    usesVueCli: allContexts.some((c) => Boolean(c.deps['@vue/cli-service'])),
    mavenModules: [...new Set(mavenModules)],
    siblingRepos: siblingRepos.map((d) => path.basename(d)),
  };
}

/**
 * Checks whether host TypeScript/JSConfig/ESLint configs or directories overlap `<repo>/<qaFolderName>/**`.
 * @param {string} repoDir
 * @param {string} [qaFolderName]
 * @returns {string[]}
 */
export function inspectHostIsolation(repoDir, qaFolderName = 'qa') {
  const advisories = [];
  for (const cfgName of ['tsconfig.json', 'jsconfig.json']) {
    const cfgPath = path.join(repoDir, cfgName);
    if (!fs.existsSync(cfgPath)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      const includesAll =
        Array.isArray(parsed.include) &&
        parsed.include.some((/** @type {string} */ p) => p === '**/*.ts' || p === '**/*.tsx' || p === '**/*.js' || p === '**/*');
      const excludesQa =
        Array.isArray(parsed.exclude) &&
        parsed.exclude.some(
          (/** @type {string} */ p) => p === qaFolderName || p.startsWith(`${qaFolderName}/`) || p.startsWith(`./${qaFolderName}`)
        );
      if ((includesAll || (cfgName === 'jsconfig.json' && !Array.isArray(parsed.include))) && !excludesQa) {
        advisories.push(
          `Host ${cfgName} scans root JS/TS files without excluding "${qaFolderName}/"; add "${qaFolderName}" to ${cfgName} exclude.`
        );
      }
    } catch {
      // ignore non-JSON config
    }
  }

  let matchedFlatEslint = false;
  for (const eslintName of FLAT_ESLINT_CONFIGS) {
    const p = path.join(repoDir, eslintName);
    if (fs.existsSync(p)) {
      matchedFlatEslint = true;
      const raw = fs.readFileSync(p, 'utf8');
      if (!raw.includes(`${qaFolderName}/`) && !raw.includes(`"${qaFolderName}"`) && !raw.includes(`'${qaFolderName}'`)) {
        advisories.push(
          `Host ${eslintName} does not mention "${qaFolderName}/" in ignores; verify root lint ignores "${qaFolderName}/**" so Playwright specs use ${qaFolderName}/eslint.config.mjs.`
        );
      }
      break;
    }
  }

  if (!matchedFlatEslint) {
    const legacyName = LEGACY_ESLINT_CONFIGS.find((f) => fs.existsSync(path.join(repoDir, f)));
    if (legacyName) {
      const eslintIgnorePath = path.join(repoDir, '.eslintignore');
      const ignoreRaw = fs.existsSync(eslintIgnorePath) ? fs.readFileSync(eslintIgnorePath, 'utf8') : '';
      const cfgRaw = fs.readFileSync(path.join(repoDir, legacyName), 'utf8');
      const hasQaIgnore =
        ignoreRaw.includes(qaFolderName) ||
        (cfgRaw.includes('ignorePatterns') && (cfgRaw.includes(`${qaFolderName}/`) || cfgRaw.includes(`"${qaFolderName}"`) || cfgRaw.includes(`'${qaFolderName}'`)));
      if (!hasQaIgnore) {
        advisories.push(
          `Host legacy ESLint config (${legacyName}) detected without "${qaFolderName}/" in .eslintignore or ignorePatterns; add "${qaFolderName}/" to .eslintignore.`
        );
      }
    }
  }

  const tooling = detectHostTooling(repoDir);
  if (tooling.hasExistingTestsDir) {
    advisories.push(`Host repository already has a root "tests/" directory; QA Playwright specs remain isolated under "${qaFolderName}/tests/".`);
  }
  if (tooling.lockfile === 'yarn.lock' || tooling.lockfile === 'pnpm-lock.yaml') {
    advisories.push(`Host uses ${tooling.packageManager} (${tooling.lockfile}); "${qaFolderName}/" keeps an isolated npm lockfile.`);
  }
  if (tooling.mavenModules.length > 0) {
    advisories.push(`Detected Maven multi-module pom.xml (${tooling.mavenModules.slice(0, 5).join(', ')}); CodeMap scans all modules automatically.`);
  }
  if (tooling.siblingRepos.length >= 2) {
    advisories.push(
      `Detected multi-repo workspace siblings (${tooling.siblingRepos.join(', ')}); configure sourceRepos or run "map --repo ..." for full-stack linking.`
    );
  }

  return advisories;
}

/**
 * @param {string} repoDir
 * @returns {Promise<{ isGit: boolean, dirtyFiles: string[] }>}
 */
export async function inspectGitStatus(repoDir) {
  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    return { isGit: false, dirtyFiles: [] };
  }
  try {
    const res = await runProcess('git', ['status', '--porcelain'], { cwd: repoDir, timeoutMs: 5000 });
    if (res.code !== 0) return { isGit: true, dirtyFiles: [] };
    const dirtyFiles = res.stdout.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean);
    return { isGit: true, dirtyFiles };
  } catch {
    return { isGit: true, dirtyFiles: [] };
  }
}

/**
 * @param {string} dir
 * @param {string} [base]
 * @param {{ mapGitignore?: boolean }} [options]
 * @returns {Array<{ src: string, srcRel: string, rel: string }>}
 */
export function collectFilesRecursive(dir, base = dir, { mapGitignore = false } = {}) {
  /** @type {Array<{ src: string, srcRel: string, rel: string }>} */
  const entries = [];
  if (!fs.existsSync(dir)) return entries;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_COPY_NAMES.has(item.name)) continue;
    const full = path.join(dir, item.name);
    const srcRel = path.relative(base, full).replace(/\\/g, '/');
    if (item.isDirectory()) {
      entries.push(...collectFilesRecursive(full, base, { mapGitignore }));
    } else if (item.isFile()) {
      const destRel = mapGitignore && srcRel === 'gitignore' ? '.gitignore' : srcRel;
      entries.push({ src: full, srcRel, rel: destRel });
    }
  }
  return entries;
}

/**
 * @param {string} existing
 * @param {string} templateContent
 * @returns {{ changed: boolean, content: string }}
 */
export function mergeGitignoreContent(existing, templateContent) {
  const existingLines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const additions = templateContent.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !existingLines.has(l));
  if (additions.length === 0) return { changed: false, content: existing };
  return { changed: true, content: `${existing.trimEnd()}\n\n# Added by ai-test-workbench\n${additions.join('\n')}\n` };
}

/** @param {string} projectName */
function toSafePackageName(projectName) {
  const slug = String(projectName || 'project').toLowerCase().replace(/[^a-z0-9-_]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
  return `${slug || 'project'}-qa`;
}

/**
 * @param {string} raw
 * @param {string} projectName
 * @param {string} relPath
 * @param {string} [preset]
 * @returns {string}
 */
export function renderContent(raw, projectName, relPath, preset = 'generic') {
  const pkgName = toSafePackageName(projectName);
  if (relPath === 'package.json') {
    try {
      const parsed = JSON.parse(raw);
      parsed.name = pkgName;
      return JSON.stringify(parsed, null, 2) + '\n';
    } catch {
      return raw.replace('"ai-test-workbench-qa"', `"${pkgName}"`);
    }
  }
  if (relPath === 'package-lock.json') {
    try {
      const parsed = JSON.parse(raw);
      parsed.name = pkgName;
      if (parsed.packages && parsed.packages['']) parsed.packages[''].name = pkgName;
      return JSON.stringify(parsed, null, 2) + '\n';
    } catch {
      return raw;
    }
  }
  let out = raw.replaceAll('__PROJECT_NAME__', projectName);
  if (preset === 'demo-campus' && relPath === '.env.example') {
    out = out.replace('E2E_USERNAME=', 'E2E_USERNAME=student_qa_0').replace('E2E_PASSWORD=', 'E2E_PASSWORD=qa-pass-123');
  }
  return out;
}

/**
 * @param {string} targetRoot
 * @param {string} qaFolderName
 * @param {{ dryRun?: boolean, force?: boolean }} [options]
 * @returns {{ status: string, file: string, sidecar?: string }}
 */
export function applyRootMcpBridge(targetRoot, qaFolderName, { dryRun = false, force = false } = {}) {
  const rootMcpPath = path.join(targetRoot, '.mcp.json');
  const cliRel = `${qaFolderName}/node_modules/@playwright/test/cli.js`;
  const cfgRel = `${qaFolderName}/playwright.config.ts`;
  const bridgeServer = { command: 'node', args: [cliRel, 'run-test-mcp-server', '--config', cfgRel] };

  if (!fs.existsSync(rootMcpPath)) {
    const content = JSON.stringify({ mcpServers: { 'playwright-test': bridgeServer } }, null, 2) + '\n';
    if (!dryRun) fs.writeFileSync(rootMcpPath, content, 'utf8');
    return { status: 'CREATED', file: '.mcp.json' };
  }
  try {
    const existing = JSON.parse(fs.readFileSync(rootMcpPath, 'utf8'));
    existing.mcpServers = existing.mcpServers || {};
    if (existing.mcpServers['playwright-test'] && JSON.stringify(existing.mcpServers['playwright-test']) !== JSON.stringify(bridgeServer) && !force) {
      const sidecar = `${rootMcpPath}.aitest-new`;
      const incoming = { ...existing, mcpServers: { ...existing.mcpServers, 'playwright-test': bridgeServer } };
      if (!dryRun) fs.writeFileSync(sidecar, JSON.stringify(incoming, null, 2) + '\n', 'utf8');
      return { status: 'CONFLICT', file: '.mcp.json', sidecar: '.mcp.json.aitest-new' };
    }
    existing.mcpServers['playwright-test'] = bridgeServer;
    if (!dryRun) fs.writeFileSync(rootMcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    return { status: 'MERGED', file: '.mcp.json' };
  } catch {
    return { status: 'CONFLICT_INVALID_JSON', file: '.mcp.json' };
  }
}
