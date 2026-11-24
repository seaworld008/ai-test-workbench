# QA 测试子工程使用指南 (`__PROJECT_NAME__`)

> [English Version](./README.en.md)

本目录是由 `ai-test-workbench` 初始化生成的完全隔离 Playwright QA 工作区。

## 常用快捷命令（在 `qa/` 目录执行，或通过 `aitest` MCP 工具调用）

```bash
# 1. 纯离线 Smoke 自检（无需启动业务服务器）
npm run test:smoke

# 2. TypeScript 类型检查与防假绿 ESLint 检查
npm run typecheck
npm run lint

# 3. 在线 E2E 与 API 契约套件（需在 .env 配置白名单 TEST_BASE_URL）
npm run test:e2e
npm run test:api

# 4. 对 reports/results.json 执行三层防假绿质量审计
npm run audit

# 5. 本地查看 HTML 测试报告
npm run report
```

## 配合官方 Playwright Test Agents 使用

请在 **本 `qa/` 目录内** 启动编码 Agent（`cd qa && codex` 或 `cd qa && claude`），或连接 `ai-test-workbench mcp-serve`：
1. 参考 `.env.example` 配置 `.env`（严禁填生产地址，且 `.env` 不得提交 Git）。
2. 先确保 `npm run test:seed` 单独跑通。
3. 执行 **Planner**（或 `npx ai-test-workbench@6.0.0 explore` + `npx ai-test-workbench@6.0.0 map`）→ 评审 `specs/*.md` → **Generator** 生成脚本 → `npm run audit` 审计 → **Healer** 仅允许对 A 类定位器问题在 3 轮内修复。
