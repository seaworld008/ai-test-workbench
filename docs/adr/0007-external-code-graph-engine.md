# ADR-0007：解耦锁版本外部代码图谱侧车引擎（`codebase-memory-mcp`）、CodeMap v5 与 Diff-Impact v3

> [English Version](./0007-external-code-graph-engine.en.md) · [简体中文主文档](../../README.md) · [系统架构](../../ARCHITECTURE.md) · [治理指南](../governance.md) · [升级指南](../upgrade.md)

- **状态**：已采纳（Accepted，`v6.6.0` 全量落地并通过 1.01M-LOC 企业级多仓微服务实测与官方 Live 8/8 一致性套件验证）
- **决策日期**：`2026-11-27`

---

## 1. 背景与方案权衡（侧车解耦 vs 硬分叉 vs 源码内嵌）

在 100 万行级企业多仓微服务系统（如 Vue 2 + Spring Cloud 多租户 SaaS：12,889 文件、12 微服务、692 控制器、360 份 MyBatis XML、129 个 Feign 客户端）的端到端测试治理中，单纯依赖正则静态扫描存在四类瓶颈：

1. **大仓符号级调用图盲区**：当单次变更命中核心 Service 实现（如 `ServiceImpl#method`）、跨服务 Feign 接口或 MyBatis XML Statement 时，文件级反向依赖因高频工具类与共享模块扇入爆炸（`>= 8` 文件回退全量），无法精准收敛到受影响的 Controller → Vue 视图 → Playwright Spec；
2. **多门户路由冲突与动态基础设施盲区**：Spring `WebProperties` 常量/Ant/正则路径前缀未精确解析会导致多门户 `@RequestMapping` 碰撞；Spring `META-INF/spring.factories` / `WebFilter` / `Interceptor` / `ControllerAdvice` 与 Vue 全局组件/路由守卫缺乏显式基础设施保护时存在漏测风险；
3. **跨栈桥接割裂**：传统代码图谱工具（偏通用符号调用图）不理解 Playwright E2E 路由、动态权限菜单、Vue `crudFactory` / 模板组件、Spring 网关前缀与 MyBatis `<mapper namespace>` 映射；
4. **维护与供应链成本**：若直接 **Hard-Fork（硬分叉）** 或 **Source Vendor（源码内嵌）** 外部多语言 Tree-sitter/C/Go 图谱引擎，将破坏 `ai-test-workbench` 根包 **0 运行时依赖** 原则，引入原生 CGo/二进制编译链维护负担，且丧失跟进上游持续演进的能力。

因此我们在三种架构路线中做出明确取舍：

| 方案 | 零运行时依赖 | 上游持续跟进 | 供应链可控性 | 决策 |
|---|---|---|---|---|
| **硬分叉（Hard-Fork）** | 破坏 | 极差（持续合并冲突） | 中 | 拒绝 |
| **源码内嵌（Source Vendoring）** | 破坏（引入编译链/大体积） | 差 | 中 | 拒绝 |
| **解耦锁版本外部侧车（Pinned Sidecar + SPI）** | **100% 保持（`dependencies` 缺省）** | **优秀（清单升版 + 8/8 契约回归）** | **最高（SHA-256 + 治理锁 + 离线安装）** | **采纳** |

---

## 2. L0 + L1 + L2 三层融合架构（CodeMap v5）

我们在 `src/codemap/` 与 `src/codemap/providers/` 建立清晰的三层防腐融合架构：

1. **L0 零依赖全栈/E2E 语义提取层（始终可用，永不阻断）**：
   - `src/codemap/spring-prefix-resolver.mjs`：解析 Java `static final String` 常量、Ant 与正则匹配器及最具体路径前缀，将跨门户 `@RequestMapping` 碰撞率降至 `0%`；
   - `src/codemap/rpc-mybatis-extractor.mjs`：提取 OpenFeign / Dubbo 跨服务桥接、RocketMQ 生产者、XXL-Job 调度任务、MyBatis XML `<select|insert|update|delete>` 与 `BaseMapper<DO>` 直接库表链（支持跳过 Feign `@ApiOperation` 等注解与 `BaseMapperX`/框架中心节点隔离）；
   - `src/codemap/vue-template-factory.mjs` & `src/codemap/vue-api-extractor.mjs`：解析链式 Axios、`crudFactory` 端点生成、Vue 模板自定义标签与全局组件注册（如 `<right-toolbar>`）及后端动态下发菜单路由（支持 `Layout` 壳页与运行时路线回填）。
2. **L1 解耦锁版本侧车图谱引擎层（`src/codemap/providers/`）**：
   - 通过可插拔 Graph Provider SPI（`registry.mjs`）对接官方 **`DeusData/codebase-memory-mcp@0.12.1`**（MIT 许可，纯只读 `stdio` JSON-RPC 侧车，强制 `--ui=false` 关闭内嵌 Web UI）；
   - `cbm-client.mjs` 实施严格环境变量白名单清洗（不向侧车泄漏 `AITEST_HMAC_KEY*`、云凭据或 OIDC Token）、UTF-8 中文路径/参数处理、硬超时与跨平台进程树强杀（`killProcessTree`）以及 `8 MB` 输出上限；
   - 当侧车未安装、超时或异常时，自动优雅降级为 L0 `builtin` 模式，确保 `doctor` 仅提示 `WARN` 而不阻断核心验证工作流。
3. **L2 反腐败归一化与融合层（`cbm-normalizer.mjs` + `v5-fusion.mjs` + `sync.mjs`）**：
   - 对侧车返回的符号名、文件路径、注解等全部元数据执行 `sanitizeUntrustedCodeMetadata`（中和三反引号围栏、剥离控制/ANSI/Bidi 字符、擦除提示词投毒载荷）与凭据脱敏；
   - 仅索引 `sourceRepos` 白名单内的业务仓库并剥离 `BaseMapperX` / `Object.*` / 非应用脚本与 POJO 噪声；强制跨服务 Feign/RPC 停止边界防止跨微服务表扩散；
   - 融合产出确定性 **`knowledge/code-map.json`（`schemaVersion: 5`）**、人类可读 **`knowledge/SYSTEM_MAP.md`** 与预投影选测索引 **`knowledge/graph-impact-index.json`**，并支持基于缓存索引的秒级 `map --query <symbol>` 组合检索与 `diagnose` 租户/鉴权过滤器线索关联。

---

## 3. 跨平台短路径隔离与 Windows NTFS ACL 防御

`codebase-memory-mcp` 原生守护进程在各操作系统存在严格路径与权限校验，若置于 `<repo>/qa/.aitest/` 内会触发 Windows `MAX_PATH`（260 字符）、中文路径与共享目录权限拒止。`src/codemap/providers/engine-manifest.mjs` 强制执行跨平台短路径分群隔离（与开发者全局安装版本彻底解耦）：

| 平台 | 二进制目录 (`binDir`) | 运行时目录 (`runtimeDir`) | 缓存目录 (`cacheDir`) | 强制安全校验 |
|---|---|---|---|---|
| **Windows** | `%LOCALAPPDATA%\aitw\bin\cbm\<ver>\` | `%LOCALAPPDATA%\aitw\rt`（受限祖先 ACL 自动回退 `%SystemDrive%\aitw-rt` 并 `icacls /inheritance:r` 设为仅当前用户可写） | `%LOCALAPPDATA%\aitw\cbm`（回退 `%SystemDrive%\aitw-cbm`） | 路径长度 `< 185` 字符、禁止符号链接/联接点/系统目录、拦截 `CodexSandboxUsers` / `Everyone` 祖先写权限 |
| **macOS** | `~/Library/Caches/aitw/bin/cbm/<ver>/` | `/private/tmp/aitw-rt-<uid>` | `~/Library/Caches/aitw/cbm` | 运行时路径严格 `<= 60` 字节（满足 `104B` `AF_UNIX` 套接字预算） |
| **Linux / WSL2** | `$XDG_CACHE_HOME/aitw/bin/cbm/<ver>/` | `$XDG_RUNTIME_DIR/aitw-rt-<uid>` 或 `/tmp/aitw-rt-<uid>` | `$XDG_CACHE_HOME/aitw/cbm` | 严禁运行目录或缓存落在 WSL2 DrvFs（`/mnt/*`） |

所有平台均严禁将 `runtimeDir` 或 `cacheDir` 放在 `<qaDir>/.aitest/` 目录下。

---

## 4. `pipe-sharded-v1` `<20ms` 投影索引与 Additive-Only Fail-Closed Diff-Impact v3

为避免 `aitest_impact`（进程内只读快速通道）在每次 Git diff 计算时冷启动外部图谱进程，v6.6.0 引入读写分离预投影与三道安全闸门：

1. **`pipe-sharded-v1` 零转义 16 分片延迟水合索引（`src/impact/graph-index-codec.mjs` + `graph-index.mjs`）**：
   - 在 `map` 同步阶段将调用图、文件符号表、Controller 链与 Vue 组件父子关系编译为字符串表（`_ft`）+ 管道/分号编码的 16 分片确定性 JSON（`_fmt: 'pipe-sharded-v1'`），并裁剪 POJO/VO/DTO/DO/Enum/Test 与内置伪节点；
   - 运行 `impact` 时通过只读 `Proxy` 按需延迟水合命中的单个分片：在 1.01M-LOC 企业级基准上，CBM 索引体积从 `6.46 MB` 降至 **`4.11 MB`**，15 次中位加载耗时 **`8.76 ms`**（Builtin 模式 `1.29 MB` / **`2.17 ms`**），远低于 `< 20 ms` 预算；
   - 对调用者数量超过 `65` 的高频中心符号（如 `CommonResult#success` 3,595 调用者）写入 **`*HIGH_FAN_IN*`** 哨兵，命中即自动 Fail-Closed 回退全量，避免图谱膨胀与漏测。
2. **Global Infra Guard（`src/impact/global-infra-guard.mjs`）**：
   - 在任何图谱收敛之前，凡变更命中 Spring `META-INF/spring.factories`、`AutoConfiguration.imports`、`WebFilter`、`GlobalFilter`、`OncePerRequestFilter`、`HandlerInterceptor`、`ControllerAdvice`、`WebConfigurer`、`WebProperties`、`RequestInterceptor`、MyBatis `@Intercepts`，或 Vue `src/utils/{request,platformRequest,crudFactory}`、`src/main`、`src/permission` 及全局组件且缺完备图谱消费者时，**无条件 Fail-Closed 回退 `mode: "full"`**。
3. **Additive-Only Fail-Closed 符号收敛与证明书绑定（`src/impact.mjs` + `src/verdict.mjs`）**：
   - 仅当 `graph-impact-index.json` 覆盖率充足、变更 hunk 命中明确的最内层可调用符号（优先 Method/Function/MyBatis Statement 而非外层 Class）且解析链路完整时，才允许解除 `>= 8` 扇入悬崖并将选测收敛到精准 Java → Controller → Prefixed Route → Vue View → Playwright Spec 链；任何未映射 hunk、低覆盖或高扇入哨兵均回退全量；
   - `verify-change` 自动将 `scope.graphEngine`（`{ provider, version, binarySha256, mode, usedForNarrowing }`）写入 `in-toto Statement v1` 证明书，保证选测来源可离线审计。

---

## 5. 治理锁扩展、8 大支柱 MCP Hub 与供应链安全

1. **治理锁封签范围升级（`src/core/config-schema.mjs` + `src/kernel/gate/policy.mjs`）**：
   - 将 **`.aitest/mcp.lock`** 与 **`.aitest/engine-manifest.json`** 显式纳入 `PROTECTED_AITEST_LOCK_FILES` 与 `.aitest/governance.lock` 校验（即使常规 `.aitest/` 运行时目录被跳过遍历）；Agent 擅自修改侧车二进制清单或 MCP 锁文件将触发 Layer 0 阻断，必须由人类在本地终端执行 `governance approve`。
2. **8 大支柱 MCP Hub（`src/mcp-hub/catalog.mjs` + `auditor.mjs`）**：
   - 在既有 7 大支柱基础上新增第 8 支柱 **`code-intelligence`**（内置 `codebase-memory-mcp@0.12.1` 预设，并纳入 `enterprise-selfhosted` 与 `full-link` Profile）；
   - `mcp doctor` 对原生侧车强制核验：`--ui=false`、禁止 `update/self-update/install` 等自更新参数、精确语义化版本号与本地二进制 SHA-256（支持 `strictChecksum` 严格校验）。
3. **权威 MCP 工具面守恒（严格维持 `17` 个）与新只读资源**：
   - 遵循 [ADR-0005](./0005-mcp-surface-outcome-and-config.md)，零新增顶层 MCP 工具：在既有 `aitest_map_sync` 增加 `engine` / `query` 参数，在 `aitest_mcp_hub` 增加只读 `action="engine-status"`，并新增只读资源 `aitest://project/{target}/graph-summary`（及 `aitest://current/graph-summary`）。

---

## 6. 持续上游升级闭环与企业级实测验证

1. **人类终端安装与离线/内网镜像支持（`src/codemap/providers/engine-installer.mjs`）**：
   - `npx ai-test-workbench@6.6.0 mcp install-engine --engine codebase-memory-mcp` 仅限人类本地 CLI（永不暴露给 MCP），内置 6 平台官方 `v0.12.1` SHA-256 校验表，阻断 Zip-Slip 路径穿越，支持 `--from-file`、`--mirror-url` 与 `--expected-sha256` 离线安装，保留 `N-1` 版本支持秒级回滚；
   - `npx ai-test-workbench@6.6.0 upgrade --scope engines` 对比已安装清单与工作台固定版本，仅报告升级状态与指引，**绝不自动下载二进制或自动重签 `governance.lock`**。
2. **契约一致性测试套件与定时 CI 回归（`conformance/graph-engine/` + `.github/workflows/ci.yml`）**：
   - 内置含中文路径目录的多仓 Fixture 与 8 项契约验证（`run-conformance.mjs`），每次升版固定版本前须通过 Live `8/8 PASS` 且两次运行字节一致；CI 常规流水线执行 `--allow-skip-missing`，每周定时与手工 `workflow_dispatch` 触发 `graph-engine-conformance` Live 校验。
3. **1.01M-LOC 企业级多仓微服务实测成果**（Vue 2 + Spring Cloud 多租户 SaaS 基准：12,889 文件、12 微服务、692 控制器、360 MyBatis XML、129 Feign 客户端，代码仓全程零修改）：
   - 跨门户 `@RequestMapping` 碰撞率：`46/46 (100%)` → **`0 / 3,512 (0%)`**；
   - 典型订单控制器关联 DB 表收敛：`262` → **`10`（Builtin，-96.2%）/ `11`（CBM，-95.8%）**；
   - 深层符号级 Diff-Impact v3 选测收敛：核心 Service 方法 **`-99.78%`**（`1,366 → 3` Java 文件 → `5` Vue 视图 → `5` Spec），跨服务 Feign API **`-98.98%`**（`1,667 → 17` Java 文件，零 `Object.getClass` 噪声），MyBatis XML Statement **`-98.78%`**（`410 → 5` 文件）；
   - 高频基础设施修改（`TenantSecurityWebFilter` / `CommonResult#success` / 全局 `RightToolbar`）100% Fail-Closed 保护，动态运行时路由视图命中率达 **`79/80 (98.75%)`**，两次增量运行指纹 `FP1 === FP2` 完全确定性。
