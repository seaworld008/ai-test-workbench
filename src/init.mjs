// @ts-check
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { syncOfficialAgents } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { runNpm, runPlaywright } from './core/proc.mjs';
import { WORKBENCH_VERSION } from './core/version.mjs';
import { inspectBrowserCache } from './doctor.mjs';
import { ensureInitialGovernanceLock, hasWorkspaceGovernanceTrace } from './governance.mjs';
import {
  computeProtectedFileHashes,
  isProtectedDiffPath,
  openTrustContext,
  resolveDefaultDiffBase,
  resolveGitHeadSha,
  writeSignedBaselineRef,
} from './kernel/gate-kernel.mjs';
import { writeTemplateManifest } from './upgrade.mjs';
import {
  DEMO_PRESET_DIR,
  STACK_DESCRIPTORS,
  TEMPLATE_DIR,
  applyRootMcpBridge,
  collectFilesRecursive,
  detectHostTooling,
  detectPackageManager,
  detectProjectStack,
  detectStacksFromDescriptors,
  inferStackRuntimeDefaults,
  inspectGitStatus,
  inspectHostIsolation,
  mergeGitignoreContent,
  registerStackDescriptor,
  renderContent,
  unregisterStackDescriptor,
} from './init/planner.mjs';

export {
  STACK_DESCRIPTORS,
  detectHostTooling,
  detectPackageManager,
  detectProjectStack,
  detectStacksFromDescriptors,
  inferStackRuntimeDefaults,
  inspectHostIsolation,
  registerStackDescriptor,
  unregisterStackDescriptor,
};

/**
 * @param {{
 *   lang?: 'zh' | 'en' | string,
 *   json?: boolean,
 *   target?: string,
 *   preset?: string,
 *   qaDir?: string,
 *   dryRun?: boolean,
 *   skipInstall?: boolean,
 *   skipBrowser?: boolean,
 *   bridgeRoot?: boolean,
 *   force?: boolean,
 *   name?: string,
 *   loop?: string,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runInit(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /**
   * @param {number} exitCode
   * @param {string} message
   * @returns {number}
   */
  const emitJsonError = (exitCode, message) => {
    if (!asJson) {
      console.error(message);
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'init',
        outcome: exitCode === 2 ? 'blocked' : 'fail',
        ok: false,
        exitCode,
        summary: message,
        data: { error: message },
      }),
      { asJson }
    );
  };
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    return emitJsonError(
      1,
      lang === 'zh' ? '缺少必填参数 --target <业务仓库路径>' : 'Missing required --target <repo-path>'
    );
  }

  if (!fs.existsSync(TEMPLATE_DIR)) {
    return emitJsonError(1, `Template directory missing: ${TEMPLATE_DIR}`);
  }

  const preset = (options.preset || 'generic').toLowerCase();
  if (!['generic', 'demo-campus'].includes(preset)) {
    return emitJsonError(1, `Unsupported --preset "${preset}". Allowed: generic, demo-campus`);
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
    return emitJsonError(
      2,
      lang === 'zh'
        ? `检测到目标仓库根目录已存在 Playwright 配置 (${fs.existsSync(rootPwTs) ? rootPwTs : rootPwJs})。为保护现有工程，请复用现有配置或通过 --qa-dir 指定独立子目录。`
        : `Existing Playwright config detected at target root. Reuse it or specify an explicit --qa-dir.`
    );
  }

  const qaDir = path.join(target, qaFolderName);
  if (fs.existsSync(qaDir)) {
    const existingEntries = fs.readdirSync(qaDir);
    const looksLikePlaywright =
      fs.existsSync(path.join(qaDir, 'playwright.config.ts')) ||
      fs.existsSync(path.join(qaDir, 'playwright.config.js')) ||
      (fs.existsSync(path.join(qaDir, 'package.json')) &&
        fs.readFileSync(path.join(qaDir, 'package.json'), 'utf8').includes('@playwright/test'));

    const nonLockEntries = existingEntries.filter((e) => e !== '.aitest');
    if (nonLockEntries.length > 0 && !looksLikePlaywright) {
      return emitJsonError(
        2,
        lang === 'zh'
          ? `冲突阻断：目标目录 ${qaDir} 已存在且包含非 Playwright 文件 (${nonLockEntries.slice(0, 5).join(', ')})。请先检查或改用 --qa-dir e2e-qa。`
          : `Conflict: ${qaDir} already exists with non-Playwright files. Use --qa-dir <other-dir> instead.`
      );
    }
  }

  const stacks = fs.existsSync(target) ? detectProjectStack(target) : ['New Project'];
  const gitInfo = fs.existsSync(target) ? await inspectGitStatus(target) : { isGit: false, dirtyFiles: [] };
  const hostAdvisories = fs.existsSync(target) ? inspectHostIsolation(target, qaFolderName) : [];

  if (!asJson) {
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
  }

  const templateByRel = new Map(
    collectFilesRecursive(TEMPLATE_DIR, TEMPLATE_DIR, { mapGitignore: true }).map((item) => [item.rel, item])
  );
  if (preset === 'demo-campus' && fs.existsSync(DEMO_PRESET_DIR)) {
    for (const presetItem of collectFilesRecursive(DEMO_PRESET_DIR, DEMO_PRESET_DIR)) {
      templateByRel.set(presetItem.rel, presetItem);
    }
  }
  const templateFiles = [...templateByRel.values()];

  const plan = [];

  for (const item of templateFiles) {
    const dest = path.join(qaDir, item.rel);
    const raw = fs.readFileSync(item.src, 'utf8');
    const rendered = renderContent(raw, projectName, item.rel, preset);

    if (!fs.existsSync(dest)) {
      plan.push({ action: 'CREATE', rel: item.rel, dest, content: rendered, factoryContent: rendered });
    } else if (item.rel === '.gitignore') {
      const existing = fs.readFileSync(dest, 'utf8');
      const merged = mergeGitignoreContent(existing, rendered);
      plan.push({
        action: merged.changed ? 'MERGE_GITIGNORE' : 'KEEP',
        rel: item.rel,
        dest,
        content: merged.content,
        factoryContent: rendered,
      });
    } else {
      const existing = fs.readFileSync(dest, 'utf8');
      plan.push({
        action: existing === rendered ? 'KEEP' : 'PRESERVE_CUSTOM',
        rel: item.rel,
        dest,
        content: existing,
        factoryContent: rendered,
      });
    }
  }

  if (!asJson) {
    for (const step of plan) {
      console.log(`  [${step.action}] ${path.join(qaFolderName, step.rel)}`);
    }
  }

  let bridgePreview = null;
  if (bridgeRoot) {
    bridgePreview = applyRootMcpBridge(target, qaFolderName, { dryRun: true, force });
    if (!asJson) {
      console.log(`  [BRIDGE_ROOT:${bridgePreview.status}] ${bridgePreview.file}`);
    }
  }

  if (dryRun) {
    const dryPayload = {
      dryRun: true,
      projectName,
      target,
      qaDir,
      preset,
      stacks,
      hostAdvisories,
      bridgeRoot: bridgePreview,
      plan: plan.map((s) => ({ action: s.action, file: s.rel })),
    };
    if (!asJson) {
      console.log(
        `\n[DRY-RUN] ${lang === 'zh' ? '未写入磁盘。正式执行请去掉 --dry-run。' : 'No files written. Re-run without --dry-run to apply.'}`
      );
    }
    return emitCommandResult(
      buildCommandResult({
        tool: 'init',
        outcome: 'pass',
        ok: true,
        exitCode: 0,
        summary: `Dry-run init planned ${plan.length} file(s) in ${qaDir}`,
        data: dryPayload,
      }),
      { asJson }
    );
  }

  fs.mkdirSync(qaDir, { recursive: true });
  for (const step of plan) {
    if (step.action === 'CREATE' || step.action === 'MERGE_GITIGNORE') {
      fs.mkdirSync(path.dirname(step.dest), { recursive: true });
      fs.writeFileSync(step.dest, step.content, 'utf8');
    }
  }

  // Compute pristine factory protected file hashes BEFORE creating/verifying initial lock (`WU-01`)
  /** @type {Record<string, string>} */
  const factoryProtectedHashes = {};
  for (const step of plan) {
    if (isProtectedDiffPath(step.rel)) {
      const normalized = String(step.factoryContent || '').replace(/\r\n/g, '\n');
      factoryProtectedHashes[step.rel] = `sha256:${crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')}`;
    }
  }

  // Record per-file template SHA-256 manifest only if lock is absent cleanly (no history, factory-intact)
  const existingLockPath = path.join(qaDir, '.aitest', 'governance.lock');
  const trustContext = openTrustContext({ qaDir, repoDir: target, createKeyIfMissing: true });
  if (!fs.existsSync(existingLockPath)) {
    if (hasWorkspaceGovernanceTrace(qaDir)) {
      return emitJsonError(
        2,
        '[Governance Tamper Blocked] Refusing to auto-issue aitest-init governance.lock in a workspace with prior governance/run/heal history. A human must run "governance approve".'
      );
    }
    const currentHashes = computeProtectedFileHashes(qaDir);
    const mismatched = Object.keys(currentHashes).filter((rel) => currentHashes[rel] !== factoryProtectedHashes[rel]);
    if (mismatched.length > 0) {
      return emitJsonError(
        2,
        `[Governance Tamper Blocked] Protected file(s) [${mismatched.sort().join(', ')}] do not match factory template hashes; refusing aitest-init lock auto-signing.`
      );
    }
    writeTemplateManifest(qaDir, plan.map((s) => s.rel));
    const initLock = ensureInitialGovernanceLock(qaDir, { trustContext, factoryProtectedHashes });
    if (initLock.blocked) {
      return emitJsonError(2, initLock.error || '[Governance Tamper Blocked] Failed to seal initial governance lock.');
    }
  } else {
    const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
    if (!fs.existsSync(manifestPath)) {
      writeTemplateManifest(qaDir, plan.map((s) => s.rel));
    }
  }

  // Record HMAC-signed `.aitest/baseline-ref` when inside a Git repository (`WU-04`, hardened v6.2.1)
  const baselineRefPath = path.join(qaDir, '.aitest', 'baseline-ref');
  if (gitInfo.isGit && !fs.existsSync(baselineRefPath)) {
    const baseInfo = resolveDefaultDiffBase(target);
    const baselineSha = baseInfo.sha || resolveGitHeadSha(target);
    if (baselineSha && baselineSha !== 'nogit') {
      writeSignedBaselineRef(qaDir, {
        baselineRef: baselineSha,
        strategy: baseInfo.strategy,
        repoDir: target,
        trustContext,
      });
    }
  }

  if (bridgeRoot) {
    applyRootMcpBridge(target, qaFolderName, { dryRun: false, force });
  }

  const hasLock = fs.existsSync(path.join(qaDir, 'package-lock.json'));
  const hasNodeModules = fs.existsSync(path.join(qaDir, 'node_modules', '@playwright', 'test', 'cli.js'));

  if (!skipInstall && !hasNodeModules) {
    const npmArgs = hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'];
    if (!asJson) {
      console.log(`\n${lang === 'zh' ? '正在独立安装 QA 依赖' : 'Installing isolated QA dependencies'}: npm ${npmArgs.join(' ')} ...`);
    }
    const npmRes = await runNpm(npmArgs, { cwd: qaDir, inheritStdio: !asJson });
    if (npmRes.code !== 0) {
      return emitJsonError(npmRes.code || 1, lang === 'zh' ? 'QA 依赖安装失败。' : 'Failed to install QA dependencies.');
    }
  } else if (skipInstall) {
    if (!asJson) {
      console.log(`\n[SKIP] ${lang === 'zh' ? '按 --skip-install 跳过 npm 依赖安装。' : 'Skipped npm install per --skip-install.'}`);
    }
  } else if (!asJson) {
    console.log(`\n[OK] ${lang === 'zh' ? '检测到已有 @playwright/test 依赖，保持幂等。' : 'Existing @playwright/test dependency preserved.'}`);
  }

  const pwReady = fs.existsSync(path.join(qaDir, 'node_modules', '@playwright', 'test', 'cli.js'));

  if (pwReady && !skipInstall && !skipBrowser) {
    const cacheInfo = inspectBrowserCache();
    if (!asJson) {
      console.log(
        `\n${lang === 'zh' ? '校验/安装 Chromium 浏览器' : 'Verifying/installing Chromium browser'} (cache: ${cacheInfo.dir || 'default'})...`
      );
    }
    const brRes = await runPlaywright(qaDir, ['install', 'chromium'], { inheritStdio: !asJson });
    if (brRes.code !== 0) {
      return emitJsonError(brRes.code || 1, lang === 'zh' ? 'Chromium 安装失败。' : 'Chromium installation failed.');
    }
  }

  let agentSyncResults = null;
  if (loops.length > 0 && pwReady) {
    if (!asJson) {
      console.log(`\n${lang === 'zh' ? '初始化官方 Playwright Test Agents' : 'Initializing official Playwright Test Agents'}: ${loops.join(', ')}`);
    }
    const { results } = await syncOfficialAgents(qaDir, {
      loops,
      dryRun: false,
      force,
      lang,
      preserveSeed: true,
    });
    agentSyncResults = results;
    if (!asJson) {
      for (const r of results) {
        console.log(`  Loop "${r.loop}":`);
        for (const act of r.actions) {
          console.log(`    [${act.status}] ${act.file}${act.sidecar ? ` -> ${act.sidecar}` : ''}`);
        }
      }
    }
  }

  if (!asJson) {
    console.log(`\n${lang === 'zh' ? '推荐下一步（默认在 qa/ 目录启动 Agent）' : 'Next steps (start coding agent inside qa/ by default)'}:`);
    console.log(`  1) npx ai-test-workbench@${WORKBENCH_VERSION} run --target "${target}" --suite smoke --audit`);
    console.log(`  2) cd "${qaDir}" && codex`);
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'init',
      outcome: 'pass',
      ok: true,
      exitCode: 0,
      summary: `Initialized QA workspace (${qaDir}, preset=${preset}, ${plan.length} file(s))`,
      data: {
        dryRun: false,
        projectName,
        target,
        qaDir,
        preset,
        stacks,
        hostAdvisories,
        bridgeRoot: bridgePreview,
        plan: plan.map((s) => ({ action: s.action, file: s.rel })),
        agentsSynced: agentSyncResults,
      },
    }),
    { asJson }
  );
}
