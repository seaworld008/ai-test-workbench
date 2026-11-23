# 架构设计与可信安全边界 (`ai-test-workbench` v5.0)

> [English Version](./ARCHITECTURE.en.md) · [四层门禁与治理指南](./docs/governance.md) · [ADR-0001 MCP 内核决策](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [简体中文主文档](./README.md)

## 1. 核心定位：AI 编码 Agent 的独立可信验证内核

`ai-test-workbench v5.0` 严格隔离**AI Agent 探索/创作/受控自愈期**与**确定性可信验证期**：

1. **创作与受控治理层（MCP 执行模型 v2：`src/mcp-server.mjs` + `src/jobs.mjs`）**：
   - 原生支持 `stdio`、`Streamable HTTP (/mcp)` 与 `Legacy HTTP+SSE (/sse)`，兼容 MCP `2024-11-05` 至 `2025-11-25+`，根包保持**零外部运行时依赖**（详见 [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md)）。
   - 暴露 **21 个强类型 MCP 工具**。只读工具全并发无锁；写操作与长任务在独立子进程（`AITEST_MCP_CHILD=1`）中按工作区互斥锁运行，支持 `_meta.progressToken` 进度通知、`notifications/cancelled` 进程树级强杀与 `syncBudgetMs` 异步后台作业切换。
   - **特权物理隔离**：重签治理锁的 `aitest governance approve` 仅限人类在本地终端调用，永不注册为 MCP 工具且拒绝 MCP 子进程调用。
2. **确定性回归与一键终审层（Deterministic Runner + `verifyChangeCore`）**：
   - 本地提交前、PR 与 CI 直接运行静态 TypeScript 测试与 `aitest verify-change`，**零大模型调用、零模型 API 密钥依赖**，产出绑定 ULID `runId` 的 `attestation.json` 与 `verdict.sarif.json`。

## 2. 跨项目物理隔离 (`<repo>/qa/`)

每个业务仓库获得完全独立的 `<repo>/qa/` 子工程，拥有精确锁版本的依赖、`.aitest/governance.lock`、`.aitest/runs/` 运行账本、`.aitest/quarantine.json`、`specs/`、`tests/`、`knowledge/`、`impact-map.json`、`waivers.json` 与 `reports/`，绝不污染宿主构建脚本。

## 3. 全平面默认拒绝安全守卫 (`support/target-guard.mjs` + `base.ts`)

1. **目标环境与出站白名单硬阻断**：拒绝 `TEST_ENV=production|prod|live|online` 与通配符域名，强制 `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`，支持 `TEST_EGRESS_MODE=allowlist` 严格出站白名单。
2. **全通道请求拦截**：在 `tests/fixtures/base.ts` 同时包装 `context.route`、`APIRequestContext`、`context.request` 与 `page.request`，设置 `serviceWorkers: 'block'`，并通过 ESLint 禁止裸调 `request.newContext()`；拦截 GraphQL `mutation` 载荷。
3. **默认禁写探索器（`src/explore.mjs`）**：`explore` 默认拒绝一切非 `GET/HEAD/OPTIONS` 请求并禁用 `navigator.sendBeacon`，移除 `/graphql` 默认写豁免。
4. **凭据脱敏 v2 与供应链锁（`src/proc.mjs` + `src/mcp-hub.mjs`）**：自动擦除 JSON 密码/令牌、JWT、云厂商密钥、PEM 私钥与连接串（35/35 对抗语料召回率 `100%`）；7 大支柱外部 MCP 预设全量精确锁版本并支持 `.aitest/mcp.lock` 漂移与投毒审计。
5. **MCP HTTP 安全边界**：默认监听 `127.0.0.1`、严格校验 `Origin`（`403`）、仅允许 `initialize` 创建会话、未知会话返回 `404`、采用 `crypto.timingSafeEqual` 校验 Bearer Token 并限制 `--allowed-root` 工作区根目录。

## 4. 四层防假绿质量门禁内核 (`support/gate-kernel.mjs`)

- **Layer 0 治理防篡改锁**：校验 11 个受保护治理与配置脚本的 `.aitest/governance.lock` SHA-256 指纹。
- **Layer 1 静态门禁**：`tsc --noEmit` + `eslint-plugin-playwright`（禁跳过、禁 `.only`、禁硬等待、禁 `{ force: true }`、禁 `test.fail()`、禁裸 `request.newContext()`）。
- **Layer 2 运行账本与豁免门禁**：通过 `src/ledger.mjs` 校验 `results.json` 与当前工作区源码输入指纹一致，防重放陈旧绿灯；按 `file:line` 去重 `@mutation`；强制人类审批、单号绑定、`<= 5` 上限与 `<= 14 天` TTL 的 `waivers.json`。
- **Layer 3 `S0–S5` 断言强度格与语义 Diff 守卫**：扫描整个 `qa/`（含未跟踪文件），拦截 `AITEST-G101..G113` 全部语义弱化补丁（26/26 作弊补丁拦截率 `100%`，`FGER = 0%`）。

## 5. 智能图谱 v4、反向依赖精选、状态机自愈与真实 Web Vitals

- **活体代码地图 v4 & 反向依赖精选（`src/codemap.mjs` + `src/impact.mjs`）**：保留 `:id` / `[id]` 动态路由、自动清理已删路由、收敛历史缺陷；通过静态 `import` 反向依赖图计算传递受影响测试并给出 `why` 证据链。
- **有状态自愈与需求追溯（`src/heal.mjs` + `src/traceability.mjs`）**：B/C/D 类在工具层硬阻断改测试（误修率 `0%`），C 类自动产出含 W3C `Trace-ID` 的缺陷工单；构建 `REQ-xxx` 双向追溯矩阵。
- **真实 `PerformanceObserver` Web Vitals 与契约校验（`src/perf.mjs` + `schema-validator.mjs`）**：预注入缓冲观察器采集真实 `LCP / CLS / INP` 中位数与 P75，配套零依赖 JSON Schema / OpenAPI 3.x 响应校验与 WCAG 2.0/2.1/2.2 AA 扫描。
