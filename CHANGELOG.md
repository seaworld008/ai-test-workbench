# 更新日志 (Changelog)

> [English Changelog](./CHANGELOG.en.md) · [简体中文主文档](./README.md) · [v5.0 验证评分卡](./docs/review/v5-verification-scorecard.md)

本日志遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与 [语义化版本 (SemVer)](https://semver.org/spec/v2.0.0.html) 规范。

## [5.1.1] - 2026-11-24

### 变更与发布流水线加固 (Changed & Hardened)
- **原生零密钥 npm Trusted Publishing (OIDC) 激活**：[.github/workflows/release.yml](./.github/workflows/release.yml) 升级至 **Node.js 24**（内置 `npm >= 11.5.1`），移除 `registry-url` 与 `NODE_AUTH_TOKEN`，完全通过 GitHub Actions OIDC（`id-token: write`）免密钥发布并附带 SLSA v1 Sigstore Provenance；同步将可复用工作流 `aitest-verify.yml` 默认版本、全仓锁版本示例更新至 `5.1.1`。

## [5.1.0] - 2026-11-24

### 破坏性变更 / 移除 (Removed / Breaking)
- **移除 `aitest` CLI 命令别名，新增 `aitw` 短命令**：原 `bin.aitest` 与 npm 上既有无关第三方包 `aitest`（同样注册了 `aitest` 命令）重名；鉴于本包此前从未发布到 npm，现正式从 `package.json` 的 `bin` 中移除 `aitest`，统一使用锁版本 `npx ai-test-workbench@5.1.0 <cmd>` 或全局安装后的 `aitw <cmd>`（本地仓库开发继续保留 `node tools/aitest.mjs <cmd>`）。为保持已有客户端兼容，`tools/aitest.mjs` 文件路径、MCP 工具名 `aitest_*`、`.aitest/` 目录、`AITEST-G*` 规则码与 `AITEST_*` 环境变量前缀均保持不变。

### 新增与加固 (Added & Hardened)
- **npm 供应链发布就绪**：`package.json` 补充 `publishConfig: { "access": "public", "provenance": true }`，新增标签触发的 [.github/workflows/release.yml](./.github/workflows/release.yml)（全量 Action 锁定至完整 Commit SHA，发布前强制执行全部 7 条验证门禁，支持首次发布后切换 npm Trusted Publisher）。
- **`T2` 信任分级与可复用 CI 工作流**：全栈统一 `T0 / T1 / T2` 固定口径（仅 CI 干净重跑 + Sigstore 免密钥签名的 `T2` 为合入级绿灯），新增可复用 [.github/workflows/aitest-verify.yml](./.github/workflows/aitest-verify.yml)（支持 `github-attest` 与 `cosign`）与 [examples/workflows/use-aitest-verify.yml](./examples/workflows/use-aitest-verify.yml)；强化 `attest verify` 支持 `--expect-repo` / `--expect-workflow` / `--expect-ref` 与离线零依赖 Sigstore/Fulcio 验签（默认 fail-closed）。
- **零依赖 MCP ADR 与官方合规门禁**：新增 [docs/adr/mcp-zero-dependency.md](./docs/adr/mcp-zero-dependency.md) 与隔离 `conformance/` 测试套件（锁定 `@modelcontextprotocol/conformance@0.1.16` 与 `@modelcontextprotocol/sdk@1.32.2`，接入 CI `mcp-conformance` job 覆盖 `stdio` / Streamable HTTP / Legacy SSE 三传输），修复 Legacy SSE 异步 `202` 与 Streamable HTTP 双 `Accept` 进度流。
- **真实开源提交 Gate FPR 公开试跑与红队设计**：预登记方法 [bench/real-world/PREREGISTRATION.md](./bench/real-world/PREREGISTRATION.md) 独立先行提交，完成 5 个宽松许可开源仓 `n = 50` 真实提交离线试跑（审核后 FPR `20.8%`、Wilson 95% CI `[11.7%, 34.3%]`，原始告警率 `24.0%`，`>=200` 正式评测标记 `pending`），并新增 `FGER-agentic` 红队设计文档 [bench/agentic/DESIGN.md](./bench/agentic/DESIGN.md)。
- **企业级多端 SaaS 深度探索与会话复用升级（真实 SaaS 实测沉淀）**：
  - `explore` 新增**多端/多租户切换抽屉自动发现与跨端遍历**（`--explore-portals` / `--max-portals`）、**业务域分层轮询队列**（上限升至 `500` 页）、**Vue 2 `$router.getRoutes()` + Vuex 权限菜单树**发现、**折叠子菜单自动展开**、**页内 Tab 自动切换**（`--explore-tabs`）、**严格只读详情弹窗/抽屉探测与关闭**（`--explore-dialogs`，标签白名单 + 网络层默认拒绝双重保护）、**断链/缺模块路由检测**（`brokenRoutes`）、**Element UI / AntD 固定列行数去重**、**HTTP 200 包裹业务码异常检测**（`code: 401/403/500`，同步覆盖 `perf`）、**URL 编码 Query 泄漏修复**（`%5B$L%5D`）与**独立 API 网关跨源提示**（`blockedApiHosts`）。
  - `auth-login` 新增本机回环限制的 `--cdp-url <http://127.0.0.1:9222>` 会话直采模式，复用已在 Chrome 中完成短信/滑块登录的会话，无需重复登录且不关闭用户浏览器。
- **`lint:docs` 文档命令与版本防漂移门禁**：自动阻断文档中裸 `npx -y ai-test-workbench`、已移除的 `aitest <cmd>` CLI 命令以及与 `package.json` 版本不一致的 `@x.y.z` 示例。
- **模块化 AST 门禁内核 v3、T1 工作区外 HMAC、结构化先解析后脱敏与模块化 MCP 服务端**：4 层 fail-closed 三态门禁拦截 `24/24` 红队留出集（`FGER-holdout = 0.0%`）且良性重构 `FPR = 0.0%`，修复 MCP 自愈 `sessionId` 脱敏阻断与真实 Playwright 堆栈 `C→A` 误判。

## [5.0.0] - 2026-11-24

### 新增 (Added)
- **四层可信防假绿门禁内核 v2（`templates/playwright-qa/support/gate-kernel.mjs`）**：
  - 引入 **`S0–S5` 断言强度格（Assertion Strength Lattice）** 与全工作区语义 Diff 守卫（`AITEST-G101..G113`），拦截同数量弱化替换、`expect(true).toBe(true)`、`test.fail()`、`.catch(() => null)`、`retries` 调大、`expect.soft()`、`testIgnore`、ESLint 关规则、条件包裹 `if (...) { expect(...) }`、`200 -> 500` 反向迎合等 **26 种作弊补丁（`FGER = 0.0%`）**。
- **治理文件防篡改锁与人类审批协议（`src/governance.mjs` & `aitest governance`）**：
  - 自动维护 11 项受保护文件的 `.aitest/governance.lock` SHA-256 清单与只追加 `.aitest/governance-audit.jsonl`；`governance approve` 仅限人类本地 CLI 调用，硬阻断 MCP 子进程与机器人审批名。
- **运行账本绑定与历史抖动隔离（`src/ledger.mjs` & `src/flaky.mjs`）**：
  - 每次运行生成 Crockford Base32 ULID `runId` 并绑定工作区源码输入指纹（`.aitest/runs/<runId>/manifest.json`），杜绝重放陈旧 `results.json`；支持近 20 次抖动率统计与 `<= 7 天` 自动到期隔离（`.aitest/quarantine.json`）。
- **一键变更判决、有状态自愈状态机与需求追溯矩阵（`src/verdict.mjs`、`src/heal.mjs`、`src/traceability.mjs`）**：
  - 新增 `aitest verify-change` / `aitest_verify_change`（产出 `attestation.json`、`verdict-summary.md`、`verdict.sarif.json`）。
  - 新增 `aitest heal begin|attempt|conclude` 状态机：工具层硬阻断 B/C/D 类改测试（误修率 `0.0%`），C 类自动产出含 W3C `Trace-ID` 的 `reports/defects/*.md` 工单。
  - 新增 `aitest trace-matrix` / `aitest_trace_matrix` 校验 `REQ-xxx` 需求追溯覆盖率。
- **MCP 执行模型 v2 与独立子进程作业调度器（`src/jobs.mjs` & `src/mcp-server.mjs`）**：
  - 扩展至 **21 个强类型 MCP 工具**；彻底移除进程内 `console` 劫持；支持只读并发 + 工作区细粒度写锁、`syncBudgetMs` 异步后台作业、`_meta.progressToken` 进度推送与 `notifications/cancelled` 跨平台进程树终止（`killProcessTree`）。
  - 新增架构决策记录 [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md)。
- **零依赖 JSON Schema / OpenAPI 3.x 契约校验器与公开基准靶场（`support/schema-validator.mjs` & `scripts/run-bench.mjs`）**：
  - 新增 `npm run bench` 评测 7 类注入式全栈种子缺陷（检出率 `100%`）与 26 类假绿绕过（逃逸率 `0%`），输出机器可读 `bench/scorecard.json`；新增 `npm run typecheck` 与 `docs/claims.json` 文档声明自动核验门禁。

### 优化与安全修复 (Improved & Security Fixed)
- **修复 CDP Web Vitals 失真（`src/perf.mjs` & `base.ts`）**：改用预注入 `PerformanceObserver({ buffered: true })` 真实采集非空 `LCP`、`CLS`、`INP`（多样本中位数 + P75）；`expectAccessible` 补齐 `wcag21a` 与 `wcag21aa` 标签。
- **全通道安全与凭据脱敏 v2（`target-guard.mjs`、`explore.mjs`、`proc.mjs`、`mcp-hub.mjs`）**：
  - `explore` 默认拒绝所有非 `GET/HEAD/OPTIONS` 请求并禁用 `sendBeacon`，输出单页脱敏 ARIA 档案 `specs/pages/*.md`；移除 `/graphql` 默认安全写豁免并拦截 GraphQL `mutation`；新增 `TEST_EGRESS_MODE=allowlist` 并统一代理 `page.request` / `context.request`。
  - 升级 `redactSecrets` 覆盖 JSON 键值密码、JWT、云厂商密钥、PEM 私钥与连接串（35/35 召回率 `100%`）；全量锁死外部 MCP 预设版本（替换已归档 Postgres 包为 `@bytebase/dbhub@0.15.0 --readonly`）并增加 `.aitest/mcp.lock` 哈希漂移与提示词投毒检测。
  - Streamable HTTP 严格限制仅 `initialize` 创建会话、未知会话返回 `404`、启用 `crypto.timingSafeEqual` Bearer 校验与协议感知批处理控制。
- **活体代码地图 v4、反向依赖 Impact v2 与结构化诊断 v2（`codemap.mjs`、`impact.mjs`、`diagnose.mjs`）**：
  - 保留 `:id`/`[id]` 动态路由、自动清理已删文件、收敛缺陷计数；构建静态 `import` 反向依赖图；诊断优先消费结构化运行时守卫信号（45/45 分类准确率 `100%`）；CLI 开启严格未知参数拦截与拼写纠错提示。

## [4.0.0] - 2026-11-23

### 新增 (Added)
- **AI Agent 优先原生全协议 MCP 服务端（`src/mcp-server.mjs` & `aitest mcp-serve`）**：支持 MCP `2025-11-25`..`2024-11-05` 与 `stdio` / Streamable HTTP (`/mcp`) / Legacy SSE (`/sse`)，暴露 12 个工具、Resources 与双语 Prompts。
- **全仓默认中文 + 配对 `.en.md` 双语文档体系**与 `npm run lint:docs` 门禁。

## [3.0.0] - 2026-11-23

### 新增 (Added)
- **自演进活体代码知识图谱（`aitest map`）**、**6 大支柱只读 MCP 中枢（`aitest mcp`）**、**性能评测引擎（`aitest perf`）** 与 **Trace-ID 根因贯通**。

## [2.1.0] - 2026-11-23

### 新增 (Added)
- **从 0 到 1 只读探索引擎（`aitest explore`）**。

## [2.0.0] - 2026-11-23

### 新增 (Added)
- 初始开源版本：跨项目 `<repo>/qa` 隔离、Playwright Test Agents SHA-256 同步、三层门禁、交互式 `auth-login` 与 `demo-campus` 演示靶场。
