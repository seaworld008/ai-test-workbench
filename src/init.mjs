// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectBrowserCache } from './doctor.mjs';
import { ensureInitialGovernanceLock } from './governance.mjs';
import { runNpm, runPlaywright, runProcess } from './proc.mjs';
import { syncOfficialAgents } from './agents.mjs';
import { WORKBENCH_VERSION } from './version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..');
const TEMPLATE_DIR = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa');
const DEMO_PRESET_DIR = path.join(WORKBENCH_ROOT, 'examples', 'demo-webapp', 'qa-preset');

const SKIP_COPY_NAMES = new Set([
  'node_modules',
  'playwright-report',
  'test-results',
  'reports',
  '.aitest',
  '.env',
  '.gitignore',
]);

export function detectProjectStack(repoDir) {
  const stacks = [];
  const pkgPath = path.join(repoDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
      if (deps.next) stacks.push('Next.js');
      else if (deps.nuxt) stacks.push('Nuxt');
      else if (deps.vue) stacks.push('Vue/H5');
      else if (deps.react) stacks.push('React');
      else stacks.push('Node.js');
      if (deps.vitest) stacks.push('Vitest');
      if (deps.jest) stacks.push('Jest');
    } catch {
      stacks.push('Node.js');
    }
  }
  if (
    fs.existsSync(path.join(repoDir, 'pom.xml')) ||
    fs.existsSync(path.join(repoDir, 'build.gradle')) ||
    fs.existsSync(path.join(repoDir, 'build.gradle.kts'))
  ) {
    stacks.push('Java/Spring');
  }
  if (fs.existsSync(path.join(repoDir, 'composer.json')) || fs.existsSync(path.join(repoDir, 'think'))) {
    stacks.push('PHP/ThinkPHP');
  }
  if (fs.existsSync(path.join(repoDir, 'go.mod'))) stacks.push('Go');
  if (fs.existsSync(path.join(repoDir, 'pyproject.toml')) || fs.existsSync(path.join(repoDir, 'requirements.txt'))) {
    stacks.push('Python');
  }
  return stacks.length > 0 ? stacks : ['Generic Web'];
}

/**
 * Checks whether the host repository's root TypeScript/ESLint/Vitest/Jest configurations
 * would accidentally pick up `<repo>/<qaFolderName>/**` files and advises isolation excludes.
 */
export function inspectHostIsolation(repoDir, qaFolderName = 'qa') {
  const advisories = [];
  const tsconfigPath = path.join(repoDir, 'tsconfig.json');
  if (fs.existsSync(tsconfigPath)) {
    try {
      const raw = fs.readFileSync(tsconfigPath, 'utf8');
      const parsed = JSON.parse(raw);
      const includesAllTs = Array.isArray(parsed.include) && parsed.include.some((p) => p === '**/*.ts' || p === '**/*.tsx');
      const excludesQa =
        Array.isArray(parsed.exclude) &&
        parsed.exclude.some((p) => p === qaFolderName || p.startsWith(`${qaFolderName}/`) || p.startsWith(`./${qaFolderName}`));
      if (includesAllTs && !excludesQa) {
        advisories.push(
          `Host tsconfig.json matches "**/*.ts" without excluding "${qaFolderName}/"; add "${qaFolderName}" to root tsconfig exclude if host typecheck scans it.`
        );
      }
    } catch {
      // ignore non-JSON tsconfig with comments
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

async function inspectGitStatus(repoDir) {
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

function collectFilesRecursive(dir, base = dir, { mapGitignore = false } = {}) {
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

function mergeGitignoreContent(existing, templateContent) {
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

function toSafePackageName(projectName) {
  const slug = String(projectName || 'project')
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `${slug || 'project'}-qa`;
}

function renderContent(raw, projectName, relPath, preset = 'generic') {
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

function applyRootMcpBridge(targetRoot, qaFolderName, { dryRun = false, force = false } = {}) {
  const rootMcpPath = path.join(targetRoot, '.mcp.json');
  const cliRel = `${qaFolderName}/node_modules/@playwright/test/cli.js`;
  const cfgRel = `${qaFolderName}/playwright.config.ts`;
  const bridgeServer = {
    command: 'node',
    args: [cliRel, 'run-test-mcp-server', '--config', cfgRel],
  };

  if (!fs.existsSync(rootMcpPath)) {
    const content = JSON.stringify({ mcpServers: { 'playwright-test': bridgeServer } }, null, 2) + '\n';
    if (!dryRun) {
      fs.writeFileSync(rootMcpPath, content, 'utf8');
    }
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
      if (!dryRun) {
        fs.writeFileSync(sidecar, JSON.stringify(incoming, null, 2) + '\n', 'utf8');
      }
      return { status: 'CONFLICT', file: '.mcp.json', sidecar: '.mcp.json.aitest-new' };
    }
    existing.mcpServers['playwright-test'] = bridgeServer;
    if (!dryRun) {
      fs.writeFileSync(rootMcpPath, JSON.stringify(existing, null, 2) + '\n', 'utf8');
    }
    return { status: 'MERGED', file: '.mcp.json' };
  } catch {
    return { status: 'CONFLICT_INVALID_JSON', file: '.mcp.json' };
  }
}

export async function runInit(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    console.error(lang === 'zh' ? '缺少必填参数 --target <业务仓库路径>' : 'Missing required --target <repo-path>');
    return 1;
  }

  if (!fs.existsSync(TEMPLATE_DIR)) {
    console.error(`Template directory missing: ${TEMPLATE_DIR}`);
    return 1;
  }

  const preset = (options.preset || 'generic').toLowerCase();
  if (!['generic', 'demo-campus'].includes(preset)) {
    console.error(`Unsupported --preset "${preset}". Allowed: generic, demo-campus`);
    return 1;
  }

  const qaFolderName = options.qaDir || 'qa';
  const dryRun = Boolean(options.dryRun);
  const skipInstall = Boolean(options.skipInstall);
  const skipBrowser = Boolean(options.skipBrowser);
  const bridgeRoot = Boolean(options.bridgeRoot);
  const force = Boolean(options.force);
  const projectName = options.name || path.basename(target);
  const loops = (options.loop || 'codex')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'none');

  const rootPwTs = path.join(target, 'playwright.config.ts');
  const rootPwJs = path.join(target, 'playwright.config.js');
  if (fs.existsSync(rootPwTs) || fs.existsSync(rootPwJs)) {
    console.error(
      lang === 'zh'
        ? `检测到目标仓库根目录已存在 Playwright 配置 (${fs.existsSync(rootPwTs) ? rootPwTs : rootPwJs})。为保护现有工程，请复用现有配置或通过 --qa-dir 指定独立子目录。`
        : `Existing Playwright config detected at target root. Reuse it or specify an explicit --qa-dir.`
    );
    return 2;
  }

  const qaDir = path.join(target, qaFolderName);
  if (fs.existsSync(qaDir)) {
    const existingEntries = fs.readdirSync(qaDir);
    const looksLikePlaywright =
      fs.existsSync(path.join(qaDir, 'playwright.config.ts')) ||
      fs.existsSync(path.join(qaDir, 'playwright.config.js')) ||
      (fs.existsSync(path.join(qaDir, 'package.json')) &&
        fs.readFileSync(path.join(qaDir, 'package.json'), 'utf8').includes('@playwright/test'));

    if (existingEntries.length > 0 && !looksLikePlaywright) {
      console.error(
        lang === 'zh'
          ? `冲突阻断：目标目录 ${qaDir} 已存在且包含非 Playwright 文件 (${existingEntries.slice(0, 5).join(', ')})。请先检查或改用 --qa-dir e2e-qa。`
          : `Conflict: ${qaDir} already exists with non-Playwright files. Use --qa-dir <other-dir> instead.`
      );
      return 2;
    }
  }

  const stacks = fs.existsSync(target) ? detectProjectStack(target) : ['New Project'];
  const gitInfo = fs.existsSync(target) ? await inspectGitStatus(target) : { isGit: false, dirtyFiles: [] };
  const hostAdvisories = fs.existsSync(target) ? inspectHostIsolation(target, qaFolderName) : [];

  console.log(`\n=== ${lang === 'zh' ? '初始化 AI 测试工作台' : 'Initialize AI Test Workbench'}${dryRun ? ' [DRY-RUN]' : ''} ===`);
  console.log(`${lang === 'zh' ? '项目名称' : 'Project'}: ${projectName}`);
  console.log(`${lang === 'zh' ? '目标仓库' : 'Target Repo'}: ${target}`);
  console.log(`${lang === 'zh' ? 'QA 子目录' : 'QA Directory'}: ${qaDir}`);
  console.log(`${lang === 'zh' ? '预设模板' : 'Preset'}: ${preset}`);
  console.log(`${lang === 'zh' ? '识别技术栈' : 'Detected Stack'}: ${stacks.join(', ')}`);
  if (gitInfo.isGit && gitInfo.dirtyFiles.length > 0) {
    console.log(
      `[WARN] ${lang === 'zh' ? '目标仓库存在未提交 Git 改动（不会覆盖已有文件）' : 'Target has uncommitted git changes (existing files protected)'}: ${gitInfo.dirtyFiles.length} file(s)`
    );
  }
  for (const adv of hostAdvisories) {
    console.log(`[HOST-ISOLATION] ${adv}`);
  }

  const templateFiles = collectFilesRecursive(TEMPLATE_DIR, TEMPLATE_DIR, { mapGitignore: true });
  if (preset === 'demo-campus' && fs.existsSync(DEMO_PRESET_DIR)) {
    const presetFiles = collectFilesRecursive(DEMO_PRESET_DIR, DEMO_PRESET_DIR);
    templateFiles.push(...presetFiles);
  }

  const plan = [];

  for (const item of templateFiles) {
    const dest = path.join(qaDir, item.rel);
    const raw = fs.readFileSync(item.src, 'utf8');
    const rendered = renderContent(raw, projectName, item.rel, preset);

    if (!fs.existsSync(dest)) {
      plan.push({ action: 'CREATE', rel: item.rel, dest, content: rendered });
    } else if (item.rel === '.gitignore') {
      const existing = fs.readFileSync(dest, 'utf8');
      const merged = mergeGitignoreContent(existing, rendered);
      plan.push({
        action: merged.changed ? 'MERGE_GITIGNORE' : 'KEEP',
        rel: item.rel,
        dest,
        content: merged.content,
      });
    } else {
      const existing = fs.readFileSync(dest, 'utf8');
      plan.push({
        action: existing === rendered ? 'KEEP' : 'PRESERVE_CUSTOM',
        rel: item.rel,
        dest,
        content: existing,
      });
    }
  }

  for (const step of plan) {
    console.log(`  [${step.action}] ${path.join(qaFolderName, step.rel)}`);
  }

  if (bridgeRoot) {
    const preview = applyRootMcpBridge(target, qaFolderName, { dryRun: true, force });
    console.log(`  [BRIDGE_ROOT:${preview.status}] ${preview.file}`);
  }

  if (dryRun) {
    console.log(
      `\n[DRY-RUN] ${lang === 'zh' ? '未写入磁盘。正式执行请去掉 --dry-run。' : 'No files written. Re-run without --dry-run to apply.'}`
    );
    return 0;
  }

  fs.mkdirSync(qaDir, { recursive: true });
  for (const step of plan) {
    if (step.action === 'CREATE' || step.action === 'MERGE_GITIGNORE') {
      fs.mkdirSync(path.dirname(step.dest), { recursive: true });
      fs.writeFileSync(step.dest, step.content, 'utf8');
    }
  }

  // Create initial .aitest/governance.lock ONLY if not already present (never overwrites existing human lock!)
  ensureInitialGovernanceLock(qaDir);

  if (bridgeRoot) {
    applyRootMcpBridge(target, qaFolderName, { dryRun: false, force });
  }

  const hasLock = fs.existsSync(path.join(qaDir, 'package-lock.json'));
  const hasNodeModules = fs.existsSync(path.join(qaDir, 'node_modules', '@playwright', 'test', 'cli.js'));

  if (!skipInstall && !hasNodeModules) {
    const npmArgs = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    console.log(`\n${lang === 'zh' ? '正在独立安装 QA 依赖' : 'Installing isolated QA dependencies'}: npm ${npmArgs.join(' ')} ...`);
    const npmRes = await runNpm(npmArgs, { cwd: qaDir, inheritStdio: true });
    if (npmRes.code !== 0) {
      console.error(lang === 'zh' ? 'QA 依赖安装失败。' : 'Failed to install QA dependencies.');
      return npmRes.code || 1;
    }
  } else if (skipInstall) {
    console.log(`\n[SKIP] ${lang === 'zh' ? '按 --skip-install 跳过 npm 依赖安装。' : 'Skipped npm install per --skip-install.'}`);
  } else {
    console.log(`\n[OK] ${lang === 'zh' ? '检测到已有 @playwright/test 依赖，保持幂等。' : 'Existing @playwright/test dependency preserved.'}`);
  }

  const pwReady = fs.existsSync(path.join(qaDir, 'node_modules', '@playwright', 'test', 'cli.js'));

  if (pwReady && !skipInstall && !skipBrowser) {
    const cacheInfo = inspectBrowserCache();
    console.log(
      `\n${lang === 'zh' ? '校验/安装 Chromium 浏览器' : 'Verifying/installing Chromium browser'} (cache: ${cacheInfo.dir || 'default'})...`
    );
    const brRes = await runPlaywright(qaDir, ['install', 'chromium'], { inheritStdio: true });
    if (brRes.code !== 0) {
      console.error(lang === 'zh' ? 'Chromium 安装失败。' : 'Chromium installation failed.');
      return brRes.code || 1;
    }
  }

  if (loops.length > 0 && pwReady) {
    console.log(`\n${lang === 'zh' ? '初始化官方 Playwright Test Agents' : 'Initializing official Playwright Test Agents'}: ${loops.join(', ')}`);
    const { results } = await syncOfficialAgents(qaDir, {
      loops,
      dryRun: false,
      force,
      lang,
      preserveSeed: true,
    });
    for (const r of results) {
      console.log(`  Loop "${r.loop}":`);
      for (const act of r.actions) {
        console.log(`    [${act.status}] ${act.file}${act.sidecar ? ` -> ${act.sidecar}` : ''}`);
      }
    }
  }

  console.log(`\n${lang === 'zh' ? '推荐下一步（默认在 qa/ 目录启动 Agent）' : 'Next steps (start coding agent inside qa/ by default)'}:`);
  console.log(`  1) npx ai-test-workbench@${WORKBENCH_VERSION} run --target "${target}" --suite smoke --audit`);
  console.log(`  2) cd "${qaDir}" && codex`);
  return 0;
}
