# Locator, Assertion, Accessibility & Contract Standards

## 1. Always Extend the Base Fixture

Import `test`, `expect`, `expectAccessible`, and `expectApiContract` from `../fixtures/base` instead of `@playwright/test` directly:

```ts
import { test, expect, expectAccessible, expectApiContract } from '../fixtures/base';
```

This automatically activates:
- Same-origin `>= 500` response detection (`failOnServerError`, overridable via `test.use({ failOnServerError: false })`);
- Uncaught JS `pageerror` detection (`failOnPageError`, overridable via `test.use({ failOnPageError: false })`);
- Browser `page.route` AND `request` (`APIRequestContext`) blocking for `TEST_DENIED_ORIGINS` and `TEST_BLOCKED_ENDPOINTS`.

## 2. Resilient Locator Priority

1. `page.getByRole('button', { name: 'Enroll' })` — accessible role + name first.
2. `page.getByLabel('Search courses')` — form controls via explicit labels.
3. `page.getByTestId('course-row-101')` — stable `data-testid` for non-semantic or repeated widgets.
4. **Avoid**: deep CSS chains (`.app > div:nth-child(3) > button`), auto-generated utility classes, or XPath.

## 3. Structural ARIA Snapshots & Automated Axe Scans

- Prefer `await expect(page.getByRole('navigation')).toMatchAriaSnapshot(...)` over brittle pixel screenshots when verifying component hierarchy and accessible structure.
- Call `await expectAccessible(page)` on primary user-journey views to catch machine-detectable WCAG 2.0/2.1/2.2 Level A & AA regressions early. Remember that automated `axe-core` checks cover only a subset of WCAG criteria and complement—not replace—manual accessibility testing.

## 4. Custom Page-Object Assertions & ESLint Compatibility

When encapsulating assertions inside helper functions or Page Objects, prefix function names with `expect`, `assert`, or `verify` (e.g., `expectOrderConfirmed()`, `verifyCartTotal()`), or add custom patterns to `qa/aitest.config.json` under `"assertFunctionNames"` so `eslint-plugin-playwright` (`playwright/expect-expect`) recognizes them cleanly.
