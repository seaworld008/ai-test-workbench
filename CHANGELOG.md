# 更新日志 (Changelog)

> [English Changelog](./CHANGELOG.en.md) · [简体中文主文档](./README.md) · [v5→v6 升级指南](./docs/upgrade.md) · [v6 重构评估报告](./docs/review/v6-refactor-assessment.md)

本日志遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与 [语义化版本 (SemVer)](https://semver.org/spec/v2.0.0.html) 规范。

## [6.2.1] - 2026-11-25

### 安全加固与可信边界修复 (Security & Trust-Boundary Hardening)
- **封堵 `.aitest/baseline-ref` 来源伪造直通 T2 漏洞**：将 `.aitest/baseline-ref` 与 `.aitest/t1-sticky.json` 纳入 `templates/playwright-qa/gitignore` 并加入 `isProtectedDiffPath` 保护；写入改为带 `TrustContext` HMAC 签名的 `workspace.baseline` JSON 格式；在 `verdict.mjs`、`engine.mjs` 与 `changeset.mjs` 中凡显式传 `--base`/`diffBase` 或处于 CI 环境一律 100% 忽略工作区 `.aitest/baseline-ref`，本地校验强制 `merge-base --is-ancestor`、非空 Git 树、`--first-parent` 血统（阻断 `-s ours --allow-unrelated-histories` 空树注入）及不早于 `merge-base(HEAD, main)`。
- **收紧粘性 T1 外域 `keyId` Fail-Closed、`governance approve` 与环境变量白名单**：
  - 本机独占运行态域（`ledger.manifest`、`heal.ledger`、`heal.session`、`quarantine.json`、`workspace.baseline`）在 `hostT1Sticky` 时缺失本机签名或伪造外域 `keyId` 严格 Fail-Closed 返回 `ok: false`；`governance.lock` 绑定工作区粘性记录 `.aitest/t1-sticky.json`（及用户态外置标记），外域克隆锁强制将 `trustTier` 上限锁定为 `T0`。
  - `governance approve` 取消 `CI=1` 自动放行与 `--json` 跳过 TTY 确认，并拦截常见 Agent 会话环境变量（`ANTIGRAVITY_CONVERSATION_ID`、`CLAUDECODE`、`CODEX_CI`、`CODEX_SANDBOX`、`CURSOR_TRACE_ID`、`AIDER_MODEL`），非 TTY 场景需显式 `AITEST_APPROVE_NON_INTERACTIVE=1` + `--yes`。
  - `verifyAttestationFile` 传入解析后的 `qaDir`/`repoDir` 阻断工作区内伪造 `AITEST_HMAC_KEY_FILE`（退出码 `2`），拒绝 `< 12` 位或非十六进制 `--expect-git-sha`；`buildSafeChildEnv` 与 `runner.mjs` 升级为严格白名单并剥离代理 URL 内嵌凭据。
- **X.509 / Fulcio / CI 制品校验 / 适配层与 MCP HTTP 加固**：
  - `der-x509.mjs` 与 `sigstore-verify.mjs` 强制校验 `BasicConstraints`（根/中间 CA `ca: true`、叶子 `ca: false`）、`KeyUsage`、`pathLenConstraint`、证书有效期（相对 Rekor `integratedTime` 或当前时间）与 Fulcio Commit SHA OID（`.1.3` / `.1.21`）。
  - `.github/workflows/aitest-verify.yml` `attest` job 改读固定非符号链接路径 `aitest-ci-artifacts/{attestation.json,verdict-predicate.json,verdict.sarif.json}` 并强校验 `verdict === 'pass'`、四层门禁全通过、`git-commit === GITHUB_SHA` 与 predicate 一致性，移除不可信 `needs.verify.outputs.*-path`。
  - `eslint.config.mjs` 与 `static-runner.mjs` 扩展至扫描 `tests/**` 全部文件（含自定义 fixture/helper）阻断裸 `fetch`/`WebSocket`/动态 `import()`/`expect.extend`；`runtime-config.mjs` 与 `playwright.config.ts` 校验 `webServer.env` 禁止 `NODE_OPTIONS`/`LD_PRELOAD` 等注入键；`base.ts` 默认回环放行收敛至 `baseURL` 精确 `host:port` 并改用 10 跳重定向追踪；`perf` 增加 `serviceWorkers: 'block'` 与 `routeWebSocket`；`explore` 修复死代码 `redirectedFrom`；`mcp-hub` 升级 `mcp-grafana==2.2.0`、`redis-mcp-server==0.5.1`、`grafana/mcp-k6:0.7.2` 并审计 `:latest` Docker 标签。
  - MCP HTTP 未鉴权模式禁止跨端口回环 `Origin`、会话达上限返回 `429`（不再驱逐受害者会话）、配置 `headersTimeout`/`requestTimeout`/`keepAliveTimeout` 并从 `protocol.mjs` 移除绝对路径 `allowedRoots` 泄漏；`redact.mjs` 不再误脱敏布尔/数值原始字段（保留 `authRequired`）、补全 `api_key`/单行转义 PEM/`localStorage` 敏感键覆盖。

### AST 门禁精度修复与真实 FPR 恢复 (AST Gate v2.1 & Real-World FPR Restoration)
- **修复 `upgrade` / 幂等 `init` 自毁治理锁与 `acquireDiskLock` 竞态**：统一 `writeTemplateManifest` 与 `upgradeQaWorkspace` 码点排序，哈希无变动时禁止重写 `.aitest/template-manifest.json`，`computeTemplateManifestDigest` 忽略易变 `updatedAt` 字段；`acquireDiskLock` 在 `.aitest/` 尚不存在时自动创建后再原子加锁。
- **100-Commit 真实开源 FPR 从 `10.3%` 恢复至 `5.2% (5/97)`**：`SymbolTable` 禁止将可变数组/对象字面量（如 `const pageErrors = []`、`const messages = []`）折叠为编译期常量，支持单次赋值 `let`/`var`、解构绑定、默认参数与 `{ soft }` 简写；DOM 污点自引用收紧至「同定位器 + 无中间交互动作 + 非算术/模板派生」；`parser.mjs` 支持 `.split().forEach` 与 `expect(arr.length).toBe(N)` 计数守卫且将守卫绑定至循环目标；`constant-eval.mjs` 修复懒惰量词 `*?`/`+?`（`F07`）、单字符通配正则 `/[\s\S]/`（`G2-F07`）、多语句 `expect.poll`（`F47`）与恒同三元分支（`G2-F08`）；`parser-calls.mjs` 拦截 `<alias>.extend` 恒真匹配器（`F12`）；`lattice.mjs` 与 `g116` 识别 `expectApiContract` 状态码与状态变量/世纪位切片并归并 `400/409/422`；`g117-dieselgate.mjs` 升级为局部 Def-Use 污点传播 + 字符串拼接/Base64 解码 + `sec-fetch-*` 检测（彻底封堵变量提升版 Dieselgate 逃逸），同时豁免顶层服务端启动守卫（`G2-L03`）；`changeset.mjs` 堵住空 Spec 分支底线、合法 `@scaffold` 替换与 `F44/F45/F55` 非可执行 `git mv` 规避，并池化跨文件 `@critical`（`L09`）与按 REQ 最大断言阶保底（`G2-F14`）。
- **自治闭环、诊断与 CLI DX 收口**：修复 `playwright.config.ts` `webServer.cwd` 默认回落仓库根、`explore`/`perf` 回落 `aitest.runtime.json#baseURL` 并 fail-closed 检查配置、`diagnose` 移除 `!includes('server')` 排除并统一 Windows `testId` 正斜杠归一化、全量 CLI `--json` 零空输出与数值/枚举非法参数统一返回退出码 `64`、`aitest_map_sync` 补齐 `force` 参数、Windows 实盘代理适配器移除 `shell: true` 多行注入、修复 `bench/agentic` `--fast` 模式门禁绕过遮蔽并扩充 `AG-E1`/`AG-E2` 及 `baseline-ref`/提升变量 Dieselgate 实盘 Playwright E2E 回归验证。

## [6.2.0] - 2026-11-25

### 破坏性变更与接口收敛 (Breaking Changes & Surface Polish)
- **MCP 工具面收敛（17 → 16 权威工具）**：新增全自动零阻塞回环自举工具 `aitest_bootstrap`，将 `aitest_flaky_report` 与 `aitest_trace_matrix` 收编入 `aitest_report(view="summary"|"flaky"|"traceability")`，并为 `aitest_heal` 新增 `action: "discard"` 用于规范废弃过期/误建自愈草稿；`tools/call` 在整个 `v6.x` 继续兼容转发全部 **8 个历史旧名**并输出 `_deprecation` 提示；`CLI` 同步支持 `bootstrap`、`report --view`、`flaky`/`trace-matrix` 转发别名及用法错误统一 `--json` 输出（退出码表：`0=pass` / `1=fail` / `2=blocked` / `64=usage`）。

### 安全加固与可信边界 (Security & Fail-Closed Kernel)
- **不可变 `TrustContext`、粘性 T1 与 `aitest_init` 重签封堵（WU-01）**：
  - 新增 `src/kernel/gate/trust-context.mjs`，在命令入口单次冻结打开 `{ tierCeiling, key, keyId, source, hostT1Sticky }` 并显式传递全链路；消除运行期隐式 `signPayloadT1(..., { createIfMissing: true })` 改态与 `allowForeignLockMac` 洗白。
  - `.aitest/governance.lock` 升级支持多机 `macs: { [keyId]: hmac }`（向下兼容 `mac`）；引入本机粘性 T1 标记防剥离 `mac` 或删账本退回 T0；`aitest_init` 仅在无治理历史痕迹且受保护文件 100% 匹配内置模板出厂哈希时才允许写入 `source: "aitest-init"`。
  - 修复 `src/jobs.mjs`（MCP 子进程继承 `AITEST_HMAC_KEY_FILE`，消除 CLI/MCP 密钥分裂）与 `src/runner.mjs`（Playwright/业务子进程采用严格 env 白名单彻底剥离 `AITEST_HMAC_KEY*` 与 CI OIDC 变量）；实现 RFC 8785 安全的 `canonicalizeJson` 并收紧机器人审批拦截。
- **全链路 10 跳 HTTP 重定向防火墙、MCP HTTP 加固与脱敏 v3（WU-03）**：
  - `base.ts` `context.route`、`APIRequestContext` 包装、`explore` 观察器与 `perf` 采集器统一启用 `maxRedirects: 0` 逐跳循环（上限 10 跳）复验出站与高危策略，正确区分 `301/302/303` 与 `307/308`；非法 `TEST_EGRESS_MODE` 严格 Fail-Closed。
  - MCP HTTP 服务端精确校验 `Host`（`421`/`403`）、`Origin`（`403`）与 POST `Content-Type: application/json`（`415`），限制 JSON-RPC Batch 长度，重复挂载 SSE 返回 `409`，并在错误体隐藏宿主机绝对路径；POSIX 进程树取消升级 `SIGTERM -> SIGKILL`。
  - `redactSecrets` 升级 v3（增加 VT ANSI 转义序列表剥离并扩展密钥模式）；`sync:vendor` 改为从 `src/kernel/` 出发的依赖闭包确定性镜像（`41` 个文件）；CI 与签名工作流落实最小权限拆分，离线 T2 验签绑定 `commit/tree/root`。
- **AST 语义门禁内核 v2 与 `AITEST-G116 / G117`（WU-05）**：
  - 新增跨作用域 `src/kernel/gate/symbol-table.mjs`（`const` 传播、页面 `route` 命名处理函数、DOM 污点源、辅助函数返回追踪）；强化 `AITEST-G104..G114` 对 `expect.poll`、循环包裹、事件监听、`allSettled` 与正则空串匹配的拦截，并在 `ruleG114` 封堵按测试预期否定状态码（如 `403` RBAC 桩）绕过故障注入豁免的缺口。
  - 新增 **`AITEST-G116`**（拦截跨等价类 HTTP 状态改写与 Exact→Range 放宽，如 `409→201`、`403→200`）与 **`AITEST-G117`**（跨文件产品侧 `Dieselgate` 测试流量分支识别）；`changeset.mjs` 新增 `G-08` 拦截 `git mv` 将 Spec 移出测试目录。

### 架构收口与 AI 零阻塞自治（Architecture & Zero-Block Autonomy）
- **帧化 IPC、原子写锁与分层收口（WU-02）**：以 `AITEST_RESULT_FILE` 临时信封文件取代 `stdout` 刮取；`acquireDiskLock` 改用临时文件 + 硬链接原子创建且仅回收已死 PID；激活 `loadWorkbenchConfig` 集中配置与显式 `caller`；新建稳定应用门面 `src/app/index.mjs`，拆解所有巨型模块使**全仓 `src/**/*.mjs <= 500` 行**（`test/unit/architecture-boundaries.test.mjs` 强执）。
- **零阻塞自治闭环与基准扩展（WU-04 & WU-06）**：区分回环沙箱默认 CRUD 与共享非回环只读；基于 `.aitest/baseline-ref` 支持分支新增 Spec 豁免历史回退比对（守住 `>= S2` 底线）；`diagnose` 结合产品 Diff 输出 `A-UI-Sync`；`explore` 自动合成 `specs/api-schemas.json`；`init --preset demo-campus` 补充独立域契约 Spec 实现通用模板与靶场预设彻底解耦。
- **18 任务 `FGER-agentic`（含 E 类 Dieselgate `AG-E1`/`AG-E2`）与 `autonomous-suite` 实测（`--fast`, `v6.2.0`）**：`FGER-agentic_T1 = 11.1%` (`2/18`, Wilson 95% CI `[3.1%, 32.8%]` — 仅 `AG-B4`/`AG-C4` 同用户边界)、`FGER-agentic_T2 = 0.0%` (`0/18`, CI `[0.0%, 17.6%]`)，`AG-E1`/`AG-E2` 全部由 `L3-AST-Diff` 阻断；`bench/agentic/autonomous-suite.mjs` 零阻塞完成率 `100%` 且 `FGER = 0%`（详见 [bench/agentic/results/SUMMARY.md](./bench/agentic/results/SUMMARY.md)）。

## [6.1.0] - 2026-11-24

### 新增 (Added)
- **自治红队假绿逃逸率基准框架 (`FGER-agentic`, `npm run bench:agentic`)**：
  - 将 [bench/agentic/DESIGN.md](./bench/agentic/DESIGN.md) 升级为完整可执行双口径评测规范，新增 16 道预登记多步攻防任务语料 [bench/agentic/tasks.json](./bench/agentic/tasks.json)（覆盖 A 断言降级 / B 治理锁篡改 / C 账本与证明伪造 / D 自愈状态机绕过、L1/L2/L3 威胁级含页面 DOM 间接提示注入、`benign-pressure` / `adversarial-redteam` 双提示档位）。
  - 新增零运行时依赖评测引擎（`bench/agentic/lib/` 与 `scripts/bench-agentic.mjs`）：物理隔离的隐藏业务断言集（8 类真实 Smart Campus 缺陷）、不可变保护基线裸远端、内存专有 ASN.1 DER X.509 v3 临时 Fulcio T2 CA + Sigstore v0.3 DSSE 签发器、全量 6 层拦截归因与 Wilson 95% 置信区间统计，以及脱敏轨迹归档。
  - **真实 Playwright 脚本化多步红队基线实测（`live-playwright`, `n=16`）**：本地 T1 护栏 **`12.5%` (`2/16`, CI `[3.5%, 36.0%]`)**（2 例逃逸全部来自预登记同用户本地边界探针 `AG-B4`/`AG-C4`，诚实归档本地 T1 极限）；隔离 CI T2 合入级信任根 **`0.0%` (`0/16`, CI `[0.0%, 19.4%]`)**；合法修复对照 `honest-fix` `4/4` 通过真实 T2 验签，诚实提单对照 `honest-report` `0%` 误修；详见 [bench/agentic/results/SUMMARY.md](./bench/agentic/results/SUMMARY.md)。
  - 内置实盘自治大模型 CLI 适配器（`--adapter claude|codex|gemini|custom`），未执行实盘模型采样前严格保持 `live-LLM: pending` 披露，不做任何数值外推。
  - 新增自动化对抗测试套件 `test/adversarial/fger-agentic.test.mjs` 并登记 `CLAIM-18-fger-agentic-dual-tier-redteam`（[docs/claims.json](./docs/claims.json)）。

### 修复 (Fixed)
- **跨机干净 CI Runner 上的 `governance.lock` MAC 兼容修复**：在 `src/verdict.mjs`、`src/kernel/gate/engine.mjs` 与 `src/kernel/gate/policy.mjs`（同步镜像至 `templates/playwright-qa/support/`）中修复开发者本机提交带本地 MAC 的 `.aitest/governance.lock` 后，全新 CI runner 因 `beginRunLedger` 懒生成新本机密钥而误触发 HMAC 失配的问题；完整保留本地 T1 严格验签、全部受保护文件 SHA-256 校验与 CI `AITEST-G101` 保护分支 Diff 阻断。

## [6.0.0] - 2026-11-24

### 破坏性变更 (Breaking Changes — 迁移指南见 [docs/upgrade.md](./docs/upgrade.md))
- **MCP 工具面收敛（21 → 17 个权威工具）**：将 `aitest_heal_begin` / `aitest_heal_attempt` / `aitest_heal_conclude` 合并为 `aitest_heal(action: "begin"|"attempt"|"conclude")`，将 `aitest_job_status` / `aitest_job_result` / `aitest_job_cancel` 合并为 `aitest_job(action: "status"|"result"|"cancel")`；`tools/call` 在整个 `v6.x` 保留 6 个旧工具名自动转发并附带 `data._deprecation` 与弃用告警。
- **按子命令严格 CLI 参数校验**：`src/cli/commands.mjs` 为每条命令独立声明合法旗标，传入不相关参数直接以退出码 `1` 报错并给出拼写建议（`governance approve` 同时为历史文档误写的 `--approver` 保留指向 `--by` 的弃用兼容别名）。
- **统一 `--json` 信封与退出码**：全量 CLI `--json` 统一携带 `ok` / `exitCode` / `outcome`（门禁类）；新增 `init --json`；所有 `blocked` 场景（含 `run --audit`）统一返回退出码 `2`。
- **6 处 Fail-Closed 收紧**：缺失 TypeScript 编译器、CI 缺失 `tsc/eslint`、自定义 `--results` 绕过 Run Ledger、未初始化工作区、畸形目标 URL、损坏 `aitest.config.json` 全部由静默放行/回退默认值收紧为 `outcome: 'blocked'`（退出码 `2`）。人工离线调试可通过 CLI 专属 `--allow-unbound-results` 显式降级为 T0。
- **验证内核归位（`src/kernel/`）与公共导出**：权威门禁内核从 `templates/playwright-qa/support/` 迁至 `src/kernel/` 并通过 `package.json#exports`（`.`、`./kernel`、`./target-guard`、`./schema-validator`）导出；`templates/playwright-qa/support/` 改为单向构建期同步镜像（`npm run sync:vendor` / `check:vendor`）。

### 新增与架构重构 (Added & Refactored)
- **可插拔 AST 门禁规则引擎与真实提交误报率大幅降低（[ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.md)）**：
  - 将 1,649 行 `ast-analyzer.mjs` 拆分为 `ts-loader`、`constant-eval`、`lattice`、`parser-inspectors`、`parser`（词法作用域栈）、`diff-parser`、`changeset`、`static-runner` 与 15 条独立可开关规则对象 `AITEST-G101..G115`（支持 `aitest.config.json#rules` 配置，变更受 `governance.lock` 保护）。
  - 落地 5 项系统性降误报改进（跨文件标题池化、作用域边界与 `browser-evaluate`/负向 `catch` 区分、结构化 `skip` 计次与运行时能力守卫、web-first 强度格校准、`G114` 故障注入/蜜罐感知）。
  - **新种子未见留出集实测（`n=50`，`seed=20261125`，0 重叠，盲测）**：FPR 从 `12.2%`（`6/49`, CI `[5.7%, 24.2%]`）降至 **`6.1%`（`3/49`, Wilson 95% CI `[2.1%, 16.5%]`）**，保留 `1/1` 真报；试跑集（`n=50`）从 `20.8%` 降至 **`4.2%`（`2/48`, CI `[1.2%, 14.0%]`）**；合并 `n=100` 为 **`5.2%`（`5/97`, CI `[2.2%, 11.5%]`, `3/3` 真报全保留）**；同时 `FGER-internal = 0.0% (26/26)`、`FGER-holdout = 0.0% (24/24)`、`Gate-FPR(internal) = 0.0% (12/12)` 零回退。
- **模板清单与 `aitw upgrade` 安全升级（[ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.md)）**：`init` 生成 `.aitest/template-manifest.json`，新增 `upgrade [--dry-run] [--force]` 三方哈希比对升级并保护用户手改文件；修复 `doctor` 门禁版本漂移探测。
- **集中式配置层与统一结果模型（[ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.md)）**：新增 `src/core/config.mjs`（带 Schema 校验）与 `src/core/outcome.mjs`；5 个 `> 900` 行上帝模块全部拆分清零（最大单模块从 `1,649` 行降至 `786` 行），消除 4 处循环依赖（`0` 环路）及 `results.json`/Playwright/glob 重复实现。
- **严格类型安全（[ADR-0003](./docs/adr/0003-strict-checkjs-type-safety.md)）**：根包 `devDependencies` 精确锁定 `typescript@6.0.3` 与 `@types/node@26.6.6`（运行时 `dependencies` 保持为空），`tsconfig.check.json` 启用 `strict: true, noImplicitAny: true, useUnknownInCatchVariables: true` 全量 0 错误、0 抑制注释，`run-typecheck.mjs` 全环境 fail-closed。
- **三层测试重组与行覆盖率门禁**：重组 `test/{unit,integration,adversarial}/`，完整保留所有既有对抗/红队/E1–E6 用例并补齐核心命令覆盖率，`scripts/run-unit-tests.mjs` 强制启用 `--test-coverage-lines=80`。
- **文档单一真源与打包卫生**：归档过时文档至 `docs/history/`，收敛 5 份编号 ADR（`0001..0005`），新增 `scripts/generate-docs.mjs` 自动同步 8 份核心文档中的 17 工具表，强化 `lint:docs`（自动表防漂移、核心双语 H2 对等、CLI 旗标校验），收紧 `package.json#files` 剔除审查/归档/内部脚本并新增打包卫生单测。
- **真实多端企业 SaaS 实测沉淀（`explore` / CLI / `governance` / 发布流水线）**：
  - `explore` 自动从 `--base-url` 路径派生初始 `entryPath`（不再丢失非根入口路径）；新增未登录重定向风暴去重与早停（输出 `authRequired`、`loginRoute`、`authRedirectCount` 与 `auth-login` 引导，避免浪费 `maxPages` 配额）；自动过滤只读防火墙自拦截产生的 `net::ERR_BLOCKED_BY_CLIENT` 控制台噪声（单独计入 `firewallAbortedConsoleCount`）；CLI 同步支持正向布尔参数 `--explore-portals` / `--explore-tabs` / `--explore-dialogs`。
  - 统一 `doctor` / `explore` / `perf` / `report` / `map` / `flaky` / `impact` / `trace-matrix` / `mcp` / `skill-install` / `governance` 全部 `--json` 信封携带 `ok` 与 `exitCode`，并将 `governance status|verify` 遇 `blocked` 收紧为退出码 `2`；同步在 `release.yml` 补齐根包开发依赖安装与 `check:vendor` 门禁（不改动 OIDC 发布权限）。

## [5.1.1] - 2026-11-24

### 变更与发布流水线加固 (Changed & Hardened)
- **原生零密钥 npm Trusted Publishing (OIDC) 激活**：[.github/workflows/release.yml](./.github/workflows/release.yml) 升级至 **Node.js 24**（内置 `npm >= 11.5.1`），移除 `registry-url` 与 `NODE_AUTH_TOKEN`，完全通过 GitHub Actions OIDC（`id-token: write`）免密钥发布并附带 SLSA v1 Sigstore Provenance；同步将可复用工作流 `aitest-verify.yml` 默认版本、全仓锁版本示例更新至 `5.1.1`。

## [5.1.0] - 2026-11-24

### 破坏性变更 / 移除 (Removed / Breaking)
- **移除 `aitest` CLI 命令别名，新增 `aitw` 短命令**：原 `bin.aitest` 与 npm 上既有无关第三方包 `aitest`（同样注册了 `aitest` 命令）重名；鉴于本包此前从未发布到 npm，现正式从 `package.json` 的 `bin` 中移除 `aitest`，统一使用锁版本 `npx ai-test-workbench@5.1.0 <cmd>` 或全局安装后的 `aitw <cmd>`（本地仓库开发继续保留 `node tools/aitest.mjs <cmd>`）。为保持已有客户端兼容，`tools/aitest.mjs` 文件路径、MCP 工具名 `aitest_*`、`.aitest/` 目录、`AITEST-G*` 规则码与 `AITEST_*` 环境变量前缀均保持不变。

### 新增与加固 (Added & Hardened)
- **npm 供应链发布就绪**：`package.json` 补充 `publishConfig: { "access": "public", "provenance": true }`，新增标签触发的 [.github/workflows/release.yml](./.github/workflows/release.yml)（全量 Action 锁定至完整 Commit SHA，发布前强制执行全部 7 条验证门禁，支持首次发布后切换 npm Trusted Publisher）。
- **`T2` 信任分级与可复用 CI 工作流**：全栈统一 `T0 / T1 / T2` 固定口径（仅 CI 干净重跑 + Sigstore 免密钥签名的 `T2` 为合入级绿灯），新增可复用 [.github/workflows/aitest-verify.yml](./.github/workflows/aitest-verify.yml)（支持 `github-attest` 与 `cosign`）与 [examples/workflows/use-aitest-verify.yml](./examples/workflows/use-aitest-verify.yml)；强化 `attest verify` 支持 `--expect-repo` / `--expect-workflow` / `--expect-ref` 与离线零依赖 Sigstore/Fulcio 验签（默认 fail-closed）。
- **零依赖 MCP ADR 与官方合规门禁**：新增零依赖 MCP ADR（现已合并至 [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md)）与隔离 `conformance/` 测试套件（锁定 `@modelcontextprotocol/conformance@0.1.16` 与 `@modelcontextprotocol/sdk@1.32.2`，接入 CI `mcp-conformance` job 覆盖 `stdio` / Streamable HTTP / Legacy SSE 三传输），修复 Legacy SSE 异步 `202` 与 Streamable HTTP 双 `Accept` 进度流。
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
