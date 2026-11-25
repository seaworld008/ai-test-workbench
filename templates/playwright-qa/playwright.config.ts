import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import {
  applyEnvFileToProcess,
  assertTargetSafety,
  isLoopbackHttpUrl,
  loadRuntimeConfig,
  resolveDefaultMutationPolicy,
} from './support/target-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
applyEnvFileToProcess(path.join(__dirname, '.env'));

const runtimeCfgRes = loadRuntimeConfig(__dirname);
if (runtimeCfgRes.exists && !runtimeCfgRes.ok) {
  throw new Error(`[AI Test Workbench Runtime Config Error] ${runtimeCfgRes.errors.join(' | ')}`);
}
const runtimeCfg = runtimeCfgRes.config;
if (!process.env.TEST_BASE_URL && runtimeCfg?.baseURL) {
  process.env.TEST_BASE_URL = runtimeCfg.baseURL;
}

const safety = assertTargetSafety(process.env);
const baseURL = safety.baseURL;
const mutationDefaults = resolveDefaultMutationPolicy(process.env, baseURL);
if (process.env.TEST_ALLOW_MUTATION === undefined && mutationDefaults.allowMutation) {
  process.env.TEST_ALLOW_MUTATION = '1';
}
if (process.env.TEST_STRICT_READONLY === undefined) {
  process.env.TEST_STRICT_READONLY = mutationDefaults.strictReadonly ? '1' : '0';
}
const authStateFile = path.join(__dirname, 'playwright', '.auth', 'user.json');

// Fail early at config time if user explicitly invoked `playwright test --project=e2e|api|setup` without TEST_BASE_URL
const isTestRun = process.argv.includes('test');
const requestedOnlineProject = process.argv.some((arg) =>
  /^--project=(e2e|api|setup)$/.test(arg)
);
if (isTestRun && requestedOnlineProject && !baseURL) {
  throw new Error(
    '[AI Test Workbench Config Error] Online projects (e2e, api, setup) require TEST_BASE_URL or aitest.runtime.json baseURL. Refusing to silently skip.'
  );
}

const FORBIDDEN_WS_ENV_RE =
  /^(?:NODE_OPTIONS|NODE_EXTRA_CA_CERTS|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_.*|PATH|PATHEXT|COMSPEC|SHELL|BASH_ENV|ENV|PROMPT_COMMAND|IFS|AITEST_HMAC_.*|AITEST_MCP_.*|ACTIONS_ID_TOKEN_.*|ACTIONS_RUNTIME_TOKEN)$/i;

const sanitizedWsEnv = runtimeCfg?.webServer?.env
  ? Object.fromEntries(
      Object.entries(runtimeCfg.webServer.env).filter(([k]) => !FORBIDDEN_WS_ENV_RE.test(k))
    )
  : undefined;

const effectiveWsTargetUrl = runtimeCfg?.webServer?.url || baseURL || '';
const configuredWebServer =
  runtimeCfg?.webServer &&
  process.env.AITEST_DISABLE_WEBSERVER !== '1' &&
  isLoopbackHttpUrl(effectiveWsTargetUrl)
    ? {
        command: runtimeCfg.webServer.command,
        cwd: path.resolve(__dirname, '..', runtimeCfg.webServer.cwd || '.'),
        ...(runtimeCfg.webServer.url ? { url: runtimeCfg.webServer.url } : {}),
        timeout: runtimeCfg.webServer.timeoutMs || 45_000,
        reuseExistingServer: process.env.CI ? false : runtimeCfg.webServer.reuseExistingServer !== false,
        ...(sanitizedWsEnv && Object.keys(sanitizedWsEnv).length > 0 ? { env: sanitizedWsEnv } : {}),
      }
    : undefined;

export default defineConfig({
  testDir: './tests',
  ...(configuredWebServer ? { webServer: configuredWebServer } : {}),
  metadata: {
    runId: process.env.AITEST_RUN_ID || undefined,
    suite: process.env.AITEST_ACTIVE_SUITE || undefined,
    generatedBy: 'ai-test-workbench',
  },
  timeout: 30_000,
  expect: { timeout: 10_000 },
  globalTimeout: 45 * 60_000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'reports/junit.xml' }],
    ['json', { outputFile: 'reports/results.json' }],
  ],
  outputDir: 'test-results',
  use: {
    baseURL,
    trace: process.env.CI ? 'on-first-retry' : 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 20_000,
    ignoreHTTPSErrors: false,
    serviceWorkers: 'block',
  },
  projects: [
    {
      name: 'smoke',
      testDir: './tests/smoke',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'setup',
      testDir: './tests',
      testMatch: /.*\.setup\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'e2e',
      testDir: './tests/e2e',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        storageState: authStateFile,
      },
    },
    {
      name: 'api',
      testDir: './tests/api',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'seed',
      testDir: './tests',
      testMatch: /seed\.spec\.ts/,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
