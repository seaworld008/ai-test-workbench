# Pre-CI & Release Readiness Review Prompt

> [简体中文 (默认)](./review.md)

Audit `<repo>/qa/` before enabling blocking CI gates:

1. Confirm `@playwright/test` exact version in `qa/package-lock.json` matches the CI container tag (`mcr.microsoft.com/playwright:v1.65.1-noble`).
2. Confirm CI runs deterministic Playwright specs without requiring LLM API keys.
3. Confirm `REQUIRE_TEST_TARGET=1`, `TEST_ALLOWED_HOSTS`, and `TEST_DENIED_ORIGINS` block production and unconfigured runs.
4. Confirm `npm run typecheck`, `npm run lint`, and `node scripts/audit-results.mjs reports/results.json --check-specs --require-e2e` pass locally (plus `npx ai-test-workbench@6.1.0 mcp doctor` if System MCPs are configured).
5. Confirm `playwright/.auth/`, `.env`, `playwright-report/`, and `test-results/` are ignored by Git and given short CI artifact retention.
