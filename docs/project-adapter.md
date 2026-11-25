# 多技术栈项目适配指南 (`project-adapter.md`)

> [English Version](./project-adapter.en.md) · [简体中文主文档](../README.md)

## 1. Next.js / Vue / React / 现代 H5 (`<repo>/qa/`)

- 将 Playwright 与 ESLint 依赖隔离在 `<repo>/qa/package.json`，绝不修改宿主工程 Vite/Next/Webpack 构建配置。
- 如宿主根 `tsconfig.json` 或 `eslint.config.*` 通配包含 `qa/**`，按 `npx ai-test-workbench@6.2.1 init` 提示在宿主配置中 `exclude`/`ignores` 排除 `qa/**`。
- 通过 `npx ai-test-workbench@6.2.1 map` 自动扫描路由并补充 `qa/impact-map.json` 将 `src/views/**`、`src/pages/**`、`src/api/**` 映射到 `tests/e2e/` 与 `tests/api/`。

## 2. Java / Spring Cloud (`<repo>/qa/` 或独立 QA 仓)

- Playwright 负责跨服务 UI 闭环与 HTTP 接口契约测试（`tests/api/`），与 JUnit / MockMvc 互补而非替代。
- 严禁将高权限写库凭据放入 `qa/.env`；后端状态校验优先采用只读 API 或通过 `npx ai-test-workbench@6.2.1 mcp add --profile data-verify` 接入只读数据库 MCP。
- 超高并发防超卖与分布式事务需借助后端并发压测或 k6 MCP 配合验证。

## 3. PHP / ThinkPHP (`<repo>/qa/`)

- Playwright 通过 HTTP(S) 与服务端通信，与宿主 PHP 版本完全解耦，不会干扰现有 PHPUnit 套件。
- 如 `<repo>/qa` 已被手工文档占用，可传 `--qa-dir e2e-qa` 避免冲突。

## 4. 移动端 H5 Web vs 原生 App / 小程序边界

- Playwright 设备模拟（`Pixel 7`、`iPhone 14`）用于**移动端浏览器 H5 Web 应用**。
- 微信小程序原生容器与 iOS/Android 原生二进制壳能力超出 Playwright Web 范畴，需配合专用原生端自动化工具。
