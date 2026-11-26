# 架构设计与可信安全边界 (`ai-test-workbench` v6.4)

> [English Version](./ARCHITECTURE.en.md) · [四层门禁与治理指南](./docs/governance.md) · [ADR-0001..0006](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [升级指南](./docs/upgrade.md) · [简体中文主文档](./README.md)

## 1. 分层架构与单向依赖边界

`ai-test-workbench v6.4` 采用严格无环的四层架构（由 `test/unit/architecture-boundaries.test.mjs` 与 `test/unit/v630-architecture-and-extensibility.test.mjs` 自动化守卫：`0` 条 `src/scripts -> templates` 反向依赖、`0` 条 `src/**` 循环导入、全量 `src/**/*.mjs <= 450` 行且目标 `<= 435` 行、严格 `checkJs` 零错误）：

1. **Layer 1 基础叶模块（`src/core/` + `src/types/`）**：零外部依赖的纯工具层，提供 `version`、`outcome`（`CommandResult v2`）、`config`（集中环境、`AITEST-G101..G118` 规则校验、`lockstepRules`、`memoryPatterns`、`parity`、`replayAllowedUpstreamHosts` 与 `TEST_EGRESS_EXTRA_HOSTS`/`TEST_EGRESS_ALLOW_HOSTS` 统一解析）、`stream-sse`（零依赖 Anthropic/OpenAI SSE 解析）、`glob`（有界正则缓存）、`redact`（线性时间 Redaction v3 + VT ANSI 剥离）、`playwright-results`、`playwright-resolve`、`proc`、`i18n`。
2. **Layer 2 权威验证内核（`src/kernel/`）**：唯一真源，通过 `package.json#exports` 暴露 `.`、`./kernel`、`./app`、`./target-guard`、`./schema-validator`，包含不可变 `TrustContext`（`src/kernel/gate/trust-context.mjs`）、正缓存无负陈旧 Git 探测（`src/kernel/gate/git-utils.mjs`）、五级差分检查点引擎（`src/kernel/diff-oracle.mjs`）、`SymbolTable`、支持 `extraRules` 与受锁声明式 `qa/support/project-rules.json` 的 **`AITEST-G101..G118`（18 条）**规则引擎，并通过 `scripts/sync-template-vendor.mjs` 传递闭包确定性镜像至 `templates/playwright-qa/support/`（CI 强检字节一致，详见 [ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.md)）。
3. **Layer 3 应用门面与领域子系统（`src/app/index.mjs`、`src/{trust,explore,codemap,perf,parity,corpus,replay,memory,verdict,mcp-hub,init,runner,agents,governance,heal}/` 及根领域服务）**：稳定 `./app` 门面隔离 `scripts/` / `bench/` 与内部实现；提供双目标五级差分先知与非回环写保护（`src/parity/`）、离线脱敏语料导入（`src/corpus/`）、受锁外部上游磁带回放（`src/replay/`）、零明文形状指纹聚类（`src/diagnose/{fingerprint,cluster}.mjs`）、工具化记忆循环蒸馏与全仓回溯清扫器（`src/memory/` + `src/learn.mjs`）、内外环人类守门员焦点卡（`src/verdict/seam-card.mjs`）、O(limit) 倒序分块 `readJsonlTail` 运行账本尾读、可插拔栈/框架注册表、`AITEST_RESULT_FILE` 帧化 IPC 与原子硬链接磁盘写锁。
4. **Layer 4 协议与交互层（`src/cli/` + `src/mcp/`）**：按命令严格参数校验的 CLI（含 `parity`、`corpus`、`learn` 与用法错误统一 `CommandResult v2 --json` 输出，退出码 `0/1/2/64`）与零运行时依赖多协议 MCP 服务端（17 个权威工具 + 8 个 `v6.x` 弃用转发别名，含 `aitest_parity` 与 `aitest_report(view="lessons")` 只读记忆视图，并为 `aitest_impact`、`aitest_report`、`aitest_doctor`、`aitest_mcp_hub` 只读子动作与 `aitest_diagnose(dryRun=true)` 提供进程内只读快速通道；详见 [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md)、[ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.md) 与 [ADR-0006](./docs/adr/0006-differential-parity-oracle-and-shape-fingerprints.md)）。

## 2. 跨项目物理隔离 (`<repo>/qa/`) 与安全升级

每个业务仓库获得完全独立的 `<repo>/qa/` 子工程，拥有精确锁版本的依赖、`.aitest/template-manifest.json`、`.aitest/governance.lock`、`.aitest/runs/` 运行账本、`.aitest/quarantine.json`、`specs/`、`tests/`、`knowledge/`、`impact-map.json`、`waivers.json`、`known-blockers.json`、`corpus/`、`fixtures/upstream-cassettes/` 与 `reports/`，不污染宿主构建配置。可通过 `npx ai-test-workbench@6.4.0 upgrade --target <repo>` 做三方哈希安全升级。

## 3. 全平面默认拒绝安全守卫 (`src/kernel/target-guard.mjs` + `base.ts`)

1. **目标环境与 10 跳重定向防火墙**：拒绝 `TEST_ENV=production|prod|live|online` 与畸形/未授权 URL；所有 Playwright `context.route`、`APIRequestContext`、`perf` 与探索观察器强制 `maxRedirects: 0`（最多 10 跳，逐跳复验出站与高危策略），支持 `TEST_EGRESS_MODE=allowlist`（非法模式 Fail-Closed）。
2. **全通道请求拦截与环境策略拆分**：在 `tests/fixtures/base.ts` 同时包装 `context.route`、`APIRequestContext`、`context.request` 与 `page.request`，设置 `serviceWorkers: 'block'`，并区分本地回环沙箱默认 CRUD 与共享非回环默认严防只读；`src/runner.mjs` 采用严格环境变量白名单隔离被测业务与 Playwright 子进程中的 `AITEST_HMAC_KEY*` / OIDC 凭据。
3. **默认禁写探索器与 Schema 推断（`src/explore/`）**：`explore` 默认拒绝一切非 `GET/HEAD/OPTIONS` 请求、拦截非白名单 WebSocket 并禁用 `navigator.sendBeacon`，同时从只读 GET 响应聚合候选 JSON Schema（`specs/api-schemas.json`）。
4. **凭据脱敏 v3 与供应链锁（`src/core/redact.mjs` + `src/mcp-hub/`）**：自动擦除 JSON 密码/令牌、JWT、云厂商密钥、PEM 私钥、连接串与 VT ANSI 注入；7 大支柱外部 MCP 预设精确锁版本并支持 `.aitest/mcp.lock` 漂移与提示词投毒审计。
5. **MCP HTTP 安全边界**：默认监听 `127.0.0.1`、精确校验 `Host`（`421`/`403`）、`Origin`（`403`）与 `Content-Type: application/json`（`415`）、仅 `initialize` 创建会话、未知会话返回 `404`、限制 JSON-RPC Batch 长度、采用 `crypto.timingSafeEqual` 校验 Bearer Token，并基于 `--workspace-root` 与客户端 `roots` 交集拦截越界路径。

## 4. 四层 Fail-Closed 防假绿质量门禁内核 (`src/kernel/gate/`)

- **Layer 0 治理防篡改锁、粘性 T1 与配置校验**：单次解析不可变 `TrustContext`；支持多机签名映射 `macs: { [keyId]: hmac }` 与本地粘性 T1 防剥离；校验受保护路径指纹与配置 Schema，仅干净出厂哈希且无历史痕迹才允许 `aitest_init` 初签。
- **Layer 1 静态门禁**：`tsc --noEmit` + `eslint-plugin-playwright`（禁跳过、禁 `.only`、禁硬等待、禁 `{ force: true }`、禁 `test.fail()`、禁裸 `request.newContext()`）；CI 或存在 `governance.lock && node_modules` 时缺编译器默认 `blocked`。
- **Layer 2 运行账本与豁免门禁**：校验 `results.json` 与当前工作区源码输入指纹绑定（自定义 `--results` 未传 `--expected-run-id` 默认阻断）；严拆状态并默认 `maxSkipped=0`；强制人类审批、`<= 5` 上限与 `<= 14 天` TTL 的 `waivers.json`。
- **Layer 3 AST 符号表、强度格、Dieselgate 与跨目录锁步防护**：基于 TypeScript Compiler API、显式词法作用域栈与跨作用域 `SymbolTable` 运行 **`AITEST-G101..G118`** 共 **18 条**规则（含 `G116` HTTP 状态字面量等价替换、`G117` 产品侧测试流量特判 Dieselgate 防护、`G118` 跨目录/跨栈锁步同步门禁、`G-08` `git mv` 移出测试目录拦截，以及经 `governance.lock` 校验的纯 JSON 声明式 `qa/support/project-rules.json`）；详见 [ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.md) 与 [ADR-0006](./docs/adr/0006-differential-parity-oracle-and-shape-fingerprints.md)。

## 5. 代码地图 v4、反向依赖精选、状态机自愈与 Web Vitals

- **活体代码地图 v4 & 反向依赖精选（`src/codemap/` + `src/impact.mjs`）**：按框架适配器扫描前端/后端/DB，保留 `:id` / `[id]` 动态路由、自动清理已删路由、收敛历史缺陷；通过静态 `import` 反向依赖图计算传递受影响测试并给出 `why` 证据链。
- **有状态自愈与需求追溯（`src/heal.mjs` + `src/traceability.mjs`）**：B/C/D 类在工具层硬阻断改测试（误修率 `0%`），C 类自动产出含 32 位 W3C `Trace-ID` 的缺陷工单；构建 `REQ-xxx` 双向追溯矩阵。
- **真实 `PerformanceObserver` Web Vitals 与契约校验（`src/perf/` + `src/kernel/schema-validator.mjs`）**：预注入缓冲观察器采集 `LCP / CLS / INP` 中位数与 P75，配套零依赖 JSON Schema / OpenAPI 3.x 响应校验与 WCAG 2.0/2.1/2.2 AA 扫描。
