# Locator, Assertion, Accessibility & Contract Standards

> [简体中文 (默认)](./locator-and-assertion-rules.md) · [SKILL.md](../SKILL.md)

## 1. Always Extend the Base Fixture

```ts
import { test, expect, expectAccessible, expectApiContract, expectPerformanceBudget } from '../fixtures/base';
```

Automatically enables same-origin `5xx` failure detection, uncaught `pageerror` trapping, dual-surface endpoint/origin blocks, and passive Trace-ID capture.

## 2. Resilient Locator Priority

1. `getByRole(...)` -> 2. `getByLabel(...)` -> 3. `getByTestId(...)`. Avoid brittle deep CSS chains or XPath.

## 3. ARIA Snapshots, Axe Scans & Custom Assertions

- Prefer `toMatchAriaSnapshot(...)` over pixel snapshots; call `await expectAccessible(page)` on key journeys (remembering automated scans complement—not replace—manual WCAG audits).
- Prefix Page Object assertion helpers with `expect*`, `assert*`, or `verify*` (or register them in `qa/aitest.config.json`).
