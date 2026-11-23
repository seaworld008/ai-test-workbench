import { test, expect, expectAccessible } from '../fixtures/base';

test.describe('Offline Workbench Self-Check', () => {
  test('interactive semantic DOM state transition @smoke @critical', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html lang="zh-CN">
        <head><title>AI Test Workbench Smoke</title></head>
        <body>
          <main>
            <h1>AI Test Workbench</h1>
            <p id="status" role="status">就绪</p>
            <button type="button" id="run-btn">执行自检</button>
          </main>
          <script>
            document.getElementById('run-btn').addEventListener('click', (e) => {
              e.currentTarget.textContent = '测试通过';
              document.getElementById('status').textContent = '验证完成';
            });
          </script>
        </body>
      </html>
    `);

    await expect(page.getByRole('heading', { name: 'AI Test Workbench' })).toBeVisible();
    await page.getByRole('button', { name: '执行自检' }).click();
    await expect(page.getByRole('button', { name: '测试通过' })).toBeVisible();
    await expect(page.getByRole('status')).toHaveText('验证完成');
  });

  test('structural ARIA snapshot verification @smoke', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html lang="en">
        <head><title>ARIA Snapshot Check</title></head>
        <body>
          <nav aria-label="Primary">
            <ul>
              <li><a href="#courses">Courses</a></li>
              <li><a href="#enrollments">My Enrollments</a></li>
            </ul>
          </nav>
          <main>
            <h1>Course Portal</h1>
          </main>
        </body>
      </html>
    `);

    await expect(page.getByRole('navigation', { name: 'Primary' })).toMatchAriaSnapshot(`
      - navigation "Primary":
        - list:
          - listitem:
            - link "Courses"
          - listitem:
            - link "My Enrollments"
    `);
  });

  test('automated axe WCAG 2.2 AA check on semantic markup @smoke @a11y', async ({ page }) => {
    await page.setContent(`
      <!DOCTYPE html>
      <html lang="en">
        <head><title>Accessible Form Smoke</title></head>
        <body>
          <main>
            <h1>Student Sign In</h1>
            <form aria-label="Sign In Form">
              <label for="username">Username</label>
              <input id="username" name="username" type="text" autocomplete="username" />
              <button type="submit">Sign In</button>
            </form>
          </main>
        </body>
      </html>
    `);

    await expectAccessible(page);
  });
});
