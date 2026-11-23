# Troubleshooting Guide

| Symptom | First Check | Resolution Principle |
|---|---|---|
| Browser missing or fails to launch | `cd qa && npx playwright --version`, `npx playwright install chromium` | Keep `@playwright/test` and Chromium cache matched; never disable TLS verification |
| Windows PowerShell `.cmd` / policy error | `node -v`, `npx ai-test-workbench doctor` | Use `node tools/aitest.mjs` (invokes JS entrypoints directly via `node.exe` with `shell: false`) |
| Installed in WSL, invisible on Windows | `which node` vs `where.exe node` | Windows PowerShell and WSL have separate Node and `ms-playwright` caches; install per environment |
| `init` reports conflict on `qa/` | Existing files inside `<repo>/qa` | Pass `--qa-dir e2e-qa` rather than overwriting non-Playwright directories |
| `update-agents` exits `2` with `CONFLICT` | `*.aitest-new` files and `qa/.aitest/agents-manifest.json` | User-modified agent files were preserved; merge changes from `*.aitest-new` manually or pass `--force` |
| Online `e2e` / `api` fails immediately with Config Error | `qa/.env` -> `TEST_BASE_URL` and `TEST_ALLOWED_HOSTS` | Online suites refuse to silently skip when `TEST_BASE_URL` is blank; configure an allowlisted URL or run `--suite smoke` |
| Planner cannot explore target app | `cd qa && npm run test:seed` | Make `tests/seed.spec.ts` pass independently before starting Planner; start agent inside `qa/` |
| `eslint` fails with `Test has no assertions` on custom helper | `qa/aitest.config.json` -> `assertFunctionNames` | Prefix helper with `expect*`/`assert*`/`verify*` or register its name in `aitest.config.json` |
| Jenkins Docker reports browser mismatch | `Jenkinsfile` image tag vs `qa/package-lock.json` | Match `mcr.microsoft.com/playwright:v<exact-version>-noble` to locked `@playwright/test` version |
| Credentials leaked to `.env` or `.auth` in Git | `git status`, `qa/.gitignore` | Revoke/rotate leaked credentials immediately; keep `playwright/.auth/` and `reports/` untracked |
