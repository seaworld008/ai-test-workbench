import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';
import { assertTargetSafety, loadEnvFileIfPresent } from './support/target-guard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnvFileIfPresent(path.join(__dirname, '.env'));

const safety = assertTargetSafety(process.env);
const baseURL = safety.baseURL;
const authStateFile = path.join(__dirname, 'playwright', '.auth', 'user.json');

// Fail early at config time if user explicitly invoked `playwright test --project=e2e|api|setup` without TEST_BASE_URL
const isTestRun = process.argv.includes('test');
const requestedOnlineProject = process.argv.some((arg) =>
  /^--project=(e2e|api|setup)$/.test(arg)
);
if (isTestRun && requestedOnlineProject && !baseURL) {
  throw new Error(
    '[AI Test Workbench Config Error] Online projects (e2e, api, setup) require TEST_BASE_URL to be configured. Refusing to silently skip.'
  );
}

export default defineConfig({
  testDir: './tests',
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
