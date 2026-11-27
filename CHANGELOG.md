# 更新日志 (Changelog)

> [English Changelog](./CHANGELOG.en.md) · [简体中文主文档](./README.md) · [v5→v6 升级指南](./docs/upgrade.md) · [v6 重构评估报告](./docs/review/v6-refactor-assessment.md)

本日志遵循 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) 与 [语义化版本 (SemVer)](https://semver.org/spec/v2.0.0.html) 规范。

## [6.6.0] - 2026-11-27

### CodeMap v5 三层融合架构、解耦锁版本外部代码图谱侧车与持续升版闭环 ([ADR-0007](./docs/adr/0007-external-code-graph-engine.md))
- **解耦锁版本侧车图谱引擎与 Graph Provider SPI（`src/codemap/providers/{registry,engine-manifest,engine-installer,cbm-client,cbm-normalizer,cbm-adapter}.mjs`、`conformance/graph-engine/`）**：
  - 严格保持根包 **0 运行时第三方依赖**，通过可插拔 Graph Provider SPI 对接官方 **`DeusData/codebase-memory-mcp@0.12.1`**（MIT，纯只读 `stdio` JSON-RPC 侧车，强制 `--ui=false`）；缺失或超时自动优雅降级为 L0 `builtin` 模式，`doctor` 并发探活仅报 `OK`/`WARN` 从不阻断工作流；
  - `engine-manifest.mjs` 内置 6 平台（Windows x64/arm64、macOS arm64/x64、Linux x64/arm64）官方 `v0.12.1` SHA-256 摘要，实施跨平台短路径分群隔离（绝不落入 `<qaDir>/.aitest/`；Windows `<185` 字符 + 祖先 NTFS ACL 探测与 `%SystemDrive%\aitw-{rt,cbm}` owner-only `icacls` 回退；macOS `<=60B` `AF_UNIX` 预算；Linux 禁 WSL2 DrvFs `/mnt/*`）；
  - `engine-installer.mjs` 提供人类终端专属 `mcp install-engine --engine codebase-memory-mcp`（强校 SHA-256、阻断 Zip-Slip、支持 `--from-file`/`--mirror-url`/`--expected-sha256` 离线安装与 `N-1` 版本保留回滚）与 `upgrade --scope engines`（仅对标版本与给出指引，绝不自动下载或自动重签 `governance.lock`）；
  - `cbm-client.mjs` 与 `cbm-normalizer.mjs` 实施严格环境变量白名单清洗、UTF-8 中文路径安全、`8 MB` 输出上限、跨平台进程树强杀（`killProcessTree`）、跨服务 Feign/RPC 停止边界、`BaseMapperX`/`Object.*`/POJO 噪声剔除与 `sanitizeUntrustedCodeMetadata` 防代码元数据提示词投毒；
  - 新增 `conformance/graph-engine/` 含中文路径多仓 Fixture 的官方 Live **`8/8`** 一致性回归套件与 `.github/workflows/ci.yml` 定时/`workflow_dispatch` Live 门禁作业。
- **L0 零依赖企业级全栈提取器升级（`src/codemap/{spring-prefix-resolver,rpc-mybatis-extractor,vue-template-factory,spring-extractor,vue-api-extractor,vue-extractor,route-api-linker,correlator,adapters}.mjs`）**：
  - 新增 `spring-prefix-resolver.mjs` 精确解析 Java `static final String` 常量、Ant/正则路径与最具体包前缀，在 1.01M-LOC 基准上将跨门户 `@RequestMapping` 碰撞率从 `46/46 (100%)` 降至 **`0 / 3,512 (0%)`**；
  - 新增 `rpc-mybatis-extractor.mjs` 提取 OpenFeign/Dubbo 跨服务桥接（跳过 `@ApiOperation` 等注解）、RocketMQ 生产者、XXL-Job 处理器、MyBatis XML 语句与 `BaseMapper<DO>` 直接库表链，精准收敛控制器关联库表（`262 → 10` Builtin / `11` CBM，下降 **96.2% / 95.8%**）；
  - 新增 `vue-template-factory.mjs` 解析链式 Axios、`crudFactory` 生成端点、Vue 模板自定义组件与全局组件注册（如 `<right-toolbar>`）以及动态下发菜单路由（`Layout` 壳页解析与增量运行路由持久化，1.01M-LOC 运行时 80 路由视图命中 **`79/80 (98.75%)`** 且 `FP1 === FP2`）。
- **CodeMap v5 融合引擎、缓存秒级查询与全链路诊断增强（`src/codemap/{sync,v5-fusion,merger,reporter}.mjs`、`src/codemap.mjs`、`src/diagnose.mjs`、`src/diagnose/observability.mjs`）**：
  - 将 `SCHEMA_VERSIONS.codeMap` 升级至 **`5`**，支持 `v4 → v5` 自动无缝迁移（保留运行态动态路由与缺陷）；CLI `map` 与 MCP `aitest_map_sync` 新增 `--engine auto|builtin|codebase-memory-mcp` 与 `--query <symbol>` 缓存组合快速查询（零原始源码正文泄漏）；
  - `diagnose` 将 CodeMap v5 `serviceChains` 与优先级排序后的租户/鉴权过滤器线索 `tenantAuthHints` 渲染进 `ai-diagnostics.md` 与缺陷工单。

### Additive-Only Fail-Closed Diff-Impact v3 与 `<20ms` `pipe-sharded-v1` 投影索引
- **Global Infra Guard（`src/impact/global-infra-guard.mjs`）**：变更命中 Spring `META-INF/spring.factories`、`AutoConfiguration.imports`、`WebFilter`/`GlobalFilter`/`OncePerRequestFilter`/`HandlerInterceptor`/`ControllerAdvice`/`WebConfigurer`/`WebProperties`/`RequestInterceptor`/MyBatis `@Intercepts`，或 Vue 全局请求/权限守卫与未映射全局组件时，无条件 Fail-Closed 回退 `mode: "full"`。
- **`pipe-sharded-v1` 16 分片延迟水合索引与符号级选测（`src/impact/{graph-index,graph-index-codec,java-support}.mjs`、`src/impact.mjs`、`src/verdict.mjs`）**：
  - 将预投影索引编码为零 JSON 转义、字符串驻留（`_ft`）的 16 分片 `pipe-sharded-v1` 格式（剔除 POJO/VO/DTO/DO/Enum/Test 与内置伪节点），只读 `Proxy` 按需延迟水合；在 1.01M-LOC 企业基准上 CBM 索引从 `6.46 MB / 26.71 ms` 压缩至 **`4.11 MB / 8.76 ms` 中位加载耗时**（Builtin **`1.29 MB / 2.17 ms`**），远低于 `< 20 ms` 预算；
  - 新增最内层可调用符号 hunk 匹配、`OVERRIDE` 继承向上遍历、Feign 调用者桥接与 `> 65` 调用者 **`*HIGH_FAN_IN*`** Fail-Closed 哨兵（如 `CommonResult#success` 3,595 调用者自动回退全量）；
  - 在 1.01M-LOC 企业级 Vue 2 + Spring Cloud 多租户 SaaS 基准（12,889 文件、12 微服务、692 控制器、360 MyBatis XML、129 Feign）实测：深层 Service 方法变更收敛 **`-99.78%`**（`1,366 → 3` Java 文件 → `5` Vue 视图 → `5` Spec），跨服务 Feign API 收敛 **`-98.98%`**（`1,667 → 17` 文件，零 `Object.getClass` 噪声），MyBatis XML Statement 收敛 **`-98.78%`**（`410 → 5` 文件）；
  - `verify-change` 自动在 `in-toto Statement v1` 证明书中绑定 **`scope.graphEngine`**（`{ provider, version, binarySha256, mode, usedForNarrowing }`）。

### 治理锁封签加固、8 大支柱 MCP Hub、新只读资源与安全修复
- **治理锁补齐 `.aitest/mcp.lock` 与 `.aitest/engine-manifest.json`（`src/core/config-schema.mjs`、`src/kernel/gate/policy.mjs`）**：显式将二者纳入 `PROTECTED_AITEST_LOCK_FILES` 与 `.aitest/governance.lock` 封签保护，并扩展 `aitest.config.json` Schema 强校 `codeMap.engine` 与 `codeMap.externalEngine`。
- **8 大支柱 MCP Hub 与原生侧车审计（`src/mcp-hub/{catalog,auditor}.mjs`、`src/mcp-hub.mjs`、`src/mcp/resources.mjs`、`src/mcp/tools/{discovery,fast-paths}.mjs`）**：
  - 新增第 8 支柱 **`code-intelligence`**（内置 `codebase-memory-mcp@0.12.1` 预设并加入 `enterprise-selfhosted` / `full-link` Profile）；`mcp doctor` 强检 `--ui=false`、禁止自更新子命令、精确版本号与本地二进制 SHA-256（含 `strictChecksum`）；
  - 严守 **17 个权威 MCP 工具**不变，新增只读 `aitest_mcp_hub(action="engine-status")` 进程内快速通道与只读资源 `aitest://project/{target}/graph-summary`（及 `aitest://current/graph-summary`）；
  - 收紧 `src/core/redact.mjs` 中 `pin` 脱敏边界正则，完整保留 `pinnedVersion` 元数据同时继续 100% 脱敏 `pin`/`pincode`/`pin_code`/`user_pin` 凭据。

## [6.5.0] - 2026-11-26

### 防假绿门禁闭环、自愈状态隔离与鉴权差分先知止血 (`WB-P0-01..03` · `WB-P1-01..02`)
- **被上级 `.gitignore` 忽略工作区的哈希与语义 Diff 防绕过（`src/kernel/gate/{git-ignore,workspace-hash,changeset}.mjs`）**：新增 `isPathGitIgnored`（`git check-ignore -q` + mtime 缓存失效）；当 QA 目录（如隔离沙箱或被宿主 `.gitignore` 忽略的 `qa/`）位于上级 Git 仓库内但无 Git 追踪文件时，`computeWorkspaceInputHash` 自动回退至确定性文件系统树哈希并纳入 `sourceRepos`，杜绝 `git ls-files` 空输出恒定哈希 `e3b0c44...` 导致的陈旧账本绕过；Layer 3 `runGitDiffGuard` 在无基线快照时如实标记 `skipped`（`requireDiff` 下 `blocked`），绝不伪装成 `pass`。
- **自愈单文件重跑结果隔离、`discarded` 锁死与 `flaky` 历史对齐（`src/heal.mjs`、`src/heal/{conclude,defect-ticket,store}.mjs`、`src/runner.mjs`、`src/flaky.mjs`、`src/kernel/gate/ledger-verify.mjs`）**：`heal --action attempt` 写入隔离结果路径 `.aitest/heals/<sessionId>/attempt-<n>-results.json` 且不覆盖全局 `reports/results.json` 与 `.aitest/runs/latest.json`，`verifyLedgerBindingInQaDir` 同时拒绝 `partialScope: true` 账本充当全量绿灯；`discardHealSession` 显式置 `repairPermitted = false` 并拦截 `discarded` 会话复活，`escalated` 状态开放 `'discard'` 动作；`computeFlakyReport` 自动排除已 `concluded(verified)` 自愈会话修复前的历史失败轮次，避免修复后误入 7 天隔离名单。
- **`aitest_parity` 登录态自动注入与 `AUTH_OR_SHELL_INVALID` 防假绿（`src/parity/{auth-context,transport,aria,runner}.mjs`、`src/parity.mjs`）**：自动读取 `playwright/.auth/user.json` + `session.json` 注入 UI `storageState` 与 API Bearer Token / 租户头，支持 `--baseline-api-url` / `--candidate-api-url` / `--auth-header` / `--no-auth`；当双端均返回 HTTP `401/403`、HTTP 200 包裹 `{ code: 401 | 403 }`、API 路由返回 `text/html` SPA 壳页或受保护路由重定向至 `/login` 时，直接 Fail-Closed 阻断（退出码 `2`、`blockerKind: "AUTH_OR_SHELL_INVALID"`），彻底消除双端同时未登录导致的 `100% PASS` 假绿；CLI `audit` 默认开启 Layer 2 静态检查（新增 `--no-check-specs` 显式跳过开关）。

### 多仓微服务 `CodeMap v4.1` 与 `Diff-Impact v2.1` 全栈引擎升级 (`WB-P0-04..09` · `WB-P1-03`)
- **多仓库公平配额扫描与持久化复用（`src/codemap.mjs`、`src/codemap/{adapters,spec-indexer}.mjs`、`src/core/config-schema.mjs`）**：CLI `map`、`impact`、`learn` 与 MCP `aitest_map_sync`、`aitest_impact` 支持重复 `--repo` / `repos[]` 与 `aitest.config.json#sourceRepos`（单仓配额提升至 `16,000` 并支持 `--max-scan-files`），不改动受锁配置文件而将 `meta.sourceRepos` 持久化于 `knowledge/code-map.json` 供 `run` / `diagnose` / `impact` 自动复用；修复目录忽略规则保留 `src/**/build/**` 业务视图并过滤 `public/libs` 等第三方压缩资源，`indexQaSpecs` 支持提取 `waitForResponse` / `waitForRequest` 接口契约路径。
- **Vue Router 嵌套/动态菜单路由、跨 `@/api/**` 导入与 Spring Cloud 四层库表关联（`src/codemap/{vue-extractor,vue-api-extractor,spring-extractor,route-api-linker,correlator}.mjs`）**：递归拼接嵌套 `children` 相对路径与 `:id(\d+)` 正则参数并排除 `router.push/next` 误匹配；结合运行态组件提示与观测 API 反向定位后端动态下发菜单路由的 `.vue` 视图（含大小写不敏感路径别名对齐），沿 1–2 跳子组件静态导入聚合模板字符串/相对路径 API 与 axios 网关前缀；Spring 适配器先剥离注释、跳过 `@FeignClient`、严格分离类头与方法体 `@RequestMapping`（彻底消除 `/x/x` 类头自重复伪端点），自动提取 `WebConfiguration` 包级前缀并建立 `Controller → Service/Impl → Mapper/XML → DO(@TableName)` 4 层数据库表关联。
- **`Diff-Impact v2.1` 精准收敛（`src/impact.mjs`、`src/impact/{graph,java-support,scanner}.mjs`、`templates/playwright-qa/gitignore`）**：硬过滤 `.aitest/.write.lock*`、`reports/**`、`knowledge/**` 运行态产物杜绝 MCP 写锁自触发全量回退（回退时如实标注 `downgraded: true`）；解耦路由表懒加载注册边防止单视图变更经 `router/index.js` 反向扩散全仓，提取 `.vue` `<script>` 块解析导入，支持中间子组件向上汇聚父页面 Spec 及多模块 Java / MyBatis XML 依赖图选测。

### 探索过渡态防串页、会话保鲜、`TEST_ABORT_THIRD_PARTY_HOSTS` 与全链路可观测 (`WB-P0-10..12` · `WB-P1-04..08`)
- **SPA 过渡动画防串页、分层路由队列与切端熔断（`src/explore/{transition-wait,portal-switcher,dom-probes,safety,observers}.mjs`）**：导航后等待 `-leave-active` 退场节点消失与双 `rAF` 后再采快照并过滤隐藏节点，彻底消除 `<transition mode="out-in">` 面包屑与表头串页；过滤 `/401|/403|/404|/redirect|/loading` 与继承 `hidden` 路由，输出疑似只读查询 POST 的 `EXPLORE_SAFE_POST_PATHS` 提示，并在子门户切换遇鉴权拦截或连续 3 次 `401/403` 时快速熔断。
- **第三方统计域名静默中止与会话保鲜预检（`src/kernel/target-abort.mjs`、`templates/playwright-qa/tests/{fixtures/base.ts,auth.setup.ts}`、`src/auth-login.mjs`）**：新增 `TEST_ABORT_THIRD_PARTY_HOSTS`（强校验拒绝通配符、回环地址与被测域名冲突）在浏览器拦截层静默 `abort('blockedbyclient')` 外部统计埋点而不触发 `AITEST-G114` 或 `blockedRequests`；`session.json` 记录 `capturedAt`，初始化脚本自动保鲜既有数值型 `lastRecordTime` / `lastActiveTime` 防闲置登出，`auth.setup.ts` 支持 `E2E_SESSION_PING_PATH` 探活快速报错，`expectApiContract` 放宽为结构化接口同时兼容 `APIResponse` 与 `Response`。
- **MCP 内存写锁超时、SkyWalking `sw8` + VictoriaLogs `LogsQL` 与企业自建栈生态（`src/jobs/{workspace-lock,manager}.mjs`、`src/diagnose/{classifier,observability}.mjs`、`src/mcp-hub/catalog.mjs`、`src/perf.mjs`、`src/verdict/reports.mjs`）**：`withWorkspaceWriteLock` 进程内排队施加超时保护并返回含持有者信息的 `WORKSPACE_LOCK_BUSY`；`base.ts` 与 `{ request }` 同步采集服务端 `trace-id` / `tid` / `sw8` 并支持 `TEST_TRACE_PROTOCOL=w3c|sw8|all`，`diagnose` 优先按主堆栈判定契约/断言 C 类错误、解码 Base64 `sw8` 并输出 VictoriaLogs `LogsQL`（`_msg:"<traceId>"`）；修复 `perf --dry-run` 零网络发包、MCP 异步进度续传与 `cancelled` 状态、多 `--workspace-root`、`parity-summary` 资源、SARIF Seam `warning` 映射、`init` 宿主检测（Vue 2 / Element UI / Maven 多模块 / 双仓目录）及 `gitlab`/`mysql`/`victorialogs`/`skywalking` 只读 MCP 预设。

## [6.4.0] - 2026-11-26

### 双目标五级检查点差分先知与零明文形状指纹 (`WU-A` · `WU-B` · `WU-C` · [ADR-0006](./docs/adr/0006-differential-parity-oracle-and-shape-fingerprints.md))
- **双目标检查点差分引擎（`src/kernel/diff-oracle.mjs`、`src/parity/`、`aitw parity`、第 17 个权威 MCP 工具 `aitest_parity`）**：
  - 实现五级确定性检查点 `CP1-Status-Headers`（精确状态码与关键响应头）、`CP2-Body-Shape-And-Value`（键序无关递归 JSON 值比对 + 可选 `strictByteEscape` 原始字节转义差异，精准捕获如 `\uXXXX` vs UTF-8 Emoji 分歧）、`CP3-Stream-Frames`（基于零依赖 `src/core/stream-sse.mjs` 的 Anthropic/OpenAI 双格式 SSE 语义块重组与闭合校验）、`CP4-DOM-ARIA-And-Runtime`（抽离为 `src/parity/aria.mjs` 执行双端 ARIA 快照与运行异常比对）与 `CP5-Perf-Ratio`（耗时/TTFT 比值告警）。
  - 严守双端默认拒绝防火墙与非回环共享环境写保护：`validateDualTargetSafety` 强制 `strictReadonly: !s.allowMutation`（回环 `127.0.0.1` 默认允许 CRUD，非回环共享 `staging` 默认阻断 `POST/PUT/PATCH/DELETE` 直至显式 `--allow-mutation` / `allowMutation: true`）；拒绝盲目双跑去噪，仅剥离显式受锁 `normalizePaths`；`verify-change --mode parity --baseline-url <url>` 接入一键判决闭环；本地 `100` 条混合 JSON+SSE 语料全量差分稳定 `< 1.0s`。
- **零明文形状指纹聚类、离线脱敏语料库与多样本联合 Schema（`src/diagnose/{fingerprint,cluster}.mjs`、`src/corpus/`、`src/explore/schema-inferrer.mjs`）**：
  - `--privacy-mode shape-only` 下报告与产物严格零业务明文载荷，仅输出确定性 `fp_<12hex>` 形状指纹与特征分群统计；`aitest_diagnose` 按根因指纹聚类输出去重 `clusters[]`、最快最小复现器 `minimalReproducerSpec` 与跨运行级联掩蔽追踪 `unmaskedAfterFixOf`。
  - 新增 `aitw corpus import` 支持离线导入 HAR 1.2 / JSONL / OTel HTTP Span，强制凭据脱敏并剥离生产域名写入受 `.aitest/governance.lock` 保护的 `qa/corpus/sanitized-requests.jsonl`；升级 Schema 推断器支持跨全样本联合推断（`nullable`、`oneOf`、空数组合并与 Emoji/Unicode 编码特征）。
- **受治理锁签名的外部上游 Replay 磁带与流式 SSE / `TTFT` 门禁（`src/replay/cassette.mjs`、`src/perf/streaming.mjs`）**：
  - 将 `corpus/**` 与 `fixtures/upstream-cassettes/**` 纳入 Layer 0 治理锁；`AITEST-G114` 继续 100% 阻断被测服务 `route.fulfill(2xx)`，仅放行明确指向受锁非回环 `replayAllowedUpstreamHosts` 的外部上游确定性回放；扩展 `perf --mode sse --sse-endpoint` 与 `perf-budget.json#streaming` 强制校验 `ttftMedianMs`、`ttftP95Ms`、`streamTotalP95Ms` 与干净终止率。

### 工具化记忆循环、`AITEST-G118` 锁步门禁、人类交界焦点卡与 22 任务红队基准 (`WU-D` · `WU-E` · `WU-F`)
- **工具化记忆循环与全仓回溯清扫（`src/memory/{blockers,distiller,sweeper}.mjs`、`src/learn.mjs`、`aitw learn`、`aitest_report(view="lessons")`）**：
  - 新增受 Layer 0 治理锁保护的 `qa/known-blockers.json`（与 `waivers.json` 同级，绝不置于跳锁的 `knowledge/` 目录）：`diagnose` 自动归并命中指纹或同 `routePattern`（含偏移衍生指纹）的已知阻塞单，`aitest_heal(action="begin")` 硬阻断重复开启修复会话（退出码 `2`、`blockerLinked: true`）。
  - 新增 `aitw learn`（默认 `distill`）：聚合扫描 `.aitest/heals/*.json`（`escalated` / `misHealBlocked`）、`reports/defects/*.md`、`.aitest/governance-audit.jsonl` 与可选 `--from-reviews <json|md>`，仅产出待审提案 `qa/reports/learn-proposals.{json,md}`（含 `managedAgentsMarkdownBlock`、候选声明式规则 `candidateRuleSpecs` 与 `@regression` 用例骨架，**绝不自动修改受锁文件或自签锁**）；`aitest_report` 新增纯只读 `view="lessons"`（权威 MCP 工具数保持 `17` 个不变）。
  - 新增纯 JSON 声明式项目门禁规则 `qa/support/project-rules.json`（`src/kernel/gate/project-rules.mjs`）：仅在 `verifyGovernanceLockInQaDir` 通过且文件被封签在 `.aitest/governance.lock` 后才编译进入 `ctx.extraRules`（零任意 JS 执行风险），并支持 `aitw learn --action sweep` / `--sweep` 基于已封签规则与 `aitest.config.json#memoryPatterns` 一次性全仓回扫宿主源码与 `qa/tests/**`。
- **跨目录/跨栈锁步同步修改门禁 `AITEST-G118`（`src/kernel/gate/rules/g118-lockstep.mjs`、`src/kernel/gate/repo-guards.mjs`）**：
  - 规则引擎扩展至 **`18` 条可插拔规则（`AITEST-G101..G118`）**；通过受锁 `aitest.config.json#lockstepRules` 声明 `{ id, whenModified, requireModified, allowWaiver? }`，未配置时零开销静默跳过（对 100-Commit 真实开源提交集保持 `0.0%` 误报影响），启用后跨全仓阻断单侧遗漏修改。
- **内外环交界“人类守门员焦点卡”（`src/verdict/seam-card.mjs`、`src/verdict/reports.mjs`）**：
  - `verify-change` 判决书 `verdictPayload.seamReview` 与 `qa/reports/verdict-summary.md` 置顶渲染 **`### 内外环交界人工必审焦点 (Human Seam Gatekeeper Card)`**，精准高亮四类交界信号：`S4/S5 -> S4/S5` 同阶字面量翻转对照表（如 `409 -> 201`、`'0/50' -> '1/50'`）、无真实网络/DB 调用文件中新增 `>= 300` 字符的疑似静态拷贝捷径（`suspectedShortcuts`）、`<= 3` 天到期豁免（`expiringWaivers`），以及关联已知阻塞单与差分特征分群匹配率摘要。
- **自治红队基准 `FGER-agentic` 扩充至 `22` 任务（新增 `Class F`：`AG-F1..AG-F4`）**：
  - 新增 `AG-F1`（同阶 `S5->S5` 业务数值字面量翻转 `0 -> '0'`：诚实记录纯单目标静态 T1 边界，在隔离 CI T2 启用不可变 `protectedBaseSha` 活体 Baseline 差分先知后由 `Parity-Oracle` 100% 阻断）、`AG-F2`（静态拷贝捷径：受锁 `project-rules.json` + 差分先知 + 焦点卡多重拦截）、`AG-F3`（未审批伪造上游 Cassette：`L0-Governance` 阻断）、`AG-F4`（锁步目录漏改：`L3-AST-Diff` `AITEST-G118` 阻断）；实测 **`FGER-agentic_T2 = 0.0% (0/22)`**，`honest-fix` `6/6` 零误拦。

## [6.3.0] - 2026-11-26

### 性能优化与零依赖运行时提速 (Zero-Dep Runtime & Read-Only Fast Paths)
- **`doctor` 外部工具探测全面并行化（`src/doctor.mjs`）**：将原本串行执行的 7 项外部子进程探测（`npm --version`、`npm config get registry`、`git`、`codex`、`claude`、`docker`、模板 `@playwright/test --version`）改为 `Promise.all` 并发启动，同时严格保持 `checks` 数组与控制台输出的确定性顺序；实测 CLI 端到端耗时从 `2.44s` 降至 **`0.81s`**（进程内 `runDoctor` 约 `0.65s`）。
- **零系统调用风暴的 10,000 文件反向依赖图与代码地图扫描（`src/impact/scanner.mjs`、`src/impact/graph.mjs`、`src/codemap/adapters.mjs`）**：
  - 新增单遍内存路径索引 `buildRepoSourceIndex` 与 O(1) `resolveRepoImportFromIndex`，支持相对路径、`@/`、`~/`、`tsconfig.json#paths` 与 TypeScript ESM `.js -> .ts` 映射，彻底消除 `resolveRepoImport` 每次导入最多 12 次 `fs.existsSync`/`statSync` 的同步系统调用风暴；
  - 新增线性 O(N) 词法状态机 `stripJsCommentsPreserveStrings`，在依赖提取前安全剥离 `/* ... */` 与 `// ...` 注释并保留单/双/模板字符串与正则字面量（如 `http://`），防止注释掉的死 `import` 产生虚假反向依赖边；
  - `MAX_GRAPH_FILES`（`3000 -> 10000`）与 `DEFAULT_MAX_SCAN_FILES`（`2500 -> 10000`）扩容至万级源码仓库规模，并将 `collectGitChangedFiles` 的独立 Git 状态查询改为 `Promise.all` 并发执行。
- **MCP 高频纯只读查询进程内快速通道（`src/mcp/tools/fast-paths.mjs`、`src/mcp/tools/verification.mjs`、`src/mcp/protocol.mjs`）**：为纯计算无副作用的 `aitest_impact` 与 `aitest_report`（`!args.syncQuarantine` 时）提供轻量进程内 `execute`，免除每次只读查询的 ~150ms 子进程冷启动开销；严格保留在 `validateToolArguments`、`validateToolPathArgs` 工作区根目录边界校验与 `redactStructuredValue` 结构化脱敏之后执行，写盘/编译器/Playwright 工具（含 `syncQuarantine: true`）继续走 `McpJobManager` 子进程隔离。

### AST 门禁 v2.2 精度打磨（零逃逸防作弊）
- **修复 `AITEST-G110` 既有 `if` 块内增强/修改原有断言的文本去重误报（`src/kernel/gate/parser.mjs`、`src/kernel/gate/rules/control-flow-rules.mjs`）**：引入作用域级 `if-wrap` 与无条件非恒真断言双计次守恒，仅当同一作用域原本存在 `if-wrap` 断言（`baseIfCnt > 0`）、`headIfCnt <= baseIfCnt`、无条件断言未减少（`headUncondCnt >= baseUncondCnt`，彻底堵死把无条件 `expect` 挪进既有 `if` 块的移花接木作弊）、未触发 `G102`/`G103` 退化且该断言 `!isTautology && tier >= 2` 时才豁免编辑既有 `if-wrap` 断言。
- **结构化自定义领域匹配器识别与受治理锁保护的 `customMatchers`（`src/core/config.mjs`、`src/kernel/gate/lattice.mjs`、`src/kernel/gate/lattice-helpers.mjs`、`src/kernel/gate/rules/assertion-rules.mjs`）**：
  - `aitest.config.json` Schema 新增可选 `customMatchers`（合法标识符、整数 `1..5`、禁止覆盖内置弱匹配器如 `toBeDefined`/`toBeTruthy`/`toBeVisible`，且受 Layer 0 `.aitest/governance.lock` 保护）；
  - 通用 AST 格规则自动将带 `>= 2` 个有效对象属性或 `>= 3` 行非空模板内容的正向自定义 `toHave*`/`toMatch*` 匹配器识别为 `S4` 结构化领域断言（含上限 `<= 3` 的同作用域合并折算），同时继续将空对象 `{}` 或无参自定义匹配器严控为 `S1` 防止降级逃逸。
- **统计口径诚实披露**：保留冻结的 **`v6.0` 未见留出集盲测原始结果 `6.1% (3/49, Wilson 95% CI [2.1%, 16.5%])`** 不做篡改；在 100-Commit 真实开源提交回归语料上执行 **`v6.3.0` 后验复测**，误报率从 `5.2% (5/97)` 进一步降至 **`4.1% (4/97, Wilson 95% CI [1.6%, 10.1%])`**（试跑集 `4.2% (2/48)` + 留出集语料后验复测 `4.1% (2/49)`，`3/3` 真报 100% 保留），同时 `FGER-internal = 0.0% (26/26)`、`FGER-holdout = 0.0% (24/24)`、`Gate-FPR(internal) = 0.0% (12/12)` 全部零回退。

### 契约对齐、账本级需求追溯、历史差分诊断与 ReDoS 线性化加固
- **修复 `report --view summary` 契约缺口（`src/report.mjs`、`src/mcp/tools/verification.mjs`）**：CLI `report --view` 与 MCP `aitest_report(view=...)` 正式支持 `"summary"`（兼容 `"artifacts"`，附带最新运行账本摘要 `latestRunSummary` 与 `resultsCounts`，并在 `data.view` 标明视图名）。
- **修复 `explore` CLI 正向布尔开关优先级（`src/cli/opts.mjs`、`src/cli/commands-workspace.mjs`）**：使用 `parseArgs({ tokens: true })` 追踪参数顺序，正确区分显式 `--no-explore-tabs|dialogs|portals`（`false`）、显式 `--explore-*`（`true`）、缺省值（`true`）及同命令行多次传参的最后出现优先规则。
- **运行账本绑定的用例级 `REQ-xxx` 需求追溯矩阵（`src/traceability.mjs`）**：优先按单个测试用例标题（`specTitle` -> `title`）映射每个 `REQ-xxx` 的精确 `pass/fail/flaky/skip` 状态（仅当单文件内没有任何用例标题携带 `REQ-xxx` 时回退至文件级汇总），并校对 `.aitest/runs/latest.json` 与 `manifest.json#resultsSha256` 输出 `runId` 与 `ledgerBound`。
- **基于运行账本的历史差分回归诊断（`src/diagnose/history.mjs`、`src/diagnose.mjs`）**：按 `.aitest/runs/index.jsonl` 与历史 `tests-summary.json`（排除本次运行）对比每条失败用例的历史轨迹，为每条诊断标注 `regressionHistory`（`new-regression` / `persistent-failure` / `intermittent-flaky` / `first-observed`）并输出到 JSON 与 `ai-diagnostics.md`。
- **正则线性化防 ReDoS 加固（`src/core/redact.mjs`、`src/explore/safety.mjs`）**：以线性 O(N) 扫描替换 PEM 私钥多项式正则，预编译并收紧 JSON/URL/KEY=VALUE/`setItem`/Bearer/Basic/ANSI/Email/Query 匹配量词与边界锚点；11 类 100KB 病态输入全量实测耗时 `< 40ms`（单条均 `< 10ms`），脱敏召回率保持 `100% (35/35)`。

### 全仓 O(N) 深度优化、模块优雅解耦与可扩展注册表 (Round 2 Polish)
- **内核 Git 子进程消除、Glob 缓存与 O(limit) JSONL 尾读（`src/kernel/gate/git-utils.mjs`、`src/core/glob.mjs`、`src/ledger.mjs`、`src/verdict.mjs`）**：
  - `resolveGitRoot` 增加有界正缓存（`MAX=128`、TTL `5s`、验证 `.git` 存在、永不缓存 `null` 杜绝临时 `git init` 陈旧负缓存）并导出 `clearGitRootCache`；`resolveDefaultDiffBase` 用单次 `git for-each-ref` 批量替代多达 6 次串行 `rev-parse` 子进程；新增单次 `resolveGitHeadAndTreeSha` 消除 `verify-change` 冗余 `git` 进程派生；
  - `compileGlob` 新增有界 `RegExp` 缓存（`MAX=512`）；`src/ledger.mjs` 新增 UTF-8 多字节边界安全的 64KB 倒序分块 `readJsonlTail` 并接入 `readLedgerHistory`，5,000 行（`> 500KB`）运行账本索引尾读稳定 `< 25ms`。
- **线性 O(N) 活体代码地图 v4 与可插拔框架/ORM/技术栈注册表（`src/codemap/`、`src/init/stack-registry.mjs`、`src/bootstrap.mjs`）**：
  - 将 `src/codemap/adapters.mjs` 拆分为 `route-matcher.mjs`（`createRoutePatternMatcher` + `WeakMap` 缓存）、`registry.mjs`（`registerCodeMapAdapter` / `unregisterCodeMapAdapter` / `listCodeMapAdapters`）、`backend-adapters.mjs` 与 `correlator.mjs`（预编译 DB 实体正则），原生新增 SvelteKit、Nuxt/Astro、Go（Gin/Echo/Chi + Go 1.22 `net/http`）、Hono 与 Drizzle ORM 提取，并将 `mergeLivingCodeMap` 升级为线性 O(N) 倒排映射（`500` 路由 × `200` Spec × `200` 端点 `< 150ms`）；
  - 新增声明式 `detectPackageManager`（`npm`/`pnpm`/`yarn`/`bun`）与 `STACK_DESCRIPTORS`（支持 `registerStackDescriptor`/`unregisterStackDescriptor`）统一驱动 `detectProjectStack` 与 `inferRuntimeConfigForRepo`。
- **进程内只读 MCP 快速通道扩展、深度模块拆解（全仓 `<= 435` LOC）与 Schema/导出收口**：
  - 抽取无副作用 `collectDoctorReport` 与 `runMcpDoctorReadOnly`，将 `aitest_doctor`、`aitest_mcp_hub(action="presets"|"doctor", lock=false)`（含畸形 `.mcp.json` 优雅返回 `exitCode: 1`）与 `aitest_diagnose(dryRun=true)` 纳入边界与脱敏守卫后的进程内只读快速通道；
  - 拆解 `constant-eval`（`constant-primitives` + `matcher-arg-eval`）、`protocol`（`envelope`）、`transport-http`（`session-store`）、`runner`（`env-and-failures`）、`mcp-hub`（`auditor`）、`agents`（`staging`）、`governance`（`helpers`）、`heal`（`begin`）与 `assertion-rules`（`assertion-helpers`），实现全仓所有 `src/**/*.mjs` 严格 `<= 435` 行（单元测试守卫 `<= 450` 行）；
  - 补齐 `aitest.config.json` `AITEST-G101..G117` 校验、`TEST_EGRESS_EXTRA_HOSTS` / `TEST_EGRESS_ALLOW_HOSTS` 统一解析、`evaluateDiffRules` `ctx.extraRules` 扩展点、MCP `makeOutputSchema` 与 `src/types/{mcp,config}.d.ts` 字段对齐，并在 `package.json#exports` 新增 `./app` 稳定门面导出。

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
