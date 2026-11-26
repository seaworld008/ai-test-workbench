// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  hasSeedProjectInConfig,
  loadAgentsManifest,
  sanitizeStagedContent,
  saveAgentsManifest,
  sha256Text,
  tryMergeMcpJson,
  walkFiles,
} from './agents/staging.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { resolveQaDirectory } from './domains/workspace/resolve.mjs';
import { resolvePlaywrightCli, runPlaywright } from './proc.mjs';

export {
  loadAgentsManifest,
  resolveQaDirectory,
  sanitizeStagedContent,
  saveAgentsManifest,
  sha256Text,
};

export const SUPPORTED_LOOPS = ['claude', 'codex', 'copilot', 'opencode', 'vscode', 'vscode-legacy'];

/**
 * Runs `playwright init-agents --loop=<loop>` in an isolated staging dir (`cwd = tempDir`),
 * sanitizes paths, and applies SHA-256 manifest-backed updates/conflict protection into `qaDir`.
 * @param {string} qaDir
 * @param {{
 *   loops?: string[],
 *   dryRun?: boolean,
 *   force?: boolean,
 *   lang?: 'zh' | 'en' | string,
 *   preserveSeed?: boolean,
 * }} [options]
 */
export async function syncOfficialAgents(qaDir, options = {}) {
  const {
    loops = ['codex'],
    dryRun = false,
    force = false,
    lang = 'zh',
    preserveSeed = true,
  } = options;

  const cliPath = resolvePlaywrightCli(qaDir);
  if (!cliPath) {
    throw new Error(
      lang === 'zh'
        ? `在 ${qaDir} 中未找到 @playwright/test CLI，请先安装依赖。`
        : `@playwright/test CLI not found in ${qaDir}. Install dependencies first.`
    );
  }

  for (const loop of loops) {
    if (!SUPPORTED_LOOPS.includes(loop)) {
      throw new Error(
        lang === 'zh'
          ? `不支持的 Agent loop: "${loop}"。可选值: ${SUPPORTED_LOOPS.join(', ')}`
          : `Unsupported agent loop: "${loop}". Allowed: ${SUPPORTED_LOOPS.join(', ')}`
      );
    }
  }

  const manifest = loadAgentsManifest(qaDir);
  let manifestDirty = false;
  let conflictCount = 0;
  /** @type {Array<{ loop: string, ok: boolean, stdout: string, actions: Array<{ file: string, status: string, sidecar?: string }> }>} */
  const results = [];
  const useSeedProject = hasSeedProjectInConfig(qaDir);

  for (const loop of loops) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `aitest-agents-${loop}-`));
    try {
      const targetPkg = path.join(qaDir, 'package.json');
      if (fs.existsSync(targetPkg)) {
        fs.copyFileSync(targetPkg, path.join(tempDir, 'package.json'));
      }
      const targetCfg = path.join(qaDir, 'playwright.config.ts');
      if (fs.existsSync(targetCfg)) {
        fs.copyFileSync(targetCfg, path.join(tempDir, 'playwright.config.ts'));
      }
      const targetSupport = path.join(qaDir, 'support');
      if (fs.existsSync(targetSupport)) {
        fs.cpSync(targetSupport, path.join(tempDir, 'support'), { recursive: true });
      }

      const targetModules = path.join(qaDir, 'node_modules');
      const linkType = process.platform === 'win32' ? 'junction' : 'dir';
      fs.symlinkSync(targetModules, path.join(tempDir, 'node_modules'), linkType);

      const beforeStage = walkFiles(tempDir);
      const args = ['init-agents', `--loop=${loop}`, '-c', 'playwright.config.ts'];
      if (useSeedProject) {
        args.push('--project=seed');
      }

      const res = await runPlaywright(tempDir, args, { timeoutMs: 25000 });
      if (res.code !== 0) {
        throw new Error(
          `playwright init-agents --loop=${loop} failed (exit ${res.code}): ${(res.stderr || res.stdout).trim()}`
        );
      }

      const afterStage = walkFiles(tempDir);
      /** @type {Array<{ rel: string, content: string }>} */
      const generatedFiles = [];
      for (const [rel, rawContent] of afterStage.entries()) {
        if (!beforeStage.has(rel) || beforeStage.get(rel) !== rawContent) {
          const sanitized = sanitizeStagedContent(rawContent, tempDir, qaDir);
          generatedFiles.push({ rel, content: sanitized });
        }
      }

      /** @type {Array<{ file: string, status: string, sidecar?: string }>} */
      const fileActions = [];
      const nowIso = new Date().toISOString();

      for (const item of generatedFiles) {
        if (item.rel.endsWith('.aitest-new')) continue;

        const dest = path.join(qaDir, item.rel);
        const existed = fs.existsSync(dest);
        const existingContent = existed ? fs.readFileSync(dest, 'utf8') : null;
        const incomingSha = sha256Text(item.content);

        // 1. Protect custom seed.spec.ts and specs/README.md created by template/user
        if ((item.rel === 'tests/seed.spec.ts' || item.rel === 'seed.spec.ts') && existed && preserveSeed && !force) {
          fileActions.push({ file: item.rel, status: 'PRESERVED' });
          continue;
        }
        if (item.rel === 'specs/README.md' && existed && !manifest.files[item.rel] && !force) {
          fileActions.push({ file: item.rel, status: 'PRESERVED' });
          continue;
        }

        // 2. Brand new file -> create & record sha256 in manifest
        if (!existed || existingContent === null) {
          if (!dryRun) {
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, item.content, 'utf8');
            manifest.files[item.rel] = { sha256: incomingSha, loop, updatedAt: nowIso };
            manifestDirty = true;
          }
          fileActions.push({ file: item.rel, status: 'ADDED' });
          continue;
        }

        // 3. Identical content -> record sha256 if missing & mark UNCHANGED
        const existingSha = sha256Text(existingContent);
        if (existingSha === incomingSha) {
          if (!dryRun && (!manifest.files[item.rel] || manifest.files[item.rel].sha256 !== incomingSha)) {
            manifest.files[item.rel] = { sha256: incomingSha, loop, updatedAt: nowIso };
            manifestDirty = true;
          }
          fileActions.push({ file: item.rel, status: 'UNCHANGED' });
          continue;
        }

        // 4. --force -> overwrite and update manifest
        if (force) {
          if (!dryRun) {
            fs.writeFileSync(dest, item.content, 'utf8');
            manifest.files[item.rel] = { sha256: incomingSha, loop, updatedAt: nowIso };
            manifestDirty = true;
          }
          fileActions.push({ file: item.rel, status: 'FORCED_UPDATE' });
          continue;
        }

        const recordedSha = manifest.files[item.rel]?.sha256 || null;

        // 5. JSON MCP file merge (only JSON supports structural merge)
        if (item.rel.endsWith('.mcp.json') || item.rel.endsWith('/mcp.json') || item.rel === 'mcp.json') {
          const merged = tryMergeMcpJson(existingContent, item.content, recordedSha);
          if (merged.status === 'MERGED_JSON') {
            if (!dryRun) {
              fs.writeFileSync(dest, merged.content, 'utf8');
              manifest.files[item.rel] = { sha256: sha256Text(merged.content), loop, updatedAt: nowIso };
              manifestDirty = true;
            }
            fileActions.push({ file: item.rel, status: 'MERGED_JSON' });
            continue;
          }
        }

        // 6. Unmodified since last manifest -> safe update
        if (recordedSha && existingSha === recordedSha) {
          if (!dryRun) {
            fs.writeFileSync(dest, item.content, 'utf8');
            manifest.files[item.rel] = { sha256: incomingSha, loop, updatedAt: nowIso };
            manifestDirty = true;
          }
          fileActions.push({ file: item.rel, status: 'UPDATED' });
          continue;
        }

        // 7. User modified file (or untracked pre-existing file) -> write sidecar .aitest-new & report CONFLICT
        const sidecarRel = `${item.rel}.aitest-new`;
        const sidecarDest = `${dest}.aitest-new`;
        if (!dryRun) {
          fs.mkdirSync(path.dirname(sidecarDest), { recursive: true });
          fs.writeFileSync(sidecarDest, item.content, 'utf8');
        }
        conflictCount += 1;
        fileActions.push({
          file: item.rel,
          sidecar: sidecarRel,
          status: 'CONFLICT',
        });
      }

      results.push({ loop, ok: true, stdout: res.stdout.trim(), actions: fileActions });
    } finally {
      const linkPath = path.join(tempDir, 'node_modules');
      try {
        if (fs.existsSync(linkPath)) fs.unlinkSync(linkPath);
      } catch {
        // ignore symlink cleanup edge
      }
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  if (!dryRun && manifestDirty) {
    saveAgentsManifest(qaDir, manifest);
  }

  return { results, conflictCount };
}

/**
 * @param {{
 *   lang?: 'zh' | 'en' | string,
 *   target?: string,
 *   qaDir?: string,
 *   loop?: string,
 *   dryRun?: boolean,
 *   force?: boolean,
 *   json?: boolean,
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runUpdateAgents(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {number} exitCode @param {string} msg @param {Record<string, any>} [data] */
  const finishAgents = (exitCode, msg, data = {}) => {
    if (!asJson && exitCode !== 0) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'update-agents',
        outcome: exitCode === 0 ? 'pass' : exitCode === 2 ? 'blocked' : 'fail',
        ok: exitCode === 0,
        exitCode,
        summary: msg,
        data: exitCode === 0 ? data : { error: msg, ...data },
      }),
      { asJson, compatSpreadData: false }
    );
  };
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    return finishAgents(1, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    return finishAgents(1, lang === 'zh' ? `未在 ${target} 找到已初始化的 QA 目录` : `No initialized QA directory found at ${target}`);
  }

  const loops = (options.loop || 'codex')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'none');

  if (loops.length === 0) {
    const msg = lang === 'zh' ? '未指定有效的 --loop，跳过。' : 'No loop specified, skipping.';
    if (!asJson) console.log(msg);
    return finishAgents(0, msg, { skipped: true, loops: [] });
  }

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const pwCli = resolvePlaywrightCli(qaDir);
  if (!pwCli) {
    return finishAgents(1, lang === 'zh' ? `请先在 ${qaDir} 安装依赖 (npm install / npm ci)` : `Install dependencies in ${qaDir} first`);
  }

  const verRes = await runPlaywright(qaDir, ['--version'], { timeoutMs: 8000 });
  if (!asJson) {
    console.log(
      `${lang === 'zh' ? '同步 Playwright Test Agents' : 'Syncing Playwright Test Agents'} (${verRes.stdout.trim()})${dryRun ? ' [DRY-RUN]' : ''}${force ? ' [FORCE]' : ''}`
    );
    console.log(`${lang === 'zh' ? '目标 QA 目录' : 'Target QA dir'}: ${qaDir}`);
  }

  const { results, conflictCount } = await syncOfficialAgents(qaDir, {
    loops,
    dryRun,
    force,
    lang,
    preserveSeed: true,
  });

  if (!asJson) {
    for (const r of results) {
      console.log(`\nLoop: ${r.loop}`);
      for (const act of r.actions) {
        if (act.status === 'CONFLICT') {
          console.log(`  [CONFLICT] ${act.file} (user changes preserved; new upstream template written to ${act.sidecar})`);
        } else {
          console.log(`  [${act.status}] ${act.file}`);
        }
      }
    }
  }

  if (conflictCount > 0) {
    const msg =
      lang === 'zh'
        ? `检测到 ${conflictCount} 个已修改的 Agent 定义冲突，原文件未覆盖，新版本已写入 *.aitest-new。请手工合并或加 --force 强制更新。`
        : `Detected ${conflictCount} modified agent file conflict(s). Existing files were preserved and incoming templates saved to *.aitest-new. Merge manually or pass --force.`;
    return finishAgents(2, msg, { qaDir, results, conflictCount });
  }

  return finishAgents(0, `Synced ${results.length} Playwright agent loop(s)`, { qaDir, results, conflictCount: 0 });
}
