# 更新日志 (Changelog)

> [English Changelog](./CHANGELOG.en.md) · [简体中文主文档](./README.md)

本日志遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与 [语义化版本 (SemVer)](https://semver.org/spec/v2.0.0.html) 规范。

## [4.0.0] - 2026-11-23

### 新增 (Added)
- **AI Agent 优先原生全协议 MCP 服务端（`src/mcp-server.mjs` & `aitest mcp-serve` / `aitest mcp serve`）**：
  - 零第三方依赖完整实现 **MCP `2025-11-25` / `2025-06-18` / `2025-03-26` / `2024-11-05`** 四版协议协商与 **`stdio` / Streamable HTTP (`/mcp`) / Legacy HTTP+SSE (`/sse` + `/messages`)** 三大传输模式。
  - 暴露 **12 个强类型 MCP 工具**（含 `inputSchema`、`outputSchema`、`ToolAnnotations` 与包含 `nextRecommendedActions` 的 `structuredContent`）、静态与动态 **Resources / Resource Templates**、中英双语 **Prompts**、`ping` 与 `logging/setLevel`。
  - HTTP 模式强制执行 `Origin` DNS 重绑定防御（`403`）与非回环网卡 `--auth-token` / `AITEST_MCP_TOKEN` Bearer 校验（`401`）；`stdio` 模式通过 `AITEST_MCP_CAPTURED_STDIO=1` + 异步互斥锁防止 `playwright` / `npm` 子进程输出污染 FD 1。
- **AI Agent 发现与全仓双语文档体系**：
  - 新增 `AGENTS.md` / `AGENTS.en.md`、`CLAUDE.md`、`llms.txt`、`docs/ai-agent-quickstart.md` / `.en.md`、`prompts/first-time-ai-agent.md` / `.en.md` 与 `skills/ai-test-workbench/references/mcp-server-protocol.md`。
  - 全仓所有 `.md` 统一调整为 **默认中文显示 + 完整配对 `.en.md` 英文镜像**，新增 `scripts/check-docs-and-hygiene.mjs`（`npm run lint:docs`）纳入 CI 强制检查链接有效性与去敏合规。
- **7 大支柱 MCP 编排自举 (`src/mcp-hub.mjs`)**：新增第 7 大支柱 `orchestrator` 与 `ai-test-workbench` 自研 MCP 预设。

### 优化与修复 (Improved & Fixed)
- 补齐 `src/diagnose.mjs` 与 `src/skill-install.mjs` 的 `--json` 结构化输出，新增 `.gemini/skills/` 与 `.github/skills/` 安装目标；为 `diagnose.mjs` 数据库表名建议增加正则标识符安全过滤；扩展 `src/report.mjs` 统一索引 `SYSTEM_MAP.md`、`code-map.json`、`system-overview.md` 与性能报告。
- 更新总架构蓝图至 **v4.0** 并补充 `docs/architecture-and-prompts-blueprint.en.md` 英文版，完整涵盖 6 段首次接入与全链路实战提示词。

## [3.0.0] - 2026-11-23

### 新增 (Added)
- **自演进活体代码知识图谱（`aitest map` / `src/codemap.mjs`）**：扫描宿主路由（含懒加载断链检测）、API 调用、Controller 与 Prisma/SQL/ORM 表并融合运行态拓扑、测试结果与性能报告输出 `knowledge/SYSTEM_MAP.md`，非破坏式更新 `impact-map.json`。
- **6 大支柱全链路只读 MCP 中枢（`aitest mcp` / `src/mcp-hub.mjs`）**：生成与安全审计 `.mcp.json` / `.codex/config.toml`（Grafana `--disable-write`、Prometheus、Loki、Sentry、只读 Postgres/MySQL、Redis `--readonly`、k6、OpenAPI）。
- **CDP Web Vitals 与并发 GET API SLO 引擎（`aitest perf` / `src/perf.mjs`）**：采集 TTFB/FCP/LCP/CLS/DOM/JSHeap 与接口 P50/P90/P95/P99/RPS。
- **Trace-ID 根因定位贯通**：`base.ts` 自动记录分布式链路头并在 `diagnose.mjs` 中生成 CodeMap 与可观测查询建议。

## [2.1.0] - 2026-11-23

### 新增 (Added)
- **从 0 到 1 只读全站探索引擎（`aitest explore` / `src/explore.mjs`）**：在只读写入护栏下发现多租户/多端切换器、路由、表格筛选及接口参数脱敏，产出 `system-topology.json` 与 `specs/system-overview.md`。

## [2.0.0] - 2026-11-23

### 新增 (Added)
- **开源可复用 CLI (`ai-test-workbench`)**、官方 **Playwright Test Agents** SHA-256 冲突管理、**三层防假绿门禁**、**4 层扩展 Fixture**、**交互式登录捕获 (`auth-login`)**、**Diff-Impact (`impact`)** 与零依赖智慧校园演示靶场 (`demo-campus`)。
