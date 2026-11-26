# ADR-0001：MCP 零运行时依赖协议栈与官方合规门禁

> [English Version](./0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [简体中文主文档](../../README.md) · [架构设计](../../ARCHITECTURE.md) · [v6.0 重构评估](../review/v6-refactor-assessment.md)

- **状态**：已采纳（Accepted；`v5.0.0` 落地，`v6.0.0` 合并原 `mcp-zero-dependency` 并收敛至 17 工具）
- **决策日期**：`2026-11-24`

---

## 1. 背景与问题陈述

`ai-test-workbench` 以 CLI 和原生 MCP 服务端两种形态分发给本地 AI 编码 Agent 及 CI 流水线。核心架构抉择是：**在根包运行时引入 `@modelcontextprotocol/sdk` + `zod`**，还是**保持根包运行时零第三方依赖（`dependencies: {}`），在 `src/mcp/` 内维护模块化轻量协议栈并用隔离的官方合规套件做门禁**。

---

## 2. 备选方案对比

| 评估维度 | 方案 A：根包运行时依赖 `@modelcontextprotocol/sdk` + `zod` | 方案 B（采纳）：零运行时依赖 `src/mcp/` + 隔离 `conformance/` 官方门禁 |
|---|---|---|
| **`npx` 冷启动与离线内网** | 需下载解析数十个传递依赖，弱网/气隙环境易失败 | 根包 `dependencies` 为空，毫秒冷启动且零传递依赖风险 |
| **供应链攻击面** | 承担上游传递依赖 CVE 与锁文件漂移风险 | 运行时零第三方依赖；仅 `devDependencies` 与隔离 `conformance/` 锁定精确开发版本 |
| **多协议向后兼容** | SDK 对 Legacy SSE、Streamable HTTP 与 `2025-06-18+` 禁批处理的版本行为随主版本变动 | 单一模块化内核稳定协商 `2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25` |
| **子进程隔离与进程树取消** | SDK 不自带 Playwright 子进程树清理，仍需自建 Job 层 | `src/jobs.mjs` 原生隔离长耗时任务、推送进度并支持跨平台进程树强杀 |
| **协议互操作性保证** | 依赖 SDK 自身实现 | 隔离 `conformance/` 锁定 `@modelcontextprotocol/conformance@0.1.16` 与 `@modelcontextprotocol/sdk@1.32.2` 在 CI 实测全部三种传输 |

---

## 3. 最终决策

采纳 **方案 B**：

1. **根包零运行时依赖**：`package.json` 不含 `dependencies`，`src/mcp/` 按职责拆分为 `protocol.mjs`、`registry.mjs`、`tools/{shared,discovery,verification,stateful}.mjs`、`resources.mjs`、`security.mjs`、`transport-stdio.mjs`、`transport-http.mjs`（单文件均 `<= 500` 行，零循环依赖）。
2. **隔离的官方合规与参考客户端测试**：在独立的 `conformance/` 子目录中运行官方 `@modelcontextprotocol/conformance` 场景以及 `@modelcontextprotocol/sdk` 参考客户端三传输测试（`StdioClientTransport`、`StreamableHTTPClientTransport`、`SSEClientTransport`），并在 CI 的 `mcp-conformance` 任务中强制把关。
3. **特权隔离铁律**：人工治理审批命令 `npx ai-test-workbench@6.5.0 governance approve` 永不注册到 `src/mcp/registry.mjs`，且在 `AITEST_MCP_CHILD=1` 环境下硬阻断。

---

## 4. 复审触发条件

若未来出现以下任一条件，将重新评估在可选包或主包中迁移至官方 SDK：

1. MCP 规范强制要求 OAuth 2.1 动态客户端注册、Elicitation、Sampling 或 MCP Tasks 协议，且自维护协议栈代码超过 `1,500` 行；
2. 官方 `@modelcontextprotocol/conformance` 出现无法在轻量协议层 cleanly 修复的协议不兼容缺口。
