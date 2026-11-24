# Troubleshooting Guide

> [简体中文 (默认)](./troubleshooting.md) · [English README](../README.en.md)

| Symptom | First Check | Resolution Principle |
|---|---|---|
| Browser missing or fails to launch | `cd qa && npx playwright --version`, `npx playwright install chromium` | Keep `@playwright/test` and Chromium cache matched |
| Windows `.cmd` `spawn EINVAL` | `node -v`, `npx ai-test-workbench@6.1.0 doctor` | CLI invokes JS entrypoints via `process.execPath` with `shell: false` |
| WSL vs Windows browser mismatch | `which node` vs `where.exe node` | Maintain separate caches per OS environment |
| `init` conflict exit `2` | Existing non-Playwright files in `<repo>/qa` | Pass `--qa-dir e2e-qa` |
| `update-agents` exit `2` (`CONFLICT`) | `*.aitest-new` & `agents-manifest.json` | Review/merge manually or pass `--force` |
| Online `e2e`/`api` Config Error | `qa/.env` `TEST_BASE_URL` & `TEST_ALLOWED_HOSTS` | Configure allowlisted staging URL or run `--suite smoke` |
| MCP HTTP `403` / `401` | `Origin` header / Bearer token | Set `AITEST_MCP_ALLOWED_ORIGINS` or pass `--auth-token` |
| Custom helper ESLint `expect-expect` | `qa/aitest.config.json` `assertFunctionNames` | Prefix `expect*`/`assert*`/`verify*` or register in config |
| Jenkins Docker mismatch | `Jenkinsfile` image tag vs `package-lock.json` | Match `mcr.microsoft.com/playwright:v<exact>-noble` |
