// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { runProcess } from '../core/proc.mjs';
import { REPO_ROOT as WORKBENCH_ROOT } from '../core/version.mjs';
import {
  STACK_DESCRIPTORS,
  detectPackageManager,
  detectStacksFromDescriptors,
  inferStackRuntimeDefaults,
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

/**
 * @param {string} repoDir
 * @returns {string[]}
 */
export function detectProjectStack(repoDir) {
  const { labels, ctx } = detectStacksFromDescriptors(repoDir);
  const stacks = [...labels];
  if (ctx.deps.vitest && !stacks.includes('Vitest')) stacks.push('Vitest');
  if (ctx.deps.jest && !stacks.includes('Jest')) stacks.push('Jest');
  return stacks.length > 0 ? stacks : ['Generic Web'];
}

/**
 * Checks whether host TypeScript/ESLint configs would scan `<repo>/<qaFolderName>/**`.
 * @param {string} repoDir
 * @param {string} [qaFolderName]
 * @returns {string[]}
 */
export function inspectHostIsolation(repoDir, qaFolderName = 'qa') {
  const advisories = [];
  const tsconfigPath = path.join(repoDir, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    try {
      const raw = fs.readFileSync(tsconfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const includesAllTs =
        Array.isArray(parsed.include) &&
        parsed.include.some((/** @type {string} */ p) => p === '**/*.ts' || p === '**/*.tsx');
      const excludesQa =
        Array.isArray(parsed.exclude) &&
        parsed.exclude.some(
          (/** @type {string} */ p) =>
            p === qaFolderName || p.startsWith(`${qaFolderName}/`) || p.startsWith(`./${qaFolderName}`)
        );
      if (includesAllTs && !excludesQa) {
        advisories.push(
          `Host tsconfig.json matches "**/*.ts" without excluding "${qaFolderName}/"; add "${qaFolderName}" to root tsconfig exclude if host typecheck scans it.`
        );
      }
    } catch {
      // ignore non-JSON tsconfig
    }
  }

  for (const eslintName of ['eslint.config.mjs', 'eslint.config.js', 'eslint.config.ts']) {
    const p = path.join(repoDir, eslintName);
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf8');
      if (!raw.includes(`${qaFolderName}/`) && !raw.includes(`"${qaFolderName}"`) && !raw.includes(`'${qaFolderName}'`)) {
        advisories.push(
          `Host ${eslintName} does not mention "${qaFolderName}/" in ignores; verify root lint ignores "${qaFolderName}/**" so Playwright specs use ${qaFolderName}/eslint.config.mjs.`
        );
      }
      break;
    }
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
    const dirtyFiles = res.stdout
      .split(/\r?\n/)
      .map((l) => l.trimEnd())
      .filter(Boolean);
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
  const additions = templateContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && !existingLines.has(l));
  if (additions.length === 0) return { changed: false, content: existing };
  return {
    changed: true,
    content: `${existing.trimEnd()}\n\n# Added by ai-test-workbench\n${additions.join('\n')}\n`,
  };
}

/** @param {string} projectName */
function toSafePackageName(projectName) {
  const slug = String(projectName || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
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
      if (parsed.packages && parsed.packages['']) {
        parsed.packages[''].name = pkgName;
      }
      return JSON.stringify(parsed, null, 2) + '\n';
    } catch {
      return raw;
    }
  }

  let out = raw.replaceAll('__PROJECT_NAME__', projectName);
  if (preset === 'demo-campus' && relPath === '.env.example') {
    out = out
      .replace('E2E_USERNAME=', 'E2E_USERNAME=student_qa_0')
      .replace('E2E_PASSWORD=', 'E2E_PASSWORD=qa-pass-123');
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
  const bridgeServer = {
    command: 'node',
    args: [cliRel, 'run-test-mcp-server', '--config', cfgRel],
  };

  if (!fs.existsSync(rootMcpPath)) {
    const content = JSON.stringify({ mcpServers: { 'playwright-test': bridgeServer } }, null, 2) + '\n';
    if (!dryRun) fs.writeFileSync(rootMcpPath, content, 'utf8');
    return { status: 'CREATED', file: '.mcp.json' };
  }

  try {
    const existing = JSON.parse(fs.readFileSync(rootMcpPath, 'utf8'));
    existing.mcpServers = existing.mcpServers || {};
    if (
      existing.mcpServers['playwright-test'] &&
      JSON.stringify(existing.mcpServers['playwright-test']) !== JSON.stringify(bridgeServer) &&
      !force
    ) {
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
