# 架构设计与安全边界 (`ai-test-workbench` v4.0)

> [English Version](./ARCHITECTURE.en.md) · [简体中文主文档](./README.md) · [AGENTS.md](./AGENTS.md)

## 1. 两阶段执行模型：AI Agent 创作期 vs 确定性回归期

`ai-test-workbench` 严格隔离**测试创作/自愈阶段**与**确定性回归阶段**：

1. **创作与修复阶段（AI Agent 优先 + MCP 协议驱动）**：
   - 通过原生 **`ai-test-workbench mcp-serve`**（兼容 `stdio` / `Streamable HTTP (/mcp)` / `Legacy SSE (/sse)`，支持 MCP `2024-11-05` 至 `2025-11-25+`）与 Playwright 内置 `run-test-mcp-server` 协同 Claude Code、Codex CLI、Cursor、Copilot、Gemini CLI、Antigravity。
   - **12 个强类型 MCP 工具**均声明 `outputSchema` 与 `ToolAnnotations`，向 Agent 返回 `{ ok, exitCode, tool, summary, data, nextRecommendedActions }`；在 `stdio` 模式下通过 `AITEST_MCP_CAPTURED_STDIO=1` + 异步控制台互斥锁严格屏蔽子进程与日志对标准输出 FD 1 的干扰。
2. **确定性回归阶段（Deterministic Runner）**：
   - 本地提交前、PR、GitHub Actions、Jenkins 与 GitLab CI 直接执行静态 TypeScript 测试。
   - 回归阶段**零大模型调用、零模型 API 密钥依赖**，测试结果可确定性复现。

## 2. 跨项目物理隔离 (`<repo>/qa/`)

每个业务仓库（Next.js、Vue/H5、React、Java/Spring Cloud、PHP/ThinkPHP）获得完全独立的 `<repo>/qa/` 子工程，拥有独立的 `package.json`、`package-lock.json`、`.env`（已忽略）、`playwright/.auth/`、`specs/`、`tests/`、`knowledge/`、`impact-map.json`、`waivers.json` 与 `reports/`，并在 `init` 时探测宿主工程 `tsconfig.json` / `eslint.config.*` 通配重叠风险。

## 3. 单一真源双端安全守卫 (`support/target-guard.mjs`)

1. **环境与目标域名硬阻断**：`playwright.config.ts`、`tests/fixtures/base.ts` 与 CLI（`src/origin-guard.mjs`）共用同一套零依赖守卫，拒绝 `TEST_ENV=production|prod|live|online` 与通配符域名，强制 `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`。
2. **浏览器 + API + Service Worker 三重接口拦截**：`TEST_BLOCKED_ENDPOINTS` 同时拦截 `page.route` 与 `Proxy` 包装后的 `APIRequestContext`，并设置 `serviceWorkers: 'block'`。
3. **写操作隔离策略 (`@mutation`)**：默认 `TEST_ALLOW_MUTATION=0` 时自动 `--grep-invert=@mutation` 排除并在 `audit-results.mjs` 单独列明 `policyExcludedMutation`，绝不混入 `passed`。
4. **MCP HTTP 安全边界**：Streamable HTTP 与 Legacy SSE 服务端默认仅监听 `127.0.0.1`、强制校验 `Origin`（非允许 Origin 返回 `403` 防 DNS 重绑定），绑定非回环网卡时强制要求 `--auth-token` / `AITEST_MCP_TOKEN`（`401`）。

## 4. 三层防假绿质量门禁 (`scripts/audit-results.mjs`)

- **静态门禁**：`tsc --noEmit` + `eslint-plugin-playwright`（强制 `expect-expect`、`no-skipped-test`、`no-focused-test`、`no-wait-for-timeout`、`no-force-option`、`prefer-web-first-assertions`、`no-conditional-in-test`）。
- **运行时门禁**：严拆 `passed`、`failed`、`flaky`、`skipped`、`policyExcludedMutation`，校验证照过期的 `waivers.json`（含 `owner` / `reason` / `expiresAt`），支持 `--require-e2e` 与零用例失败保护。
- **Healer Diff 守卫 (`--diff-base`)**：禁止修复提交中出现净断言数下降、新增 `skip/fixme/only`、`{ force: true }`、空 `.catch(() => {})` 或膨胀超时（`>= 60000ms`）。

## 5. 活体代码地图、7 大支柱 MCP 中枢与全链路性能/RCA (v4.0)

- **活体代码与系统知识地图（`src/codemap.mjs` → `knowledge/code-map.json` + `SYSTEM_MAP.md`）**：融合源码路由/懒加载断链/Controller/SQL 与 Prisma 表 + 运行态探索 + 测试结果 + 性能报告，非破坏式刷新 `impact-map.json`。
- **7 大支柱全链路 MCP 中枢（`src/mcp-hub.mjs`）**：编排自研服务（`orchestrator`）、浏览器/CDP（`browser`）、可观测与崩溃（`observability`：`grafana --disable-write`、`prometheus`、`loki`、`sentry`）、数据库（`database`：`postgres-readonly`、`mysql-readonly`）、中间件（`middleware`：`redis-readonly --readonly`）、性能（`performance`：`k6`）与契约（`api-contract`：`openapi-contract`），并由 `aitest mcp doctor` 强制审计只读开关与环境变量占位符。
- **Trace-ID 根因定位与性能 SLO（`src/perf.mjs` / `base.ts` / `src/diagnose.mjs`）**：捕获分布式链路头（`traceparent`、`x-trace-id`、`x-request-id`、`sw8`、`eagleeye-traceid`），结合 `perf-budget.json` 校验浏览器 CDP Web Vitals 与并发 GET API `P50/P90/P95/P99/RPS`，对 DB 表名做正则校验后输出可直接执行的排障查询语句。
