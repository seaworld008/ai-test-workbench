# 版本与兼容性矩阵 (v6.7.0)

> [English Version](./VERSION.en.md) · [简体中文主文档](./README.md) · **工作台与门禁内核版本**：`6.7.0`（单一真源：`src/core/version.mjs`） · **核验日期**：`2026-11-27`

## 1. 运行时与工具链要求

| 组件 | 最低支持版本 | 推荐版本 | 本机实测版本 |
|---|---|---|---|
| **Node.js** | `>= 22.12.0`（Node 20 已 EOL） | `24 Maintenance LTS` / `26 Active LTS` | `v26.11.0` |
| **npm** | `>= 10.0.0` | `>= 11.0.0` | `11.20.0` |
| **Git** | `>= 2.35` | `>= 2.45` | `2.51.1.windows.1` |
| **MCP 协议** | `2024-11-05` | `2025-11-25`（Streamable HTTP / stdio / Legacy SSE） | `2024-11-05`..`2025-11-25` 全通过 |
| **Graph Sidecar (`codebase-memory-mcp`)** *(可选)* | `0.12.1`（精确锁版 + SHA-256） | `0.12.1`（`--ui=false` + 短路径隔离） | `0.12.1`（Live `8/8` 通过） |
| **Codex CLI** *(可选)* | `>= 0.150.0` | 最新稳定版 | `0.171.0` |
| **Claude Code** *(可选)* | `>= 2.0.0` | 最新稳定版 | `2.1.322` |

## 2. Schema 版本契约 (`src/core/version.mjs`)

| 工件类型 | 当前 Schema 版本 | 对应模块 |
|---|---|---|
| **Gate Kernel** | `6.7.0` | 权威源码 `src/kernel/gate-kernel.mjs`（18 条可插拔规则 `AITEST-G101..G118` + 经治理锁校验的声明式 `qa/support/project-rules.json`，治理锁同步封签 `.aitest/mcp.lock` 与 `.aitest/engine-manifest.json`，单向同步镜像 `templates/playwright-qa/support/gate-kernel.mjs`，`doctor` 与 `check:vendor` 双重校验漂移） |
| **Living Code Map** | `v5.1` (`schemaVersion: 5`) | `src/codemap/sync.mjs`、`src/codemap/v5-fusion.mjs`、`src/codemap/python-extractor.mjs`、`src/codemap/providers/`（多语言 Monorepo 自发现 + Vue 3/TS 泛型 HTTP/跨文件前缀助手/`.cjs` + Python `FastAPI`/`Flask`/`aiohttp`/`Starlette`/`Django`/ORM + Spring/MyBatis L0 提取 + L1 解耦 `codebase-memory-mcp@0.12.1` 侧车与 `AITEST_DATA_DIR`/tmpdir 隔离 + L2 反腐败融合，自动迁移 v4 → v5） |
| **Graph Impact Index** | `v1` (`pipe-sharded-v1` / Diff-Impact v3.1) | `src/impact/graph-index.mjs`、`src/impact/graph-index-codec.mjs`、`src/impact/global-infra-guard.mjs`、`src/impact/scanner.mjs`、`src/impact/graph.mjs`（共享 `.git` Monorepo 差异重映射 + Python `.py` 反向导入图 + `knowledge/graph-impact-index.json` 16 分片 `<20ms` 延迟水合 + `>65` 高扇入 Fail-Closed 哨兵 + Global Infra Guard） |
| **8-Pillar MCP Hub** | `v1` (`.aitest/mcp.lock`) | `src/mcp-hub/catalog.mjs`、`src/mcp-hub/auditor.mjs`（8 大支柱新增 `code-intelligence`，`mcp doctor` 强检原生侧车 `--ui=false` 与二进制 SHA-256） |
| **Differential Parity Oracle** | `v1` | `src/kernel/diff-oracle.mjs` / `src/parity/`（五级检查点 `CP1..CP5`、`shape-only` 零明文形状指纹 `fp_<12hex>` 与零依赖 SSE 重组 `src/core/stream-sse.mjs`） |
| **Memory Loop & Seam Card** | `v1` | `src/memory/` / `src/learn.mjs` / `src/verdict/seam-card.mjs`（受锁 `qa/known-blockers.json`、待审提案 `learn-proposals.{json,md}` 与人类守门员焦点卡） |
| **CommandResult & Verdict** | `v2` | `src/core/outcome.mjs` / `src/verdict.mjs`（统一 `CommandResult<T>` 信封、`AITEST_RESULT_FILE` 帧化 IPC 与 `scope.graphEngine` 证明书绑定） |
| **Governance Lock** | `v1` | `src/governance.mjs`（`.aitest/governance.lock`） |
| **Template Manifest** | `v1` | `src/upgrade.mjs` / `src/init.mjs`（`.aitest/template-manifest.json`） |
| **Run Ledger & Attestation** | `v1` | `src/ledger.mjs` / `src/verdict.mjs`（`.aitest/runs/<runId>/manifest.json` & `attestation.json`） |
| **Heal Session & Quarantine** | `v1` | `src/heal.mjs` / `src/flaky.mjs` |

## 3. 根包开发依赖与模板精确锁死依赖清单

根包 `package.json` 保持 **0 个运行时第三方依赖**（`dependencies` 缺省），仅在 `devDependencies` 中精确锁定 `typescript@6.0.3` 与 `@types/node@26.6.6` 用于严格类型检查（`npm run typecheck`）。所有 `<repo>/qa` 模板依赖均采用精确版本锁定（不带 `^`）：

| npm 包名 | 精确锁死版本 | 核心用途 |
|---|---|---|
| `@playwright/test` | `1.65.1` | 测试运行器、Chromium、`init-agents` 与内置 `run-test-mcp-server` |
| `@axe-core/playwright` | `4.14.0` | 自动化机器可检 WCAG 2.0/2.1/2.2 A 与 AA 无障碍扫描 |
| `eslint` | `10.15.0` | 静态防假绿语法与裸 `request.newContext()` / `test.fail()` 阻断 |
| `eslint-plugin-playwright` | `2.12.2` | 强制执行 `expect-expect`、`no-skipped-test`、`no-wait-for-timeout` 等 |
| `typescript-eslint` | `8.73.0` | TypeScript ESLint Flat Config 解析 |
| `typescript` | `6.0.3` | 根工程严格 `checkJs`（`strict: true`）与 QA 工程 `tsc --noEmit` 校验 |
| `@types/node` | `26.6.6` | Node.js 类型定义 |

## 4. 官方 CI Docker 镜像对齐表

| `@playwright/test` 版本 | 官方 Docker 镜像 | Chromium 修订版 |
|---|---|---|
| `1.65.1` | `mcr.microsoft.com/playwright:v1.65.1-noble` | `chromium-1255` (`Chrome for Testing 159.0.8154.6`) |
