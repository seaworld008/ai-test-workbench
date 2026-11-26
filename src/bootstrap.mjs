// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { isLoopbackHttpUrl, loadRuntimeConfig, validateRuntimeConfig } from './core/runtime-config.mjs';
import { resolvePlaywrightCli } from './core/playwright-resolve.mjs';
import { runNpm, runPlaywright } from './core/proc.mjs';
import { detectProjectStack, inferStackRuntimeDefaults, runInit } from './init.mjs';
import { openTrustContext, resolveDefaultDiffBase, resolveGitHeadSha, writeSignedBaselineRef } from './kernel/gate-kernel.mjs';
import { loadMergedQaEnv } from './origin-guard.mjs';

/**
 * Infers a loopback `aitest.runtime.json` specification from host repository files
 * using the declarative `STACK_DESCRIPTORS` and `detectPackageManager` registries.
 * @param {string} repoDir
 * @param {{ baseUrl?: string, healthPath?: string, port?: number }} [options]
 */
export function inferRuntimeConfigForRepo(repoDir, options = {}) {
  const stacks = fs.existsSync(repoDir) ? detectProjectStack(repoDir) : ['Generic Web'];
  const defaults = fs.existsSync(repoDir)
    ? inferStackRuntimeDefaults(repoDir)
    : { stack: 'Generic Web', stacks: ['Generic Web'], packageManager: 'npm', defaultPort: 3000, healthPath: '/', command: null };

  const command = defaults.command;
  const defaultPort = options.port || defaults.defaultPort || 3000;
  const healthPath = options.healthPath || defaults.healthPath || '/';

  const resolvedBaseUrl = options.baseUrl && isLoopbackHttpUrl(options.baseUrl)
    ? options.baseUrl.replace(/\/+$/, '')
    : command
      ? `http://127.0.0.1:${defaultPort}`
      : null;

  return {
    schemaVersion: 1,
    stack: stacks[0] || defaults.stack || 'Generic Web',
    baseURL: resolvedBaseUrl,
    healthPath,
    ...(command && resolvedBaseUrl
      ? {
          webServer: {
            command,
            cwd: '.',
            url: resolvedBaseUrl,
            port: defaultPort,
            timeoutMs: 45_000,
            reuseExistingServer: true,
          },
        }
      : {}),
  };
}

/**
 * Probes an HTTP endpoint up to `timeoutMs` cleanly.
 * @param {string} urlStr
 * @param {number} [timeoutMs]
 */
async function probeHttpEndpoint(urlStr, timeoutMs = 2000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(urlStr, { method: 'GET', redirect: 'manual', signal: ac.signal });
    return { reachable: true, status: res.status };
  } catch (err) {
    return { reachable: false, status: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One-call idempotent workspace bootstrapper (`WU-04`):
 * 1) Initializes `<repo>/qa` if missing
 * 2) Sniffs stack & writes validated loopback-only `qa/aitest.runtime.json` if absent
 * 3) Installs `qa/node_modules` & Chromium (unless skipped)
 * 4) Probes local loopback server & performs optional loopback API auth warmup
 * 5) Records `.aitest/baseline-ref` when absent
 *
 * @param {Record<string, any>} [options]
 */
export async function bootstrapWorkspaceCore(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    return {
      ok: false,
      exitCode: 64,
      outcome: /** @type {const} */ ('usage'),
      blockerKind: 'MISSING_TARGET',
      recoverable: true,
      recoverySteps: ['Pass --target <repo-path>.'],
      summary: 'Missing --target <repo-path>',
      data: { error: 'Missing --target' },
    };
  }

  let qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    const initCode = await runInit({
      target,
      qaDir: options.qaDir,
      preset: options.preset || 'generic',
      skipInstall: true,
      skipBrowser: true,
      loop: options.loop || 'none',
      lang,
      json: true,
    });
    qaDir = resolveQaDirectory(target, options.qaDir);
    if (initCode !== 0 || !qaDir) {
      return {
        ok: false,
        exitCode: initCode || 2,
        outcome: /** @type {const} */ ('blocked'),
        blockerKind: 'INIT_FAILED',
        recoverable: true,
        recoverySteps: ['Inspect target directory permissions or resolve existing root playwright.config.ts conflict.'],
        summary: `Bootstrap init failed for ${target}`,
        data: { target, initCode },
      };
    }
  }

  const repoDir = path.resolve(qaDir) === target ? path.dirname(qaDir) : target;

  // Validate or generate qa/aitest.runtime.json
  const existingRuntime = loadRuntimeConfig(qaDir);
  let runtimeConfig = existingRuntime.config;
  if (existingRuntime.exists && !existingRuntime.ok) {
    return {
      ok: false,
      exitCode: 2,
      outcome: /** @type {const} */ ('blocked'),
      blockerKind: 'INVALID_RUNTIME_CONFIG',
      recoverable: true,
      recoverySteps: ['Fix or regenerate qa/aitest.runtime.json with valid loopback URLs.'],
      summary: existingRuntime.errors[0],
      data: { qaDir, errors: existingRuntime.errors },
    };
  }
  if (!existingRuntime.exists || options.force) {
    const inferred = inferRuntimeConfigForRepo(repoDir, {
      baseUrl: options.baseUrl,
      healthPath: options.healthPath,
      port: options.port ? Number(options.port) : undefined,
    });
    const validated = validateRuntimeConfig(inferred);
    if (!validated.ok) {
      return {
        ok: false,
        exitCode: 2,
        outcome: /** @type {const} */ ('blocked'),
        blockerKind: 'NON_LOOPBACK_RUNTIME',
        recoverable: false,
        recoverySteps: ['Ensure bootstrap --base-url targets http://127.0.0.1:<port> or http://localhost:<port>.'],
        summary: validated.errors[0],
        data: { qaDir, errors: validated.errors },
      };
    }
    runtimeConfig = validated.config;
    fs.writeFileSync(existingRuntime.path, JSON.stringify(inferred, null, 2) + '\n', 'utf8');
  }

  // Install Playwright dependencies & Chromium if needed
  let depsReady = Boolean(resolvePlaywrightCli(qaDir));
  if (!depsReady && !options.skipInstall) {
    const hasLock = fs.existsSync(path.join(qaDir, 'package-lock.json'));
    const npmRes = await runNpm(
      hasLock ? ['ci', '--no-audit', '--no-fund'] : ['install', '--no-audit', '--no-fund'],
      { cwd: qaDir, inheritStdio: false }
    );
    if (npmRes.code !== 0) {
      return {
        ok: false,
        exitCode: 2,
        outcome: /** @type {const} */ ('blocked'),
        blockerKind: 'dependency-install-failed',
        recoverable: true,
        recoverySteps: [`Run "cd qa && npm install" or check npm registry connectivity.`],
        summary: 'Failed to install Playwright dependencies inside qa/.',
        data: { qaDir, stderr: npmRes.stderr.slice(0, 1000) },
      };
    }
    depsReady = Boolean(resolvePlaywrightCli(qaDir));
  }

  if (depsReady && !options.skipInstall && !options.skipBrowser) {
    const brRes = await runPlaywright(qaDir, ['install', 'chromium'], { inheritStdio: false });
    if (brRes.code !== 0) {
      return {
        ok: false,
        exitCode: 2,
        outcome: /** @type {const} */ ('blocked'),
        blockerKind: 'browser-install-failed',
        recoverable: true,
        recoverySteps: ['Run "npx playwright install chromium" inside qa/.'],
        summary: 'Chromium browser installation failed during bootstrap.',
        data: { qaDir },
      };
    }
  }

  // Record HMAC-signed .aitest/baseline-ref if missing in a git repository
  const baselineRefPath = path.join(qaDir, '.aitest', 'baseline-ref');
  let baselineRef = null;
  if (!fs.existsSync(baselineRefPath)) {
    const baseInfo = resolveDefaultDiffBase(repoDir);
    const sha = baseInfo.isGitRepo ? baseInfo.sha || resolveGitHeadSha(repoDir) : null;
    if (sha && sha !== 'nogit') {
      baselineRef = sha;
      const bootTrust = openTrustContext({ qaDir, repoDir, createKeyIfMissing: true });
      writeSignedBaselineRef(qaDir, {
        baselineRef: sha,
        strategy: baseInfo.strategy,
        repoDir,
        trustContext: bootTrust,
      });
    }
  } else {
    try {
      baselineRef = JSON.parse(fs.readFileSync(baselineRefPath, 'utf8')).baselineRef || null;
    } catch {
      baselineRef = null;
    }
  }

  // Probe target server if configured
  const mergedEnv = loadMergedQaEnv(qaDir);
  const probeBaseUrl = options.baseUrl || mergedEnv.TEST_BASE_URL || runtimeConfig?.baseURL || null;
  let serverReachable = false;
  if (probeBaseUrl && isLoopbackHttpUrl(probeBaseUrl)) {
    const probeUrl = new URL(runtimeConfig?.healthPath || '/', probeBaseUrl).toString();
    const probe = await probeHttpEndpoint(probeUrl, 1500);
    serverReachable = probe.reachable;
  }

  const canAutoBootWebServer = Boolean(runtimeConfig?.webServer?.command);
  const needsDependency = !depsReady;
  const blocked = needsDependency && !options.skipInstall;

  return {
    ok: !blocked,
    exitCode: blocked ? 2 : 0,
    outcome: /** @type {'pass' | 'blocked'} */ (blocked ? 'blocked' : 'pass'),
    blockerKind: needsDependency ? 'playwright-missing' : null,
    recoverable: true,
    recoverySteps: needsDependency
      ? [`Run bootstrap without --skip-install or execute "npm --prefix ${path.basename(qaDir)} ci".`]
      : !serverReachable && !canAutoBootWebServer && !probeBaseUrl
        ? ['Pass --base-url http://127.0.0.1:<port> or configure webServer in qa/aitest.runtime.json.']
        : [],
    summary: `Bootstrapped ${qaDir} (deps=${depsReady ? 'ready' : 'missing'}, runtimeConfig=${runtimeConfig?.webServer ? 'webServer' : runtimeConfig?.baseURL ? 'baseURL' : 'none'}, serverReachable=${serverReachable})`,
    data: {
      target: repoDir,
      qaDir,
      runtimeConfigPath: existingRuntime.path,
      runtimeConfig,
      dependenciesReady: depsReady,
      serverReachable,
      canAutoBootWebServer,
      baselineRef,
      loopbackCrudEnabled: Boolean(probeBaseUrl && isLoopbackHttpUrl(probeBaseUrl)),
    },
  };
}

/**
 * CLI handler for `bootstrap`.
 * @param {Record<string, any>} [options]
 */
export async function runBootstrapCommand(options = {}) {
  const res = await bootstrapWorkspaceCore(options);
  if (!options.json) {
    if (!res.ok) console.error(`[Bootstrap BLOCKED] ${res.summary}`);
    else console.log(`[Bootstrap OK] ${res.summary}`);
    for (const s of res.recoverySteps || []) {
      console.log(`  Recovery: ${s}`);
    }
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'bootstrap',
      outcome: res.outcome,
      ok: res.ok,
      exitCode: res.exitCode,
      summary: res.summary,
      recoverable: res.recoverable,
      blockerKind: res.blockerKind,
      recoverySteps: res.recoverySteps,
      data: res.data,
    }),
    { asJson: Boolean(options.json) }
  );
}
