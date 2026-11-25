# v5.x 到 v6.2.1 升级与迁移指南 (`upgrade.md`)

> [English Version](./upgrade.en.md) · [版本兼容矩阵](../VERSION.md) · [四层门禁与治理指南](./governance.md) · [更新日志](../CHANGELOG.md)

本文档完整列出 `ai-test-workbench` 从 **`v5.1.1` / `v6.1.0`** 升级到 **`v6.2.1`** 的所有破坏性变更、兼容性窗口（保留至 `v6.x` 结束，将于 `v7.0.0` 移除）、自动化迁移命令，以及日常升级 `@playwright/test` 的维护流程。

---

## 1. v5.x / v6.1 → v6.2.1 破坏性变更一览

| 变更类别 | `v5.1.1` / `v6.1.0` 旧行为 | `v6.2.1` 新行为 | 兼容别名与迁移窗口 |
|---|---|---|---|
| **MCP 工具面收敛（21 → 16）** | 独立注册 `aitest_heal_*`、`aitest_job_*`、`aitest_flaky_report`、`aitest_trace_matrix` | 合并为 **`aitest_heal`**（含 `discard`）、**`aitest_job`** 与 **`aitest_report`**（`view: "summary" \| "flaky" \| "traceability"`），并新增 **`aitest_bootstrap`**；`tools/list` 暴露精确 **16 个权威工具** | `tools/call` 在整个 `v6.x` 继续接收上述 **8 个旧名**并自动转发，同时在 `structuredContent.data._deprecation` 和 `summary` 输出弃用告警（`v7.0.0` 移除） |
| **CLI 按命令严格参数校验** | 89 个全局平铺选项，传给无关子命令的参数会被静默忽略 | 所有子命令（含 `bootstrap` 与 `report --view`）在 `src/cli/commands.mjs` 独立声明允许选项，用法错误 `--json` 统一退出码 `64` | `governance approve` 保留 `--approver` → `--by` 弃用告警别名（`v7.0.0` 移除）；`flaky` / `trace-matrix` 作为 `report --view` 别名保留 |
| **CLI `--json`、IPC 与退出码统一** | 通过最后一行文本刮取传递 MCP 子进程 JSON；错误退出码混用 | 全链路启用 `CommandResult v2` 统一信封与 `AITEST_RESULT_FILE` 帧化 IPC，统一退出码 `0=pass / 1=fail / 2=blocked / 64=usage` | 保留既有顶级数据字段，补充 `schemaVersion`、`blockerKind`、`recoverySteps` |
| **不可变 `TrustContext`、粘性 T1 与 Fail-Closed** | 跨机 CI `governance.lock` 放宽兼容、缺失 `mac` 可回退 `T0`、`aitest_init` 可重签锁 | 单次打开不可变 `TrustContext`；支持多机 `macs` 映射与粘性 T1（缺 `mac` 或篡改直接 `blocked`）；`aitest_init` 仅对干净无历史工作区+出厂哈希初签；HTTP 重定向 10 跳逐跳复验 | CLI 本地离线调试仍保留明确 `--allow-unbound-results`（降级 T0）；跨机干净 CI 自动按 SHA-256 校验并在本机保留 `T0` |
| **验证内核归位 (`src/kernel/`)、门面与公共导出** | 脚本直接耦合内部子模块或 `templates/playwright-qa/support/*.mjs` | 权威源码归位 `src/kernel/*` 并经 `src/app/index.mjs` 对外封装，`package.json#exports` 提供 `.`、`./kernel`、`./target-guard`、`./schema-validator` | `templates/playwright-qa/support/` 通过传递闭包确定性镜像供宿主 `<repo>/qa` 独立运行 |
| **`aitest.config.json` Schema、SymbolTable 与 Dieselgate** | `AITEST-G101..G115`（15 条规则） | 新增 `SymbolTable`、`AITEST-G116`（状态字面量等价替换）与 `AITEST-G117`（产品侧 Dieselgate 防护），共 `17` 条可开关规则（`rules` 受 `governance.lock` 保护），并支持 `.aitest/baseline-ref` 分支草稿豁免 | 所有合法 `v5` / `v6.0` `aitest.config.json` 100% 向后兼容 |

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

`v6.0.0` 新增 `upgrade` 命令，结合 `<repo>/qa/.aitest/template-manifest.json` 执行三方哈希安全升级（未改动文件自动升级，人工定制文件写出为 `<file>.aitest-new` 而不静默覆盖，且**绝不自动重签 `governance.lock`**）：

```bash
# 1. 先预览将要更新的文件与冲突
npx ai-test-workbench@6.2.1 upgrade --target /path/to/repo --dry-run

# 2. 执行升级（默认仅升级 support/** 与 scripts/audit-results.mjs；如需全量模板对比可加 --scope all）
npx ai-test-workbench@6.2.1 upgrade --target /path/to/repo

# 3. 检查变更并在确认无误后，由人类在本地终端重签治理锁
npx ai-test-workbench@6.2.1 governance status --target /path/to/repo
npx ai-test-workbench@6.2.1 governance approve --target /path/to/repo --by "alice@team" --reason "升级至 ai-test-workbench v6.0.0 内核"

# 4. 确认 doctor 无内核漂移告警
npx ai-test-workbench@6.2.1 doctor --target /path/to/repo
```

---

## 4. 安全升级 `@playwright/test` 与官方 Test Agents

1. 在 `<repo>/qa/package.json` 中保持**精确版本号**（如 `"1.65.1"`，不带 `^`），与 CI Docker 镜像 `mcr.microsoft.com/playwright:v<version>-noble` 保持一致。
2. 进入 `qa/` 执行 `npm install` 更新锁文件，并安装匹配版本的 Chromium：
   ```bash
   npx playwright install chromium
   ```
3. 预览并同步官方 Test Agents 定义：
   ```bash
   npx ai-test-workbench@6.2.1 update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench@6.2.1 update-agents --target /path/to/repo --loop codex,claude
   ```
4. 若某 Agent 文件曾被人工修改，新版模板会写出为 `<file>.aitest-new` 并返回退出码 `2`；对比合并后删除 `.aitest-new`（或显式传 `--force` 覆盖）。
5. 运行 `npm run typecheck && npm run lint`、离线 `smoke` 与目标环境回归验证，再由人类执行 `governance approve`。
