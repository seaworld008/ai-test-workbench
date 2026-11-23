// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolvePlaywrightCli, runPlaywright } from './proc.mjs';

export const SUPPORTED_LOOPS = ['claude', 'codex', 'copilot', 'opencode', 'vscode', 'vscode-legacy'];
const MANIFEST_REL_PATH = '.aitest/agents-manifest.json';

export function sha256Text(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function walkFiles(dir, baseDir = dir) {
  const out = new Map();
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'playwright-report' ||
      entry.name === 'test-results' ||
      entry.name === 'reports' ||
      entry.name === '.git'
    ) {
      continue;
    }
    const full = path.join(dir, entry.name);
    const rel = path.relative(baseDir, full).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      for (const [k, v] of walkFiles(full, baseDir)) {
        out.set(k, v);
      }
    } else if (entry.isFile()) {
      out.set(rel, fs.readFileSync(full, 'utf8'));
    }
  }
  return out;
}

/**
 * Replaces any absolute path references to the temporary staging directory with qaDir
 * across native, forward-slash, backslash, and JSON-escaped backslash forms,
 * and asserts zero leftover staging marker (`aitest-agents-`).
 */
export function sanitizeStagedContent(content, tempDir, qaDir) {
  const tempNative = path.resolve(tempDir);
  const qaNative = path.resolve(qaDir);

  const tempFwd = tempNative.replace(/\\/g, '/');
  const qaFwd = qaNative.replace(/\\/g, '/');

  const tempBack = tempNative.replace(/\//g, '\\');
  const qaBack = qaNative.replace(/\//g, '\\');

  const tempJsonEsc = tempBack.replace(/\\/g, '\\\\');
  const qaJsonEsc = qaBack.replace(/\\/g, '\\\\');

  let out = content;
  out = out.replaceAll(tempJsonEsc, qaJsonEsc);
  out = out.replaceAll(tempFwd, qaFwd);
  out = out.replaceAll(tempBack, qaBack);

  if (out.includes('aitest-agents-')) {
    throw new Error('Staging path leak detected after sanitization ("aitest-agents-" remained in generated agent config).');
  }
  return out;
}

export function loadAgentsManifest(qaDir) {
  const manifestPath = path.join(qaDir, MANIFEST_REL_PATH);
  if (!fs.existsSync(manifestPath)) {
    return { version: 1, files: {} };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return { version: 1, files: parsed.files || {} };
  } catch {
    return { version: 1, files: {} };
  }
}

export function saveAgentsManifest(qaDir, manifest) {
  const manifestPath = path.join(qaDir, MANIFEST_REL_PATH);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
}

/**
 * Safely merges JSON MCP configs only when existing keys are either untouched since manifest
 * or disjoint from incoming keys. Returns { status: 'MERGED_JSON' | 'CONFLICT', content }.
 */
function tryMergeMcpJson(existingStr, incomingStr, recordedSha) {
  try {
    const existing = JSON.parse(existingStr);
    const incoming = JSON.parse(incomingStr);
    const existingSha = sha256Text(existingStr);
    const userEdited = Boolean(recordedSha && existingSha !== recordedSha) || !recordedSha;

    const merged = { ...existing };
    for (const rootKey of ['mcpServers', 'servers']) {
      if (existing[rootKey] || incoming[rootKey]) {
        const exMap = existing[rootKey] || {};
        const inMap = incoming[rootKey] || {};
        const nextMap = { ...exMap };
        for (const [srvName, srvVal] of Object.entries(inMap)) {
          if (srvName in exMap && JSON.stringify(exMap[srvName]) !== JSON.stringify(srvVal)) {
            if (userEdited) {
              return { status: 'CONFLICT', content: null };
            }
          }
          nextMap[srvName] = srvVal;
        }
        merged[rootKey] = nextMap;
      }
    }
    return { status: 'MERGED_JSON', content: JSON.stringify(merged, null, 2) + '\n' };
  } catch {
    return { status: 'CONFLICT', content: null };
  }
}

function hasSeedProjectInConfig(qaDir) {
  const cfgPath = path.join(qaDir, 'playwright.config.ts');
  if (!fs.existsSync(cfgPath)) return false;
  const txt = fs.readFileSync(cfgPath, 'utf8');
  return /name\s*:\s*['"]seed['"]/.test(txt);
}

/**
 * Runs `playwright init-agents --loop=<loop>` in an isolated staging dir (`cwd = tempDir`),
 * sanitizes paths, and applies SHA-256 manifest-backed updates/conflict protection into `qaDir`.
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
      const generatedFiles = [];
      for (const [rel, rawContent] of afterStage.entries()) {
        if (!beforeStage.has(rel) || beforeStage.get(rel) !== rawContent) {
          const sanitized = sanitizeStagedContent(rawContent, tempDir, qaDir);
          generatedFiles.push({ rel, content: sanitized });
        }
      }

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
        if (!existed) {
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

export async function runUpdateAgents(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未在 ${target} 找到已初始化的 QA 目录` : `No initialized QA directory found at ${target}`);
    return 1;
  }

  const loops = (options.loop || 'codex')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s && s !== 'none');

  if (loops.length === 0) {
    console.log(lang === 'zh' ? '未指定有效的 --loop，跳过。' : 'No loop specified, skipping.');
    return 0;
  }

  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const pwCli = resolvePlaywrightCli(qaDir);
  if (!pwCli) {
    console.error(lang === 'zh' ? `请先在 ${qaDir} 安装依赖 (npm install / npm ci)` : `Install dependencies in ${qaDir} first`);
    return 1;
  }

  const verRes = await runPlaywright(qaDir, ['--version'], { timeoutMs: 8000 });
  console.log(
    `${lang === 'zh' ? '同步 Playwright Test Agents' : 'Syncing Playwright Test Agents'} (${verRes.stdout.trim()})${dryRun ? ' [DRY-RUN]' : ''}${force ? ' [FORCE]' : ''}`
  );
  console.log(`${lang === 'zh' ? '目标 QA 目录' : 'Target QA dir'}: ${qaDir}`);

  const { results, conflictCount } = await syncOfficialAgents(qaDir, {
    loops,
    dryRun,
    force,
    lang,
    preserveSeed: true,
  });

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

  if (conflictCount > 0) {
    console.error(
      lang === 'zh'
        ? `\n检测到 ${conflictCount} 个已修改的 Agent 定义冲突，原文件未覆盖，新版本已写入 *.aitest-new。请手工合并或加 --force 强制更新。`
        : `\nDetected ${conflictCount} modified agent file conflict(s). Existing files were preserved and incoming templates saved to *.aitest-new. Merge manually or pass --force.`
    );
    return 2;
  }

  return 0;
}

export function resolveQaDirectory(targetPath, explicitQaDir) {
  const abs = path.resolve(targetPath);
  if (fs.existsSync(path.join(abs, 'playwright.config.ts')) || fs.existsSync(path.join(abs, 'playwright.config.js'))) {
    return abs;
  }
  const sub = path.join(abs, explicitQaDir || 'qa');
  if (
    fs.existsSync(path.join(sub, 'playwright.config.ts')) ||
    fs.existsSync(path.join(sub, 'playwright.config.js')) ||
    fs.existsSync(path.join(sub, 'package.json'))
  ) {
    return sub;
  }
  return null;
}
