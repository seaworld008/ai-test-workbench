# QA Subproject Guide (`__PROJECT_NAME__`)

> [简体中文 (默认)](./README.md)

This directory is an isolated Playwright QA workspace initialized by `ai-test-workbench`.

## Quick Commands (run inside `qa/`)

```bash
# 1. Offline smoke check (no business server required)
npm run test:smoke

# 2. Typecheck & anti-fake-green lint
npm run typecheck
npm run lint

# 3. Online E2E & API suites (requires allowlisted TEST_BASE_URL in .env)
npm run test:e2e
npm run test:api

# 4. Run quality gate on generated reports/results.json
npm run audit

# 5. View HTML report locally
npm run report
```

## Using Official Playwright Test Agents

Start your coding agent **from inside this `qa/` directory** (`cd qa && codex` or `cd qa && claude`) or connect `ai-test-workbench mcp-serve`:
1. Configure `.env` from `.env.example` using a non-production staging/local URL and dedicated QA test credentials.
2. Verify `npm run test:seed` passes.
3. Run **Planner** -> review `specs/*.md` -> run **Generator** -> verify with `npm run audit` -> use **Healer** only for confirmed Class-A test locator/timing fixes (max 3 attempts).
