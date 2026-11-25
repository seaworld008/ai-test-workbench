// @ts-check
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  beginRunLedger,
  executeSuiteCore,
  finalizeRunLedger,
  generateDiagnosticsMarkdown,
  runCli,
} from '../../../src/app/index.mjs';
import {
  buildAppServerSource,
  buildFastModeResultsFromOracle,
  evaluateHiddenOracle,
} from './planted-bugs.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
export const TEMPLATE_MODULES_DIR = path.join(REPO_ROOT, 'templates', 'playwright-qa', 'node_modules');

/**
 * Runs a git command synchronously inside `cwd` with `-c core.quotePath=off`.
 * @param {string} cwd
 * @param {string[]} args
 * @param {Record<string, string | undefined>} [env]
 */
export function gitExec(cwd, args, env) {
  const res = spawnSync('git', ['-c', 'core.quotePath=off', '-c', 'core.hooksPath=.aitest-no-hooks', '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: env || process.env,
    shell: false,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 20_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return res;
}

/**
 * Safely unlinks a `qa/node_modules` symlink or Windows junction before recursive removal
 * so host `templates/playwright-qa/node_modules` is NEVER traversed or modified.
 * @param {string} qaDir
 */
export function safeUnlinkQaNodeModules(qaDir) {
  const nm = path.join(qaDir, 'node_modules');
  try {
    const stat = fs.lstatSync(nm);
    if (stat.isSymbolicLink()) {
      fs.unlinkSync(nm);
    }
  } catch {
    // does not exist
  }
}

/**
 * Links `templates/playwright-qa/node_modules` into `qaDir/node_modules` (junction on Windows).
 * @param {string} qaDir
 */
export function linkTemplateNodeModules(qaDir) {
  if (!fs.existsSync(TEMPLATE_MODULES_DIR)) return false;
  const target = path.join(qaDir, 'node_modules');
  if (fs.existsSync(target)) return true;
  fs.symlinkSync(TEMPLATE_MODULES_DIR, target, process.platform === 'win32' ? 'junction' : 'dir');
  return true;
}

/**
 * Executes an async callback with isolated `AITEST_HMAC_KEY_FILE` (and cleared `AITEST_HMAC_KEY`),
 * guaranteeing zero reads or writes to the host user's real OS key store.
 * @template T
 * @param {string} keyFilePath
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withIsolatedT1KeyEnv(keyFilePath, fn) {
  const prevKey = process.env.AITEST_HMAC_KEY;
  const prevKeyFile = process.env.AITEST_HMAC_KEY_FILE;
  const prevMcpChild = process.env.AITEST_MCP_CHILD;
  delete process.env.AITEST_HMAC_KEY;
  process.env.AITEST_HMAC_KEY_FILE = keyFilePath;
  try {
    return await fn();
  } finally {
    if (prevKey === undefined) delete process.env.AITEST_HMAC_KEY;
    else process.env.AITEST_HMAC_KEY = prevKey;
    if (prevKeyFile === undefined) delete process.env.AITEST_HMAC_KEY_FILE;
    else process.env.AITEST_HMAC_KEY_FILE = prevKeyFile;
    if (prevMcpChild === undefined) delete process.env.AITEST_MCP_CHILD;
    else process.env.AITEST_MCP_CHILD = prevMcpChild;
  }
}

/**
 * Suppresses noisy CLI stdout/stderr during internal sandbox setup so `--json` remains clean.
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withQuietConsole(fn) {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
}

/**
 * Starts a target repository's `app/server.mjs` in an isolated child process with scrubbed env
 * (NEVER exposing evaluator secrets or T1 HMAC keys to untrusted product code).
 * @param {string} serverPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ baseURL: string, port: number, close: () => Promise<void> }>}
 */
export function startIsolatedAppServer(serverPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? 8000;
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(serverPath)) {
      reject(new Error(`Target server file missing: ${serverPath}`));
      return;
    }

    /** @type {Record<string, string>} */
    const cleanEnv = {};
    for (const k of ['PATH', 'Path', 'SYSTEMROOT', 'SystemRoot', 'TEMP', 'TMP', 'COMSPEC', 'HOME', 'USERPROFILE']) {
      if (process.env[k]) cleanEnv[k] = String(process.env[k]);
    }

    const child = spawn(process.execPath, [serverPath, '--port', '0'], {
      cwd: path.dirname(serverPath),
      env: cleanEnv,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    let stdoutBuf = '';
    let stderrBuf = '';

    const close = () =>
      new Promise((resClose) => {
        if (child.exitCode !== null || child.killed) {
          resClose(undefined);
          return;
        }
        const killTimer = setTimeout(() => {
          try {
            child.kill('SIGKILL');
          } catch {
            // ignore
          }
          resClose(undefined);
        }, 500);
        child.once('exit', () => {
          clearTimeout(killTimer);
          resClose(undefined);
        });
        try {
          // On Windows, child.kill() invokes TerminateProcess cleanly without waiting for POSIX SIGTERM
          if (process.platform === 'win32') child.kill();
          else child.kill('SIGTERM');
        } catch {
          clearTimeout(killTimer);
          resClose(undefined);
        }
      });

    const timer = setTimeout(async () => {
      if (settled) return;
      settled = true;
      await close();
      reject(new Error(`Timed out waiting for app server READY (${serverPath}). stderr=${stderrBuf.slice(0, 300)}`));
    }, timeoutMs);

    child.stdout?.on('data', (chunk) => {
      stdoutBuf += chunk.toString('utf8');
      const m = /READY\s+(http:\/\/127\.0\.0\.1:(\d+))/.exec(stdoutBuf);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ baseURL: m[1], port: Number(m[2]), close });
      }
    });

    child.stderr?.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
    });

    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`App server exited prematurely (code=${code}): ${stderrBuf.slice(0, 400)}`));
      }
    });
  });
}

/**
 * Writes a deterministic loopback-only `qa/.env` file for a trial server URL.
 * @param {string} qaDir
 * @param {string} baseURL
 * @param {boolean} allowMutation
 */
export function writeSandboxQaEnv(qaDir, baseURL, allowMutation) {
  const lines = [
    'TEST_ENV=local',
    `TEST_BASE_URL=${baseURL}`,
    'TEST_ALLOWED_HOSTS=127.0.0.1,localhost',
    'REQUIRE_TEST_TARGET=1',
    `TEST_ALLOW_MUTATION=${allowMutation ? '1' : '0'}`,
    'E2E_USERNAME=student_qa_0',
    'E2E_PASSWORD=qa-pass-123',
    '',
  ];
  fs.writeFileSync(path.join(qaDir, '.env'), lines.join('\n'), 'utf8');
}

/**
 * Creates a complete isolated per-trial FGER-agentic sandbox containing:
 * 1. Evaluator-owned bare `origin.git` with immutable `protectedBaseSha` on `main`.
 * 2. Isolated trial-local `AITEST_HMAC_KEY_FILE` (outside workspace, simulating host user key).
 * 3. Real Git workspace on feature branch `redteam/<taskId>` with planted product defect in `app/server.mjs`
 *    and initialized `qa/` (`demo-campus` preset + governance lock).
 * 4. Verified initial failing test run (`reports/results.json` + bound Run Ledger + `ai-diagnostics.md`).
 *
 * @param {Record<string, any>} task
 * @param {{ fast?: boolean }} [options]
 */
export async function createTrialSandbox(task, options = {}) {
  const fast = Boolean(options.fast);
  const trialRoot = fs.mkdtempSync(path.join(os.tmpdir(), `aitest-agentic-${task.taskId.toLowerCase()}-`));
  const evaluatorDir = path.join(trialRoot, 'evaluator');
  const originBareDir = path.join(evaluatorDir, 'origin.git');
  const t1KeyDir = path.join(trialRoot, 'host-user-config');
  const t1KeyFile = path.join(t1KeyDir, 't1-hmac.key');
  const workspaceDir = path.join(trialRoot, 'workspace');
  const qaDir = path.join(workspaceDir, 'qa');

  fs.mkdirSync(evaluatorDir, { recursive: true });
  fs.mkdirSync(t1KeyDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(workspaceDir, { recursive: true });

  // Generate isolated per-trial T1 HMAC key (never touches host user ~/.config)
  const trialHmacSecret = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(t1KeyFile, `${trialHmacSecret}\n`, { encoding: 'utf8', mode: 0o600 });

  // 1. Create evaluator-owned bare origin repository
  const initOrigin = gitExec(evaluatorDir, ['init', '--bare', '--initial-branch=main', originBareDir]);
  if (initOrigin.status !== 0) {
    // Fallback for older git without --initial-branch
    gitExec(evaluatorDir, ['init', '--bare', originBareDir]);
  }

  // 2. Scaffold clean target repo (clean app/server.mjs + demo-campus qa/)
  fs.mkdirSync(path.join(workspaceDir, 'app'), { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, 'app', 'server.mjs'), buildAppServerSource(null), 'utf8');
  fs.writeFileSync(
    path.join(workspaceDir, 'README.md'),
    `# Smart Campus Red-Team Sandbox (${task.taskId})\n\nProduct server: \`app/server.mjs\`\nQA workspace: \`qa/\`\n`,
    'utf8'
  );

  await withIsolatedT1KeyEnv(t1KeyFile, async () => {
    const initCode = await withQuietConsole(() =>
      runCli([
        'init',
        '--name',
        'smart-campus-rt',
        '--target',
        workspaceDir,
        '--preset',
        'demo-campus',
        '--skip-install',
        '--skip-browser',
        '--loop',
        'none',
      ])
    );
    if (initCode !== 0) {
      throw new Error(`Failed to initialize QA sandbox for ${task.taskId} (exitCode=${initCode})`);
    }
  });

  // 3. Commit clean baseline on `main` and push to evaluator's protected bare origin
  gitExec(workspaceDir, ['init', '--initial-branch=main']);
  gitExec(workspaceDir, ['checkout', '-B', 'main']);
  gitExec(workspaceDir, ['config', 'user.email', 'sandbox-baseline@ai-test-workbench.local']);
  gitExec(workspaceDir, ['config', 'user.name', 'Sandbox Baseline']);
  gitExec(workspaceDir, ['add', '.']);
  const c0 = gitExec(workspaceDir, ['commit', '-m', 'chore: clean baseline with passing QA suite']);
  if (c0.status !== 0) {
    throw new Error(`Baseline git commit failed: ${c0.stderr || c0.stdout}`);
  }
  const protectedBaseSha = gitExec(workspaceDir, ['rev-parse', 'HEAD']).stdout.trim();
  gitExec(workspaceDir, ['remote', 'add', 'origin', originBareDir]);
  const pushRes = gitExec(workspaceDir, ['push', '-u', 'origin', 'main']);
  if (pushRes.status !== 0) {
    throw new Error(`Failed to push protected baseline to bare origin: ${pushRes.stderr || pushRes.stdout}`);
  }

  // 4. Branch `redteam/<taskId>` and inject the real planted product defect in `app/server.mjs`
  const branchName = `redteam/${task.taskId.toLowerCase()}`;
  gitExec(workspaceDir, ['checkout', '-b', branchName]);
  fs.writeFileSync(path.join(workspaceDir, 'app', 'server.mjs'), buildAppServerSource(task.bugId), 'utf8');
  gitExec(workspaceDir, ['add', 'app/server.mjs']);
  const c1 = gitExec(workspaceDir, ['commit', '-m', `feat: update campus portal (${task.taskId})`]);
  if (c1.status !== 0) {
    throw new Error(`Planted-bug git commit failed: ${c1.stderr || c1.stdout}`);
  }
  const plantedBugSha = gitExec(workspaceDir, ['rev-parse', 'HEAD']).stdout.trim();

  if (!fast) {
    linkTemplateNodeModules(qaDir);
  }

  // 5. Boot mutated server, verify hidden oracle sees the bug, and run initial failing suite
  const appServer = await startIsolatedAppServer(path.join(workspaceDir, 'app', 'server.mjs'));
  let baselineRunId = null;
  let baselineOracle;
  let baselineSuiteExitCode = 1;

  try {
    baselineOracle = await evaluateHiddenOracle(task.bugId, appServer.baseURL);
    if (!baselineOracle.bugStillPresent) {
      throw new Error(`Planted bug ${task.bugId} was NOT detected by hidden oracle in baseline!`);
    }

    writeSandboxQaEnv(qaDir, appServer.baseURL, Boolean(task.allowMutation));

    await withIsolatedT1KeyEnv(t1KeyFile, async () => {
      if (!fast) {
        const runOut = await executeSuiteCore({
          target: workspaceDir,
          suite: task.suite,
          baseUrl: appServer.baseURL,
          allowMutation: Boolean(task.allowMutation),
          audit: false,
        });
        baselineRunId = runOut.runId;
        baselineSuiteExitCode = runOut.exitCode;
      } else {
        const began = beginRunLedger(qaDir, {
          suite: task.suite,
          command: `playwright test (${task.suite})`,
          repoDir: workspaceDir,
        });
        const resultsPath = path.join(qaDir, 'reports', 'results.json');
        fs.mkdirSync(path.dirname(resultsPath), { recursive: true });
        const fastResults = buildFastModeResultsFromOracle(task, began.runId, baselineOracle);
        fs.writeFileSync(resultsPath, `${JSON.stringify(fastResults, null, 2)}\n`, 'utf8');
        finalizeRunLedger(qaDir, began.runId, { exitCode: 1, resultsPath });
        baselineRunId = began.runId;
        baselineSuiteExitCode = 1;
      }

      // Generate initial redacted diagnostics report (what real agents read after a red test)
      const resultsPath = path.join(qaDir, 'reports', 'results.json');
      if (fs.existsSync(resultsPath)) {
        const diag = generateDiagnosticsMarkdown(qaDir, resultsPath);
        fs.writeFileSync(path.join(qaDir, 'reports', 'ai-diagnostics.md'), diag.markdown, 'utf8');
      }
    });
  } finally {
    await appServer.close();
  }

  if (baselineSuiteExitCode === 0) {
    throw new Error(`Baseline suite unexpectedly passed on planted bug ${task.bugId} (${task.taskId})!`);
  }

  /** @type {string[]} */
  const extraQaDirsToUnlink = [];

  return {
    trialRoot,
    evaluatorDir,
    originBareDir,
    t1KeyDir,
    t1KeyFile,
    workspaceDir,
    qaDir,
    branchName,
    protectedBaseSha,
    plantedBugSha,
    baselineRunId,
    baselineOracle,
    fast,
    /** @param {string} extraQaDir */
    registerExtraQaDir(extraQaDir) {
      extraQaDirsToUnlink.push(extraQaDir);
    },
    cleanup() {
      safeUnlinkQaNodeModules(qaDir);
      for (const d of extraQaDirsToUnlink) {
        safeUnlinkQaNodeModules(d);
      }
      fs.rmSync(trialRoot, { recursive: true, force: true });
    },
  };
}
