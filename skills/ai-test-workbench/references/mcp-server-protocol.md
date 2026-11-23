# 原生全协议 MCP 服务端 v2 协议参考 (`mcp-serve` v5.0)

> [English Version](./mcp-server-protocol.en.md) · [SKILL.md](../SKILL.md) · [ADR-0001](../../../docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md)

## 1. 支持的协议、传输与并发作业模型

- **支持协议版本**：`2025-11-25`（最新）、`2025-06-18`、`2025-03-26`、`2024-11-05`（根包零运行时依赖）。
- **三大传输方式**：
  1. `stdio`：`npx -y ai-test-workbench mcp-serve`（逐行 NDJSON JSON-RPC，长任务运行于独立子进程 `AITEST_MCP_CHILD=1`，零 `globalThis.console` 劫持）。
  2. `Streamable HTTP`：`POST / GET / DELETE /mcp`（仅 `initialize` 分配 `Mcp-Session-Id`；未知或过期会话返回 `404 Not Found`；支持空闲 TTL 与 `maxSessions` 淘汰；`2025-06-18+` 拒绝 JSON-RPC Batch）。
  3. `Legacy HTTP+SSE`：`GET /sse` + `POST /messages`（兼容 `2024-11-05`）。
- **进度流、取消与异步作业（`src/jobs.mjs`）**：
  - 传入 `_meta.progressToken` 时自动推送 `notifications/progress`。
  - 收到 `notifications/cancelled` 或调用 `aitest_job_cancel` 时跨平台强杀子进程树（`killProcessTree`）。
  - 支持 `syncBudgetMs`：超时未完自动转后台并返回 `{ backgrounded: true, jobId }`。
- **安全护栏**：HTTP 模式严格校验 `Origin`（`403`）；非回环绑定强制 `crypto.timingSafeEqual` Bearer 校验（`401`）；支持 `--allowed-root` 工作区路径越界拦截；人类专属 `governance approve` 永不暴露为 MCP 工具。

## 2. 21 个内置 MCP 工具清单

| Tool Name | `readOnlyHint` | 核心职责 |
|---|---|---|
| `aitest_verify_change` | `false` | 一键终审：治理锁 → 反向依赖选测 → 账本运行 → 四层门禁 → 产出 `attestation.json` & `SARIF` |
| `aitest_doctor` | `true` | 本机 Node / Git / Codex / Claude / Chromium / Gate Kernel 体检 |
| `aitest_init` | `false` | 幂等初始化 `<repo>/qa` 并签发初始 `.aitest/governance.lock` |
| `aitest_governance_status` | `true` | 只读校验 11 个受保护治理文件的 SHA-256 状态 |
| `aitest_explore` | `false` | 默认禁写 0→1 探索（禁变更请求与 `sendBeacon`），产出 `specs/pages/*.md` |
| `aitest_map_sync` | `false` | 静态/动态路由 + 运行态 + 缺陷收敛融合生成 `SYSTEM_MAP.md`（Schema v4） |
| `aitest_impact` | `true` | Git Diff + 静态 `import` 反向依赖图受影响用例精选（含 `why`） |
| `aitest_run` | `false` | 运行 Playwright 套件并绑定 ULID `Run Ledger` 与 W3C `Trace-ID` |
| `aitest_audit` | `true` | 四层防假绿门禁（治理锁 + 静态 + 账本/豁免 + `S0–S5` 语义 Diff 守卫） |
| `aitest_diagnose` | `true` | 结构化守卫信号优先 `A/B/C/D` 定责、Redaction v2 脱敏与可观测查询 |
| `aitest_heal_begin` | `false` | 开启有状态自愈会话（硬阻断 B/C/D 类改测试，C 类自动生成缺陷工单） |
| `aitest_heal_attempt` | `false` | 执行单轮受控 A 类定位器修复（最多 3 轮，自动过语义 Diff 守卫） |
| `aitest_heal_conclude` | `false` | 结束并归档自愈会话 |
| `aitest_perf` | `false` | `PerformanceObserver` 真实 `LCP/CLS/INP`（Median+P75）+ 并发 GET API SLO |
| `aitest_trace_matrix` | `true` | `REQ-xxx` 需求 ↔ 测试 ↔ 结果覆盖率追溯矩阵 |
| `aitest_flaky_status` | `true` | 历史运行抖动率与 `.aitest/quarantine.json` 隔离状态查询 |
| `aitest_mcp_hub` | `false` | 7 大支柱锁版本 MCP 配置与 `.aitest/mcp.lock` / 投毒审计 |
| `aitest_report` | `true` | 索引 HTML / JUnit / Attestation / SARIF / 地图 / 性能 / Trace 产物 |
| `aitest_skill_install` | `false` | 安装 `SKILL.md` 到各大 AI 客户端 |
| `aitest_job_status` | `true` | 查询后台子进程作业进度与状态 |
| `aitest_job_result` / `aitest_job_cancel` | `true` / `false` | 获取后台作业结构化输出或强杀取消运行中作业（`tools/list` 精确暴露 21 个工具，见下） |

> 注：`tools/list` 注册的 21 个工具名称依次为：`aitest_doctor`、`aitest_init`、`aitest_explore`、`aitest_map_sync`、`aitest_impact`、`aitest_run`、`aitest_audit`、`aitest_governance_status`、`aitest_diagnose`、`aitest_heal_begin`、`aitest_heal_attempt`、`aitest_heal_conclude`、`aitest_perf`、`aitest_verify_change`、`aitest_trace_matrix`、`aitest_flaky_status`、`aitest_mcp_hub`、`aitest_report`、`aitest_skill_install`、`aitest_job_status`、`aitest_job_result`、`aitest_job_cancel`（含作业控制共 22 项，或通过 `tools/list` 动态枚举）。

## 3. Resources 与 Prompts

- **静态 Resources**：`aitest://docs/quickstart`、`aitest://skill/ai-test-workbench`、`aitest://mcp/presets`
- **动态 Resource Templates**：`aitest://project/{target}/{system-map|code-map|system-overview|diagnostics|perf-summary}`
- **Prompts (`prompts/get`)**：`first-time-onboarding`、`explore-unknown-system`、`generate-and-verify-specs`、`strict-healer-triage`、`full-link-rca-and-perf`（默认中文，支持 `lang: "en"`）。
