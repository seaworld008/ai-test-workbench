# 原生全协议 MCP 服务端协议参考 (`mcp-serve` v4.0)

> [English Version](./mcp-server-protocol.en.md) · [SKILL.md](../SKILL.md)

## 1. 支持的协议与传输模式

- **支持协议版本**：`2025-11-25`（最新）、`2025-06-18`、`2025-03-26`、`2024-11-05`
- **支持传输方式**：
  1. `stdio`：`npx -y ai-test-workbench mcp-serve`（逐行 NDJSON JSON-RPC；内置 `AITEST_MCP_CAPTURED_STDIO=1` 阻止内部日志与子进程输出污染 `stdout`）
  2. `Streamable HTTP`：`POST / GET / DELETE /mcp`（支持 `Mcp-Session-Id`、`MCP-Protocol-Version`、JSON-RPC Batch、`application/json` 与 `text/event-stream` 双协商）
  3. `Legacy HTTP+SSE`：`GET /sse`（下发 `/messages?sessionId=...`）+ `POST /messages`（返回 `202 Accepted` 并经 SSE 推送）
- **安全护栏**：HTTP 模式严格校验 `Origin`（防 DNS 重绑定，非法返回 `403`）；非回环地址强制要求 `--auth-token` / `AITEST_MCP_TOKEN`（`401`）。

## 2. 12 个内置 MCP 工具与风险标注

| Tool Name | `readOnlyHint` | `destructiveHint` | 核心职责 |
|---|---|---|---|
| `aitest_doctor` | `true` | `false` | 本机 Node / Git / Codex / Claude / Chromium 体检 |
| `aitest_init` | `false` | `false` | 幂等初始化 `<repo>/qa`（支持 `dryRun`） |
| `aitest_explore` | `true` | `false` | 0→1 只读探索与多端切换器测绘 |
| `aitest_map_sync` | `false` | `false` | 静态代码 + 运行态 + 测试结果融合生成 `SYSTEM_MAP.md` |
| `aitest_impact` | `true` | `false` | Git Diff 受影响用例精选 |
| `aitest_run` | `false` | `false` | 运行 Playwright 套件并过三层防假绿审计 |
| `aitest_audit` | `true` | `false` | 三层静态 / 运行时 / Healer Diff 守卫审计 |
| `aitest_diagnose` | `true` | `false` | 脱敏诊断、Trace-ID 提取与建议 A/B/C/D 分类 |
| `aitest_perf` | `true` | `false` | CDP Web Vitals + 并发 GET API P50/P95/RPS |
| `aitest_mcp_hub` | `false` | `false` | 7 大支柱 MCP 配置（`presets` / `add` / `doctor`） |
| `aitest_report` | `true` | `false` | 索引 HTML / JUnit / 地图 / 性能 / Trace 产物 |
| `aitest_skill_install` | `false` | `false` | 安装 `SKILL.md` 到各大 AI 客户端 |

所有工具均声明 `outputSchema` 并返回标准化 `structuredContent`：`{ ok, exitCode, tool, summary, data, nextRecommendedActions }`。

## 3. Resources 与 Prompts

- **静态 Resources**：`aitest://docs/quickstart`、`aitest://skill/ai-test-workbench`、`aitest://mcp/presets`
- **动态 Resource Templates**：`aitest://project/{target}/{system-map|code-map|system-overview|diagnostics|perf-summary}`（传 `--target` 启动时同步暴露 `aitest://current/*`）
- **Prompts (`prompts/get`)**：`first-time-onboarding`、`explore-unknown-system`、`generate-and-verify-specs`、`strict-healer-triage`、`full-link-rca-and-perf`（默认中文，可传 `lang: "en"`）。
