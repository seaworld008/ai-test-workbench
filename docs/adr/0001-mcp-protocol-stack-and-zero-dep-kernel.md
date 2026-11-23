# ADR-0001：MCP 协议栈演进与零运行时依赖内核决策

> [English Version](./0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [简体中文主文档](../../README.md) · [架构设计](../../ARCHITECTURE.md) · [优化路线图](../review/optimization-roadmap-2026-2027.md)

- **状态**：已采纳（Accepted，落地于 `v5.0.0`）
- **决策日期**：`2026-11-23`
- **关联审查项**：`F-08`、`F-09`、`M-01..M-09`、`A-01`、`R0-3`、`R1-5`

---

## 1. 背景与问题陈述

在 `v4.0` 架构审查（[architecture-code-review-2026-11.md](../review/architecture-code-review-2026-11.md)）中，我们发现手写单文件 `src/mcp-server.mjs` 在面对长耗时 Playwright/探索任务与多客户端并发时存在结构性缺陷：

1. **进程内全局串行互斥锁与控制台劫持（`F-08`）**：所有 MCP 工具调用共用一把全局锁并直接改写 `globalThis.console.*`，导致只读查询（`doctor`、`report`、`impact`）被长测试运行阻塞。
2. **缺少进度心跳、取消与异步作业协议（`F-09`、`M-02`、`M-03`）**：超过 60 秒的 `aitest_run`、`aitest_explore`、`aitest_perf` 容易被 MCP 客户端超时断开，且 `notifications/cancelled` 无法终止孤儿 Chromium 子进程树。
3. **Streamable HTTP 会话与鉴权细节偏差（`M-04`、`M-05`、`S-06`）**：非 `initialize` 请求误创建会话、未知 `Mcp-Session-Id` 未按规范返回 `404`、会话缺少 TTL 与上限淘汰、Bearer 比较未使用常量时间 `timingSafeEqual`。

围绕 `v5.0` 重构，核心架构抉择为：**引入官方 `@modelcontextprotocol/sdk` + `zod` 运行时依赖**，还是**保留根目录零运行时 npm 依赖，模块化重构自研多协议内核 + 独立子进程作业调度器（`src/jobs.mjs`）**？

---

## 2. 备选方案对比

| 评估维度 | 方案 A：迁移至 `@modelcontextprotocol/sdk` + `zod` | 方案 B（采纳）：零依赖多协议内核 v2 + 子进程 Job Runner (`src/jobs.mjs`) |
|---|---|---|
| **`npx -y ai-test-workbench` 冷启动延迟** | 需下载解析数十个传递依赖包，首次冷启动显著变慢，离线内网环境易失败 | **毫秒级启动**，根包 `dependencies` 保持 `0`，内网/离线 CI 零额外拉包 |
| **供应链攻击面** | 引入外部传递依赖树与锁文件漂移风险 | **零运行时第三方依赖**（`templates/playwright-qa` 测试依赖严格精确锁版本隔离） |
| **多协议向后兼容 (`2024-11-05` .. `2025-11-25`)** | SDK 新旧版本对 Legacy SSE 与批处理行为存在差异 | 同一内核原生精确兼容 `stdio`、`Streamable HTTP (/mcp)`、`Legacy SSE (/sse)` 四代协议协商（含 `2025-06-18+` 禁批处理规范） |
| **子进程隔离与跨平台强杀 (`taskkill /T`)** | SDK 不自带 Playwright 子进程树管理，仍需自建 Job 层 | `src/jobs.mjs` 原生把长任务隔离在独立 Node 子进程（`AITEST_MCP_CHILD=1`），完全消除 `console` 劫持并支持进程树级取消 |
| **维护成本与契约验证** | 跟随上游 SDK 升级 | 协议帧精简可控（约 700 行核心传输 + 独立契约测试套件 `test/mcp-server.test.mjs` & `test/mcp-jobs.test.mjs` 全覆盖） |

---

## 3. 最终决策

采纳 **方案 B：保持根包零第三方运行时依赖，落地 MCP 执行模型 v2（`src/mcp-server.mjs` + `src/jobs.mjs`）**：

1. **零控制台劫持的子进程作业执行器（`src/jobs.mjs`）**：
   - 写操作与长耗时工具通过独立子进程运行 `tools/aitest.mjs <cmd> --json`，`stdout` 严格隔离，彻底移除进程内 `console` 重写。
   - 支持 `syncBudgetMs`：预算内完成直接内联返回结果；超出预算自动转为后台作业并返回 `jobId`（配套 `aitest_job_status`、`aitest_job_result`、`aitest_job_cancel`）。
2. **原生进度流与取消信号传播**：
   - 解析请求 `_meta.progressToken`，实时推送 `notifications/progress`。
   - 监听 `notifications/cancelled`，调用跨平台 `killProcessTree(pid)` 清理 Chromium/Playwright 进程树。
3. **读写分级并发与工作区边界锁**：
   - 只读工具（`aitest_doctor`、`aitest_impact`、`aitest_audit`、`aitest_diagnose`、`aitest_report`、`aitest_trace_matrix` 等）完全并发无锁。
   - 写工具按 `target` 规范化路径加细粒度工作区互斥锁（`withWorkspaceWriteLock`），并强制校验 `--allowed-root` 工作区越界访问。
4. **硬化 Streamable HTTP 与安全鉴权**：
   - 仅 `initialize` 创建 `Mcp-Session-Id`；未知或过期会话严格返回 `404 Not Found`；内置会话空闲 TTL 与 `maxSessions` 上限淘汰；使用 `crypto.timingSafeEqual` 校验 Bearer Token；在 `2025-06-18` 及更新协议版本下拒绝 JSON-RPC 数组批处理。
   - **安全隔离铁律**：人工治理命令 `aitest governance approve` 永不注册为 MCP 工具，且在 `AITEST_MCP_CHILD=1` 环境下硬阻断执行。

---

## 4. 复审触发条件

若未来 MCP 规范强制要求复杂的二进制流式多路复用或内置 OAuth 2.1 动态客户端注册流程，且零依赖实现代码超过 `1,500` 行时，将启动 ADR-0002 重新评估可选插件化引入官方 SDK。
