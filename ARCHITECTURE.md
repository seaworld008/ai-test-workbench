# 架构设计与可信安全边界 (`ai-test-workbench` v6.0)

> [English Version](./ARCHITECTURE.en.md) · [四层门禁与治理指南](./docs/governance.md) · [ADR-0001..0005](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [升级指南](./docs/upgrade.md) · [简体中文主文档](./README.md)

## 1. 分层架构与单向依赖边界

`ai-test-workbench v6.0` 采用严格无环的四层架构（由 `test/unit/architecture-boundaries.test.mjs` 自动化守卫：`0` 条 `src/scripts -> templates` 反向依赖、`0` 条 `src/**` 循环导入、严格 `checkJs` 零错误）：

1. **Layer 1 基础叶模块（`src/core/` + `src/types/`）**：零外部依赖的纯工具层，提供 `version`、`outcome`、`config`（集中环境与 `aitest.config.json` Schema 校验）、`glob`、`redact`、`playwright-results`、`playwright-resolve`、`proc`、`i18n`。
2. **Layer 2 权威验证内核（`src/kernel/`）**：唯一真源，通过 `package.json#exports` 暴露 `.`、`./kernel`、`./target-guard`、`./schema-validator`，并通过 `scripts/sync-template-vendor.mjs` 单向确定性镜像至 `templates/playwright-qa/support/`（CI 强检字节一致，详见 [ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.md)）。
3. **Layer 3 领域子系统（`src/{trust,explore,codemap,perf,mcp-hub}/` 及 `src/{init,upgrade,doctor,governance,ledger,runner,audit,verdict,heal,diagnose,impact,flaky,traceability,report,auth-login,jobs}.mjs`）**：按领域拆分为 `<= 500` 行的单一职责模块。
4. **Layer 4 协议与交互层（`src/cli/` + `src/mcp/`）**：按命令严格参数校验的 CLI（22 个子命令）与零运行时依赖多协议 MCP 服务端（17 个权威工具 + 6 个 `v6.x` 弃用转发别名；详见 [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) 与 [ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.md)）。

## 2. 跨项目物理隔离 (`<repo>/qa/`) 与安全升级

每个业务仓库获得完全独立的 `<repo>/qa/` 子工程，拥有精确锁版本的依赖、`.aitest/template-manifest.json`、`.aitest/governance.lock`、`.aitest/runs/` 运行账本、`.aitest/quarantine.json`、`specs/`、`tests/`、`knowledge/`、`impact-map.json`、`waivers.json` 与 `reports/`，不污染宿主构建配置。可通过 `npx ai-test-workbench@6.0.0 upgrade --target <repo>` 做三方哈希安全升级。

## 3. 全平面默认拒绝安全守卫 (`src/kernel/target-guard.mjs` + `base.ts`)

1. **目标环境与出站白名单硬阻断**：拒绝 `TEST_ENV=production|prod|live|online` 与畸形/未授权 URL，强制 `TEST_ALLOWED_HOSTS` / `TEST_DENIED_ORIGINS`，支持 `TEST_EGRESS_MODE=allowlist` 严格出站白名单。
2. **全通道请求拦截**：在 `tests/fixtures/base.ts` 同时包装 `context.route`、`APIRequestContext`、`context.request` 与 `page.request`，设置 `serviceWorkers: 'block'`，并通过 ESLint 禁止裸调 `request.newContext()`；拦截 GraphQL `mutation` 载荷。
3. **默认禁写探索器（`src/explore/`）**：`explore` 默认拒绝一切非 `GET/HEAD/OPTIONS` 请求、拦截非白名单 WebSocket 并禁用 `navigator.sendBeacon`。
4. **凭据脱敏 v2 与供应链锁（`src/core/redact.mjs` + `src/mcp-hub/`）**：自动擦除 JSON 密码/令牌、JWT、云厂商密钥、PEM 私钥与连接串（35/35 对抗语料召回率 `100%`）；7 大支柱外部 MCP 预设精确锁版本并支持 `.aitest/mcp.lock` 漂移与提示词投毒审计。
5. **MCP HTTP 安全边界**：默认监听 `127.0.0.1`、校验 `Origin`（`403`）、仅 `initialize` 创建会话、未知会话返回 `404`、采用 `crypto.timingSafeEqual` 校验 Bearer Token，并基于服务端 `--workspace-root` 与客户端 `roots` 的交集强制拦截越界路径访问。

## 4. 四层 Fail-Closed 防假绿质量门禁内核 (`src/kernel/gate/`)

- **Layer 0 治理防篡改锁与配置校验**：校验 17 条受保护路径模式的 `.aitest/governance.lock` SHA-256 指纹与 T1 MAC，并按 JSON Schema 校验 `aitest.config.json`。
- **Layer 1 静态门禁**：`tsc --noEmit` + `eslint-plugin-playwright`（禁跳过、禁 `.only`、禁硬等待、禁 `{ force: true }`、禁 `test.fail()`、禁裸 `request.newContext()`）；CI 缺编译器默认 `blocked`。
- **Layer 2 运行账本与豁免门禁**：校验 `results.json` 与当前工作区源码输入指纹绑定（自定义 `--results` 未传 `--expected-run-id` 默认阻断）；严拆状态并默认 `maxSkipped=0`；强制人类审批、`<= 5` 上限与 `<= 14 天` TTL 的 `waivers.json`。
- **Layer 3 可插拔 AST 断言强度格与提交级语义 Diff 守卫**：基于 TypeScript Compiler API 与显式词法作用域栈运行 `AITEST-G101..G115` 共 15 条独立规则（详见 [ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.md)），支持提交级跨文件测试标题池化与故障注入/蜜罐感知；缺 TS 编译器默认 `blocked`。

## 5. 代码地图 v4、反向依赖精选、状态机自愈与 Web Vitals

- **活体代码地图 v4 & 反向依赖精选（`src/codemap/` + `src/impact.mjs`）**：按框架适配器扫描前端/后端/DB，保留 `:id` / `[id]` 动态路由、自动清理已删路由、收敛历史缺陷；通过静态 `import` 反向依赖图计算传递受影响测试并给出 `why` 证据链。
- **有状态自愈与需求追溯（`src/heal.mjs` + `src/traceability.mjs`）**：B/C/D 类在工具层硬阻断改测试（误修率 `0%`），C 类自动产出含 32 位 W3C `Trace-ID` 的缺陷工单；构建 `REQ-xxx` 双向追溯矩阵。
- **真实 `PerformanceObserver` Web Vitals 与契约校验（`src/perf/` + `src/kernel/schema-validator.mjs`）**：预注入缓冲观察器采集 `LCP / CLS / INP` 中位数与 P75，配套零依赖 JSON Schema / OpenAPI 3.x 响应校验与 WCAG 2.0/2.1/2.2 AA 扫描。
