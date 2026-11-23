# 版本与兼容性矩阵 (v4.0)

> [English Version](./VERSION.en.md) · [简体中文主文档](./README.md) · **工作台版本**：`4.0.0` · **核验日期**：`2026-11-23`

## 1. 运行时与工具链要求

| 组件 | 最低支持版本 | 推荐版本 | 本机实测版本 |
|---|---|---|---|
| **Node.js** | `>= 22.12.0`（Node 20 已 EOL） | `24 Maintenance LTS` / `26 Active LTS` | `v26.11.0` |
| **npm** | `>= 10.0.0` | `>= 11.0.0` | `11.20.0` |
| **Git** | `>= 2.35` | `>= 2.45` | `2.51.1.windows.1` |
| **MCP 协议** | `2024-11-05` | `2025-11-25`（Streamable HTTP / stdio） | `2024-11-05`..`2025-11-25` 全通过 |
| **Codex CLI** *(可选)* | `>= 0.150.0` | 最新稳定版 | `0.171.0` |
| **Claude Code** *(可选)* | `>= 2.0.0` | 最新稳定版 | `2.1.322` |

## 2. 模板精确锁死依赖清单 (`templates/playwright-qa/package.json`)

所有模板核心依赖均采用精确版本锁定（不带 `^`），确保开发机、`package-lock.json` 与 CI 容器镜像 100% 一致：

| npm 包名 | 精确锁死版本 | 核心用途 |
|---|---|---|
| `@playwright/test` | `1.65.1` | 测试运行器、Chromium、`init-agents` 与内置 `run-test-mcp-server` |
| `@axe-core/playwright` | `4.14.0` | 自动化机器可检 WCAG 2.0/2.1/2.2 A 与 AA 无障碍扫描 |
| `eslint` | `10.15.0` | 静态防假绿语法检查 |
| `eslint-plugin-playwright` | `2.12.2` | 强制执行 `expect-expect`、`no-skipped-test`、`no-wait-for-timeout` 等 |
| `typescript-eslint` | `8.73.0` | TypeScript ESLint Flat Config 解析 |
| `typescript` | `6.0.3` | 静态 `tsc --noEmit` 校验（与 `typescript-eslint@8.73.0` 严格兼容） |
| `@types/node` | `26.6.6` | Node.js 类型定义 |

> **关于 `@playwright/mcp`**：官方 Playwright Test Agents 直接使用 `@playwright/test` 自带的 `run-test-mcp-server`，**无需额外安装 `@playwright/mcp`**。

## 3. 官方 CI Docker 镜像对齐表

| `@playwright/test` 版本 | 官方 Docker 镜像 | Chromium 修订版 |
|---|---|---|
| `1.65.1` | `mcr.microsoft.com/playwright:v1.65.1-noble` | `chromium-1255` (`Chrome for Testing 159.0.8154.6`) |
