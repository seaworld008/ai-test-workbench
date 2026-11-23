import { test, expect } from './fixtures/base';

/**
 * Official entry point for Playwright Test Agents (`Planner`).
 * Run individually via `npx playwright test --project=seed` or automatically by `planner_setup_page`.
 * Neverperforms irreversible backend mutations.
 */
test('seed environment bootstrap @seed', async ({ page, baseURL }) => {
  if (!baseURL) {
    throw new Error(
      'Seed test requires TEST_BASE_URL in .env (pointing to an allowlisted local/staging environment) before running Planner.'
    );
  }

  await page.goto('/');
  await expect(page.locator('body')).toBeVisible();
});
