// @ts-check
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { probeToolVersion, redactSecrets, runNpm, resolvePlaywrightCli, runPlaywright } from './proc.mjs';
import { GATE_KERNEL_VERSION } from '../templates/playwright-qa/support/gate-kernel.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKBENCH_ROOT = path.resolve(__dirname, '..');

function formatGb(bytes) {
  return `${(bytes / (1024 ** 3)).toFixed(1)} GB`;
}

function isSupportedNodeVersion(versionStr) {
  const [maj, min] = versionStr.split('.').map((n) => Number(n));
  if (maj > 22) return true;
  if (maj === 22 && min >= 12) return true;
  return false;
}

export function getBrowserCacheCandidates() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_BROWSERS_PATH && process.env.PLAYWRIGHT_BROWSERS_PATH !== '0') {
    dirs.push(process.env.PLAYWRIGHT_BROWSERS_PATH);
  }
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) {
      dirs.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright'));
    }
  } else if (process.platform === 'darwin') {
    dirs.push(path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'));
  } else {
    dirs.push(path.join(os.homedir(), '.cache', 'ms-playwright'));
  }
  return [...new Set(dirs)];
}

export function inspectBrowserCache() {
  const candidates = getBrowserCacheCandidates();
  for (const dir of candidates) {
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true }).map((e) => e.name);
      const chromiumEntries = entries.filter((n) => n.startsWith('chromium'));
      return { exists: true, dir, entries, chromiumEntries };
    }
  }
  return { exists: false, dir: candidates[0] || '', entries: [], chromiumEntries: [] };
}

export async function runDoctor(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const targetDir = options.target ? path.resolve(options.target) : null;
  const checks = [];

  const add = (status, name, detail) => {
    checks.push({ status, name, detail });
  };

  // 1. OS & Shell
  const isWsl =
    process.platform === 'linux' &&
    fs.existsSync('/proc/version') &&
    fs.readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  add(
    'OK',
    lang === 'zh' ? '操作系统与架构' : 'OS & Arch',
    `${os.platform()} ${os.release()} (${os.arch()})${isWsl ? ' [WSL]' : ''}, Shell=${process.env.ComSpec || process.env.SHELL || 'unknown'}`
  );

  // 2. Node.js (>=22.12 required; 24 Maintenance LTS / 26 Active LTS recommended)
  if (isSupportedNodeVersion(process.versions.node)) {
    add('OK', 'Node.js', `${process.version} (${process.execPath}) [>=22.12 OK; 24/26 LTS recommended]`);
  } else {
    add(
      'FAIL',
      'Node.js',
      `${process.version} — ${
        lang === 'zh'
          ? '要求 Node.js >= 22.12（Node 20 已 EOL，推荐 24 Maintenance LTS 或 26 Active LTS）'
          : 'Requires Node.js >= 22.12 (Node 20 is EOL; 24/26 LTS recommended)'
      }`
    );
  }

  // 3. npm
  try {
    const npmVerRes = await runNpm(['--version'], { timeoutMs: 8000 });
    const npmRegistryRes = await runNpm(['config', 'get', 'registry'], { timeoutMs: 8000 });
    const npmVer = npmVerRes.stdout.trim() || 'unknown';
    const reg = redactSecrets(npmRegistryRes.stdout.trim() || 'unknown');
    add(npmVerRes.code === 0 ? 'OK' : 'WARN', 'npm', `v${npmVer}, registry=${reg}`);
  } catch (err) {
    add('FAIL', 'npm', err.message);
  }

  // 4. Git / Codex / Claude / Docker
  const gitInfo = await probeToolVersion('git');
  add(gitInfo.installed ? 'OK' : 'WARN', 'Git', gitInfo.installed ? `${gitInfo.version} (${gitInfo.path})` : 'not found');

  const codexInfo = await probeToolVersion('codex');
  add(
    codexInfo.installed ? 'OK' : 'WARN',
    'Codex CLI',
    codexInfo.installed
      ? `${codexInfo.version} (${codexInfo.path})`
      : lang === 'zh'
        ? '未检测到（可选）'
        : 'not found (optional)'
  );

  const claudeInfo = await probeToolVersion('claude');
  add(
    claudeInfo.installed ? 'OK' : 'WARN',
    'Claude Code',
    claudeInfo.installed
      ? `${claudeInfo.version} (${claudeInfo.path})`
      : lang === 'zh'
        ? '未检测到（可选）'
        : 'not found (optional)'
  );

  const dockerInfo = await probeToolVersion('docker');
  add(
    dockerInfo.installed ? 'OK' : 'WARN',
    'Docker',
    dockerInfo.installed
      ? `${dockerInfo.version}`
      : lang === 'zh'
        ? '未检测到（仅容器化 CI 需要）'
        : 'not found (optional for local runs)'
  );

  // 5. Proxy env visibility (redacted)
  const proxyEnv = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy']
    .filter((k) => process.env[k])
    .map((k) => `${k}=${redactSecrets(process.env[k])}`);
  add('OK', lang === 'zh' ? '代理环境' : 'Proxy Env', proxyEnv.length > 0 ? proxyEnv.join(', ') : lang === 'zh' ? '无代理环境变量' : 'none');

  // 6. Disk & write permission
  try {
    const statFs = fs.statfsSync(WORKBENCH_ROOT);
    const freeBytes = Number(statFs.bavail) * Number(statFs.bsize);
    fs.accessSync(WORKBENCH_ROOT, fs.constants.W_OK);
    add(
      freeBytes > 2 * 1024 ** 3 ? 'OK' : 'WARN',
      lang === 'zh' ? '磁盘空间与写入权限' : 'Disk & Write Access',
      `${formatGb(freeBytes)} free, writable (${WORKBENCH_ROOT})`
    );
  } catch (err) {
    add('FAIL', lang === 'zh' ? '磁盘空间与写入权限' : 'Disk & Write Access', err.message);
  }

  // 7. Template Playwright status
  const templateQaDir = path.join(WORKBENCH_ROOT, 'templates', 'playwright-qa');
  const templatePwCli = resolvePlaywrightCli(templateQaDir);
  if (templatePwCli) {
    const pwRes = await runPlaywright(templateQaDir, ['--version'], { timeoutMs: 8000 });
    add(
      pwRes.code === 0 ? 'OK' : 'WARN',
      'Template @playwright/test',
      `${pwRes.stdout.trim()} (${templateQaDir})`
    );
  } else {
    add(
      'WARN',
      'Template @playwright/test',
      lang === 'zh'
        ? `模板依赖尚未安装（可在 ${templateQaDir} 执行 npm install）`
        : `Template dependencies not installed yet in ${templateQaDir}`
    );
  }

  // 8. Browser cache
  const browserCache = inspectBrowserCache();
  if (browserCache.exists && browserCache.chromiumEntries.length > 0) {
    add(
      'OK',
      lang === 'zh' ? 'Playwright 浏览器缓存' : 'Playwright Browser Cache',
      `${browserCache.dir} -> [${browserCache.chromiumEntries.join(', ')}]`
    );
  } else {
    add(
      'WARN',
      lang === 'zh' ? 'Playwright 浏览器缓存' : 'Playwright Browser Cache',
      lang === 'zh'
        ? `未发现 Chromium 缓存 (${browserCache.dir})，请执行 npx playwright install chromium`
        : `No Chromium cache found in ${browserCache.dir}; run npx playwright install chromium`
    );
  }

  // 9. Optional target QA check & Gate Kernel drift check (A-03)
  if (targetDir) {
    const candidateQa = fs.existsSync(path.join(targetDir, 'playwright.config.ts')) ? targetDir : path.join(targetDir, 'qa');
    const targetPwCli = resolvePlaywrightCli(targetDir) || resolvePlaywrightCli(candidateQa);
    const hasDir = fs.existsSync(targetDir);
    add(
      hasDir ? (targetPwCli ? 'OK' : 'WARN') : 'FAIL',
      lang === 'zh' ? '目标路径检查' : 'Target Check',
      hasDir
        ? targetPwCli
          ? `Playwright CLI ready (${targetPwCli})`
          : `Directory exists, Playwright not initialized yet (${targetDir})`
        : `Target directory does not exist: ${targetDir}`
    );

    const hostKernelPath = path.join(candidateQa, 'support', 'gate-kernel.mjs');
    if (fs.existsSync(candidateQa) && fs.existsSync(path.join(candidateQa, 'playwright.config.ts'))) {
      if (!fs.existsSync(hostKernelPath)) {
        add('WARN', 'Gate Kernel Drift', `Host QA directory predates Gate Kernel v${GATE_KERNEL_VERSION}; update support/gate-kernel.mjs.`);
      } else {
        const hostSrc = fs.readFileSync(hostKernelPath, 'utf8');
        const m = /GATE_KERNEL_VERSION\s*=\s*['"]([^'"]+)['"]/.exec(hostSrc);
        const hostVer = m ? m[1] : 'unknown';
        add(
          hostVer === GATE_KERNEL_VERSION ? 'OK' : 'WARN',
          'Gate Kernel Version',
          hostVer === GATE_KERNEL_VERSION
            ? `v${hostVer} matches workbench`
            : `Host QA kernel v${hostVer} != workbench v${GATE_KERNEL_VERSION}`
        );
      }
    }
  }

  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const warnCount = checks.filter((c) => c.status === 'WARN').length;

  if (options.json) {
    console.log(JSON.stringify({ ok: failCount === 0, failCount, warnCount, checks }, null, 2));
  } else {
    console.log(`\n=== ${lang === 'zh' ? 'AI Test Workbench 环境体检 (doctor)' : 'AI Test Workbench Environment Doctor'} ===`);
    for (const c of checks) {
      const badge = c.status === 'OK' ? '[OK]  ' : c.status === 'WARN' ? '[WARN]' : '[FAIL]';
      console.log(`${badge} ${c.name}: ${c.detail}`);
    }
    console.log(
      `\n${lang === 'zh' ? '汇总' : 'Summary'}: OK=${checks.length - warnCount - failCount}, WARN=${warnCount}, FAIL=${failCount}\n`
    );
  }

  return failCount === 0 ? 0 : 1;
}
