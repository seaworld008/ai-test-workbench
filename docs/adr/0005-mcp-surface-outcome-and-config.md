# ADR-0005：MCP 工具面收敛（21 -> 17）、统一结果模型与集中式配置层

> [English Version](./0005-mcp-surface-outcome-and-config.en.md) · [简体中文主文档](../../README.md) · [升级指南](../upgrade.md)

- **状态**：已采纳（Accepted，落地于 `v6.0.0`）
- **决策日期**：`2026-11-24`

---

## 1. 背景与问题陈述

在 `v5.1.1` 中，协议与接口层存在四类耦合与不一致问题：

1. `mcp-hub.mjs` 与 `mcp-server.mjs` / `mcp/protocol.mjs` / `mcp/resources.mjs` 存在 4 条循环导入，且 `protocol.mjs` 硬编码 `aitest_job_*` 与 `aitest_mcp_hub` 逻辑；
2. `tools/list` 暴露 21 个工具，其中 6 个属于同一状态机动作拆分（`heal_begin/attempt/conclude` 与 `job_status/result/cancel`）；
3. `cli.mjs` 使用 89 个全局平铺参数，跨命令传错旗标被静默忽略；
4. `process.env` 与 `aitest.config.json` 散落各模块，且存在 6 处 fail-open 缺口与退出码不统一问题。

---

## 2. 最终决策

1. **环路清零与工具面收敛（21 -> 17）**：
   - 抽离纯数据模块 `src/mcp-hub/catalog.mjs`，将 `mcp serve` 路由移至 `src/cli/commands.mjs`，实现 `src/**` 零循环导入（由单测强执）。
   - 将 `src/mcp/registry.mjs` 拆分为 `src/mcp/tools/{shared,discovery,verification,stateful}.mjs`，支持声明式 `execute(args, ctx)` 与 `validateExtra(args)` 钩子，清除 `protocol.mjs` 内硬编码分支。
   - 合并为 `aitest_heal(action: "begin"|"attempt"|"conclude")` 与 `aitest_job(action: "status"|"result"|"cancel")`，`tools/list` 收敛至 **17 个权威工具**；`tools/call` 在整个 `v6.x` 保留 6 个旧工具名自动转发并附带 `data._deprecation` 与 `summary` 弃用告警。
2. **按命令严格 CLI 参数表（`src/cli/commands.mjs`）**：
   - 22 个子命令各自声明允许的参数集合，传入无关旗标直接退出码 `1` 并提示拼写建议；同时在 `governance` 上保留 `--approver -> --by` 的 `v6.x` 弃用告警别名。
3. **统一 `Outcome` / 退出码与集中配置层**：
   - 新建 `src/core/outcome.mjs` 统一三态 `pass | fail | blocked` 与退出码 `0 | 1 | 2`（修复 `runner --audit` 遇 `blocked` 返回 `1` 的缺陷，补齐 `init --json`）。
   - 新建 `src/core/config.mjs` 集中加载并按 JSON Schema 校验 `TEST_*`、`AITEST_*`、`.env` 与 `aitest.config.json`，封堵 6 处 fail-open 缺口。

---

## 3. 兼容与迁移路径

所有破坏性变更及 `v6.x` 兼容别名均完整记录于 [docs/upgrade.md](../upgrade.md)，弃用别名将在 `v7.0.0` 移除。
