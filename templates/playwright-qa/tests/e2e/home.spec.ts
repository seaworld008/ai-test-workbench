import { test, expect } from '../fixtures/base';

test.describe('Baseline Application Readiness E2E', () => {
  test('landing page renders primary landmark without runtime crashes @scaffold', async ({ page }) => {
    const response = await page.goto('/');
    expect(response?.status()).toBeLessThan(400);

    await expect(page).toHaveTitle(/.+/);
    await expect(page.locator('main, [role="main"], h1').first()).toBeVisible();
  });
});
