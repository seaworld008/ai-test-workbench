# 合入 CI 与发版前质量审查提示词 (`review.md`)

> [English Version](./review.en.md)

在启用阻塞式 CI 门禁或准备发版前，请按下列条目审计 `<repo>/qa/`：

1. 确认 `qa/package-lock.json` 中 `@playwright/test` 精确版本与 CI Docker 镜像标签（如 `mcr.microsoft.com/playwright:v1.65.1-noble`）完全匹配。
2. 确认 CI 执行静态确定性 TypeScript 用例，零大模型 API 密钥依赖。
3. 确认 `REQUIRE_TEST_TARGET=1`、`TEST_ALLOWED_HOSTS` 与 `TEST_DENIED_ORIGINS` 能有效拦截生产环境与未配置 URL 运行。
4. 确认本地通过 `npm run typecheck`、`npm run lint` 与 `node scripts/audit-results.mjs reports/results.json --check-specs --require-e2e`（以及有系统 MCP 时通过 `npx ai-test-workbench@5.1.1 mcp doctor`）。
5. 确认 `playwright/.auth/`、`.env`、`playwright-report/` 与 `test-results/` 已被 `.gitignore` 忽略，且 CI 归档已配置最短留存天数与访问权限。
