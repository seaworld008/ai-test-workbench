import { test, expect } from '../fixtures/base';

test.describe('Baseline HTTP & Header Contract', () => {
  test('target entrypoint responds cleanly with expected content-type @critical', async ({ request }) => {
    const healthPath = process.env.E2E_API_HEALTH_PATH?.trim() || '/';
    const response = await request.get(healthPath);

    expect(response.status()).toBeLessThan(400);
    const contentType = response.headers()['content-type'] || '';
    expect(contentType.length).toBeGreaterThan(0);
  });
});
