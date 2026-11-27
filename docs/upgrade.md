# v5.x / v6.6 到 v6.7.0 升级与迁移指南 (`upgrade.md`)

> [English Version](./upgrade.en.md) · [版本兼容矩阵](../VERSION.md) · [四层门禁与治理指南](./governance.md) · [ADR-0007 外部图谱侧车](./adr/0007-external-code-graph-engine.md) · [更新日志](../CHANGELOG.md)

本文档完整列出 `ai-test-workbench` 从 **`v5.1.1` / `v6.1.0` / `v6.6.0`** 升级到 **`v6.7.0`** 的破坏性变更、兼容性窗口（旧别名保留至 `v6.x` 结束，将于 `v7.0.0` 移除）、`v6.5 → v6.7` 多语言 Monorepo / 图谱侧车 / 治理锁迁移步骤，以及 `@playwright/test` 日常升级流程。

---

## 1. v5.x / v6.1 → v6.7.0 核心变更一览

| 变更类别 | `v5.1.1` / `v6.1.0` 旧行为 | `v6.7.0` 新行为 | 兼容别名与迁移窗口 |
|---|---|---|---|
| **MCP 工具面收敛（21 → 17）** | 独立注册 `aitest_heal_*`、`aitest_job_*`、`aitest_flaky_report`、`aitest_trace_matrix` | 合并为 **`aitest_heal`**（含 `discard`）、**`aitest_job`** 与 **`aitest_report`**（`view: "summary" \| "flaky" \| "traceability" \| "lessons"`），并新增 **`aitest_bootstrap`** 与双目标差分先知 **`aitest_parity`**；严守 **17 个权威工具**不变，新增只读资源 `aitest://project/{target}/graph-summary` | `tools/call` 在整个 `v6.x` 继续接收上述 **8 个旧名**并自动转发，同时在 `structuredContent.data._deprecation` 和 `summary` 输出弃用告警（`v7.0.0` 移除） |
| **CLI 按命令严格参数校验** | 89 个全局平铺选项，传给无关子命令的参数会被静默忽略 | 所有子命令（含 `map --engine/--query`、`mcp install-engine`/`engine-status`（支持无 `--target` 全局查询）、`upgrade --scope engines`）在 `src/cli/` 独立声明允许选项，用法错误 `--json` 统一退出码 `64`，`mcp`/`map`/`impact` 缺失或未初始化目标统一返回结构化 `USAGE_ERROR`/`WORKSPACE_NOT_INITIALIZED` 恢复指引 | `governance approve` 保留 `--approver` → `--by`；`flaky` / `trace-matrix` 转发至 `report --view`（`v7.0.0` 移除） |
| **CLI `--json`、IPC 与退出码统一** | 通过最后一行文本刮取传递 MCP 子进程 JSON；错误退出码混用 | 全链路启用 `CommandResult v2` 统一信封与 `AITEST_RESULT_FILE` 帧化 IPC，统一退出码 `0=pass / 1=fail / 2=blocked / 64=usage` | 保留既有顶级数据字段，补充 `schemaVersion`、`blockerKind`、`recoverySteps` |
| **不可变 `TrustContext`、粘性 T1 与 Fail-Closed** | 跨机 CI `governance.lock` 放宽兼容、缺失 `mac` 可回退 `T0`、`aitest_init` 可重签锁 | 单次打开不可变 `TrustContext`；支持多机 `macs` 映射与粘性 T1；治理锁同步封签 **`.aitest/mcp.lock`** 与 **`.aitest/engine-manifest.json`**；HTTP 重定向 10 跳逐跳复验 | CLI 本地离线调试仍保留明确 `--allow-unbound-results`（降级 T0）；跨机干净 CI 自动按 SHA-256 校验并在本机保留 `T0` |
| **CodeMap v5.1、Diff-Impact v3.1 与 8 大支柱 MCP Hub** | 仅正则静态建图 (`codeMap: 4`)、文件级反依、7 大支柱 MCP | 升级为多语言 Monorepo 自发现 + L0 全栈（Vue 3 单对象路由/TS 泛型 HTTP/跨文件前缀助手/`.cjs` + Python `FastAPI`/`Flask`/`aiohttp`/`Starlette`/`Django` + SQLAlchemy/Django/DDL/TypeORM）+ L1 (`codebase-memory-mcp@0.12.1` 可选侧车，支持 `AITEST_DATA_DIR` 与临时目录 DB 零泄漏守卫) + L2 融合的 **CodeMap v5.1 (`schemaVersion: 5`)**、**Diff-Impact v3.1**（共享 `.git` Monorepo 差异重映射 + Python `.py` 反向图 + Global Infra Guard + `<20ms` `pipe-sharded-v1`）与 **8 大支柱 MCP Hub**（新增 `code-intelligence`） | `v4 → v5` 代码地图自动无缝迁移并保留运行时路由与缺陷；未装侧车时自动零依赖降级 `builtin` 模式 |
| **`aitest.config.json` Schema、SymbolTable、Dieselgate 与锁步/记忆治理** | `AITEST-G101..G115`（15 条规则） | **18 条**可插拔门禁规则（`AITEST-G101..G118`）；新增可选 `codeMap.engine` 与 `codeMap.externalEngine` Schema 校验；治理锁同步保护 `known-blockers.json`、`corpus/**`、`fixtures/upstream-cassettes/**`、`support/project-rules.json`、`.aitest/mcp.lock` 与 `.aitest/engine-manifest.json` | 所有合法 `v5` / `v6.x` `aitest.config.json` 100% 向后兼容 |

---

## 2. MCP 客户端迁移对照表

若你的提示词、脚本或 Agent 规则直接按名称调用旧工具，请按以下映射更新：

| v5 旧工具名（v6.x 转发并告警） | v6 权威调用方式 |
|---|---|
| `aitest_heal_begin({ target, testId })` | `aitest_heal({ action: "begin", target, testId })` |
| `aitest_heal_attempt({ target, sessionId, skipRun })` | `aitest_heal({ action: "attempt", target, sessionId, skipRun })` |
| `aitest_heal_conclude({ target, sessionId, outcome, summary })` | `aitest_heal({ action: "conclude", target, sessionId, outcome, summary })` |
| `aitest_job_status({ jobId })` | `aitest_job({ action: "status", jobId })` |
| `aitest_job_result({ jobId, waitMs })` | `aitest_job({ action: "result", jobId, waitMs })` |
| `aitest_job_cancel({ jobId })` | `aitest_job({ action: "cancel", jobId })` |
| `aitest_flaky_report({ target })` *(v5/v6.1)* | `aitest_report({ view: "flaky", target })` |
| `aitest_trace_matrix({ target })` *(v5/v6.1)* | `aitest_report({ view: "traceability", target })` |

---

## 3. 使用 `upgrade` 一键安全升级宿主 `<repo>/qa/` 内核

`upgrade` 结合 `<repo>/qa/.aitest/template-manifest.json` 执行三方哈希安全升级（未改动文件自动升级，人工定制文件写出为 `<file>.aitest-new` 而不静默覆盖，且**绝不自动重签 `governance.lock`**）：

```bash
# 1. 先预览将要更新的文件与冲突
npx ai-test-workbench@6.7.0 upgrade --target /path/to/repo --dry-run

# 2. 执行升级（默认仅升级 support/** 与 scripts/audit-results.mjs；传 --scope all 做全量模板对比，传 --scope engines 检查外部图谱侧车版本）
npx ai-test-workbench@6.7.0 upgrade --target /path/to/repo

# 3. 检查变更并在确认无误后，由人类在本地终端重签治理锁
npx ai-test-workbench@6.7.0 governance status --target /path/to/repo
npx ai-test-workbench@6.7.0 governance approve --target /path/to/repo --by "alice@team" --reason "升级至 ai-test-workbench v6.7.0 内核"

# 4. 确认 doctor 无内核漂移告警
npx ai-test-workbench@6.7.0 doctor --target /path/to/repo
```

---

## 4. v6.5 / v6.6 → v6.7 升级指南：多语言 Monorepo、CodeMap v5.1 与外部图谱引擎

从 `v6.5.0` / `v6.6.0` 升级至 `v6.7.0` 完全平滑，无需手改现有测试或配置文件：

1. **CodeMap v5.1 与多语言 Monorepo 自动发现**：首次运行 `npx ai-test-workbench@6.7.0 map --target /path/to/repo` 时，自动发现嵌套一级或二级容器目录（`src|apps|packages|services|modules`）下的多语言子工程（Vue 3/TS、Python `FastAPI`/`Flask`/`aiohttp`/`Starlette`/`Django`/`Pytest`、Java、Go、Rust、PHP），兼容共享 `.git` Monorepo 差异重映射与 Python `.py` 反向导入图；既有 `schemaVersion: 4` 地图仍自动无缝升级至 `5`（保留运行时路由与缺陷）并生成 `<20ms` `knowledge/graph-impact-index.json`（`pipe-sharded-v1`）。
2. **可选安装锁版本侧车图谱引擎（支持 `AITEST_DATA_DIR` 数据目录迁移与 `N-1` 回滚）**：
   ```bash
   # 在线安装官方锁版本 v0.12.1（自动校验 6 平台 SHA-256 与 Zip-Slip 防护，写入 .aitest/engine-manifest.json）
   npx ai-test-workbench@6.7.0 mcp install-engine --target /path/to/repo --engine codebase-memory-mcp

   # 离线 / 内网镜像安装（二选一，均强制校验 SHA-256）
   npx ai-test-workbench@6.7.0 mcp install-engine --target /path/to/repo --engine codebase-memory-mcp --from-file ./codebase-memory-mcp-linux-amd64-portable.tar.gz --expected-sha256 <64hex>
   npx ai-test-workbench@6.7.0 mcp install-engine --target /path/to/repo --engine codebase-memory-mcp --mirror-url https://artifacts.internal/cbm/v0.12.1

   # 检查侧车状态与版本对齐（v6.7.0 起支持不传 --target 或对未初始化仓库全局只读查询）
   npx ai-test-workbench@6.7.0 mcp engine-status
   npx ai-test-workbench@6.7.0 mcp engine-status --target /path/to/repo
   npx ai-test-workbench@6.7.0 upgrade --target /path/to/repo --scope engines --dry-run
   ```
   - 每次升版自动在隔离二进制目录保留 **`N-1`** 上一版本目录，便于秒级回滚；可通过 `AITEST_DATA_DIR`（或 `AITEST_CBM_BIN_DIR` / `AITEST_CBM_RUNTIME_DIR` / `AITEST_CBM_CACHE_DIR`）整体迁移数据目录，并通过 `os.tmpdir()` 守卫与 `AITEST_DISABLE_EXTERNAL_GRAPH=1` 防止临时测试目录在 CBM 缓存泄漏残留库；若需强制仅用内置零依赖引擎，传 `--engine builtin` 或在 `aitest.config.json` 设置 `"codeMap": { "engine": "builtin" }`。
3. **Windows Defender / EDR 与 NTFS 祖先 ACL 指引**：
   - 侧车二进制存放于 `%LOCALAPPDATA%\aitw\bin\cbm\<ver>\codebase-memory-mcp.exe`（或自定义 `AITEST_DATA_DIR\bin\cbm\<ver>\`），绝不置于 `<repo>/qa/.aitest/` 内；若企业 EDR/Windows Defender 拦截未签名开源二进制，按 `doctor` 提示将对应目录加入经审批的排除目录。
   - 若当前用户主目录存在 `CodexSandboxUsers` / `Everyone` / `BUILTIN\Users` 等受限祖先写权限导致 CBM DACL 校验失败，工作台会自动回退至 `%SystemDrive%\aitw-rt` 与 `%SystemDrive%\aitw-cbm` 并执行 `icacls /inheritance:r /grant:r "<user>:(OI)(CI)F"` 完成仅当前用户加固（显式配置 `AITEST_DATA_DIR` / `AITEST_CBM_RUNTIME_DIR` / `AITEST_CBM_CACHE_DIR` 时优先使用指定路径）。
4. **治理锁新增封签项（`.aitest/mcp.lock` 与 `.aitest/engine-manifest.json`）**：
   - `v6.6.0` 起，一旦存在 `.aitest/mcp.lock` 或 `.aitest/engine-manifest.json`，二者均自动纳入 `.aitest/governance.lock` 封签保护；完成 `mcp install-engine` 或 `mcp doctor --lock` 更新后，需由人类在本地终端执行一次 `npx ai-test-workbench@6.7.0 governance approve --target /path/to/repo --by "<human>" --reason "封签外部图谱侧车与 mcp.lock"`。

---

## 5. 安全升级 `@playwright/test` 与官方 Test Agents

1. 在 `<repo>/qa/package.json` 中保持**精确版本号**（如 `"1.65.1"`，不带 `^`），与 CI Docker 镜像 `mcr.microsoft.com/playwright:v<version>-noble` 保持一致。
2. 进入 `qa/` 执行 `npm install` 更新锁文件，并安装匹配版本的 Chromium：
   ```bash
   npx playwright install chromium
   ```
3. 预览并同步官方 Test Agents 定义：
   ```bash
   npx ai-test-workbench@6.7.0 update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench@6.7.0 update-agents --target /path/to/repo --loop codex,claude
   ```
4. 若某 Agent 文件曾被人工修改，新版模板会写出为 `<file>.aitest-new` 并返回退出码 `2`；对比合并后删除 `.aitest-new`（或显式传 `--force` 覆盖）。
5. 运行 `npm run typecheck && npm run lint`、离线 `smoke` 与目标环境回归验证，再由人类执行 `governance approve`。
