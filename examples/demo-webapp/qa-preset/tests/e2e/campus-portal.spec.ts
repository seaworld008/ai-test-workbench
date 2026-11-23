import { test, expect, expectAccessible } from '../fixtures/base';

test.describe('Smart Campus Course Portal E2E', () => {
  test('[REQ-CATALOG-001] catalog search, sold-out indicator, and automated axe check @critical @a11y', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toContainText('Smart Campus');
    await expectAccessible(page);

    const searchBox = page.getByLabel('Search courses');
    await searchBox.fill('Playwright');
    await expect(page.getByRole('listitem').filter({ hasText: 'Playwright Architecture' })).toBeVisible();

    await searchBox.fill('Sold Out');
    await expect(page.getByRole('button', { name: 'Sold Out' })).toBeDisabled();
  });

  test('[REQ-RBAC-001] student role is denied access to admin console @critical', async ({ page }) => {
    const response = await page.goto('/admin');
    expect(response?.status()).toBe(403);
    await expect(page.getByRole('heading', { name: '403 Forbidden' })).toBeVisible();
  });
});
