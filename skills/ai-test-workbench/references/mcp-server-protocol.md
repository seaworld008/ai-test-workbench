# 原生全协议 MCP 服务端协议参考 (`mcp-serve` v6.2.1)

> [English Version](./mcp-server-protocol.en.md) · [SKILL.md](../SKILL.md) · [ADR-0001](../../../docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [ADR-0005](../../../docs/adr/0005-mcp-surface-outcome-and-config.md)

## 1. 支持的协议、传输与并发作业模型

- **支持协议版本**：`2025-11-25`（最新）、`2025-06-18`、`2025-03-26`、`2024-11-05`（根包零运行时依赖）。
- **三大传输方式**：
  1. `stdio`：`node tools/aitest.mjs mcp-serve`（或锁版本 `npx --package=ai-test-workbench@6.2.1 ai-test-workbench mcp-serve`；逐行 NDJSON JSON-RPC，长任务运行于独立子进程 `AITEST_MCP_CHILD=1`，零 `globalThis.console` 劫持）。
  2. `Streamable HTTP`：`POST / GET / DELETE /mcp`（仅 `initialize` 分配 `Mcp-Session-Id`；未知或过期会话返回 `404 Not Found`；支持空闲 TTL 与 `maxSessions` 淘汰；`2025-06-18+` 拒绝 JSON-RPC Batch）。
  3. `Legacy HTTP+SSE`：`GET /sse` + `POST /messages`（兼容 `2024-11-05`）。
- **进度流、取消与异步作业（`src/jobs.mjs`）**：
  - 传入 `_meta.progressToken` 时自动推送 `notifications/progress`。
  - 收到 `notifications/cancelled` 或调用 `aitest_job(action="cancel", jobId=...)` 时跨平台强杀子进程树（`killProcessTree`）。
  - 支持 `syncBudgetMs`：超时未完自动转后台并返回 `{ backgrounded: true, jobId }`，通过 `aitest_job(action="status"|"result", jobId=...)` 查询与获取结果。
- **安全护栏**：HTTP 模式严格校验 `Origin`（`403`）；非回环绑定强制 `crypto.timingSafeEqual` Bearer 校验（`401`）；默认 fail-closed 绑定 `--workspace-root` 上限并与客户端 `roots` 取交集，校验全部路径参数防越界；全部 `governance` 命令仅限人类本地 CLI，永不暴露为 MCP 工具。

## 2. 16 个权威内置 MCP 工具清单（自动生成）

<!-- BEGIN:GENERATED_MCP_TOOLS lang="zh" -->
| 工具名称 | 类别 | 只读提示 | 职责摘要 |
|---|---|---|---|
| `aitest_doctor` | 发现与初始化 | 是 | Environment, Browser & Gate Kernel Readiness Check |
| `aitest_init` | 发现与初始化 | 否 | Initialize Isolated QA Workspace & Governance Lock |
| `aitest_bootstrap` | 发现与初始化 | 否 | Zero-to-One Autonomous Loopback Bootstrapper |
| `aitest_explore` | 发现与初始化 | 否 | Zero-to-One Default-Deny Read-Only Explorer |
| `aitest_map_sync` | 发现与初始化 | 否 | Sync Convergent Living Code Map v4 |
| `aitest_mcp_hub` | 发现与初始化 | 否 | Manage Pinned 7-Pillar MCP Presets & Supply-Chain Doctor |
| `aitest_skill_install` | 发现与初始化 | 否 | Install Portable Agent Skill into Project |
| `aitest_verify_change` | 执行与门禁验证 | 否 | One-Call Agent Change Verification & Attested Verdict |
| `aitest_impact` | 执行与门禁验证 | 是 | Compute Dependency-Graph Diff-Impact Scope (v2) |
| `aitest_run` | 执行与门禁验证 | 否 | Execute Ledger-Bound Deterministic Playwright Suite |
| `aitest_audit` | 执行与门禁验证 | 是 | Run 4-Layer Fail-Closed Anti-Fake-Green Quality Gate |
| `aitest_diagnose` | 执行与门禁验证 | 否 | Generate Redacted Evidence-First A/B/C/D Diagnostics Report |
| `aitest_perf` | 执行与门禁验证 | 否 | Run PerformanceObserver Web Vitals & Read-Only API SLO Benchmark |
| `aitest_report` | 执行与门禁验证 | 是 | Query Reports Index, Flaky Telemetry & Requirement Traceability |
| `aitest_heal` | 有状态治理与作业 | 否 | Stateful A/B/C/D Heal Governance State Machine (begin \| attempt \| conclude \| discard) |
| `aitest_job` | 有状态治理与作业 | 否 | Inspect, Await, or Cancel Async Background MCP Jobs (status \| result \| cancel) |

> 自动生成自 `src/mcp/registry.mjs`（共 `16` 个权威工具；`governance approve` 仅限人类本地 CLI，永不注册为 MCP 工具；`v5`/`v6.1` 共 8 个旧工具名在 `v6.x` 中作为弃用转发别名保留，详见 `docs/upgrade.md`）。
<!-- END:GENERATED_MCP_TOOLS -->

## 3. Resources 与 Prompts

- **静态 Resources**：`aitest://docs/quickstart`、`aitest://skill/ai-test-workbench`、`aitest://mcp/presets`
- **动态 Resource Templates**：`aitest://project/{target}/{system-map|code-map|system-overview|diagnostics|perf-summary}`
- **Prompts (`prompts/get`)**：`first-time-onboarding`、`explore-unknown-system`、`generate-and-verify-specs`、`strict-healer-triage`、`full-link-rca-and-perf`（默认中文，支持 `lang: "en"`）。
