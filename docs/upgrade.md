# v5.x 到 v6.0.0 升级与迁移指南 (`upgrade.md`)

> [English Version](./upgrade.en.md) · [版本兼容矩阵](../VERSION.md) · [四层门禁与治理指南](./governance.md) · [更新日志](../CHANGELOG.md)

本文档完整列出 `ai-test-workbench` 从 **`v5.1.1`** 升级到 **`v6.0.0`** 的所有破坏性变更、兼容性窗口（保留至 `v6.x` 结束，将于 `v7.0.0` 移除）、自动化迁移命令，以及日常升级 `@playwright/test` 的维护流程。

---

## 1. v5.x → v6.0.0 破坏性变更一览

| 变更类别 | `v5.1.1` 旧行为 | `v6.0.0` 新行为 | 兼容别名与迁移窗口 |
|---|---|---|---|
| **MCP 工具面收敛（21 → 17）** | 独立注册 `aitest_heal_begin`、`aitest_heal_attempt`、`aitest_heal_conclude` 及 `aitest_job_status`、`aitest_job_result`、`aitest_job_cancel` | 合并为 **`aitest_heal`**（`action: "begin" \| "attempt" \| "conclude"`）与 **`aitest_job`**（`action: "status" \| "result" \| "cancel"`）；`tools/list` 暴露精确 **17 个权威工具** | `tools/call` 在整个 `v6.x` 继续接收上述 6 个旧名并自动转发，同时在 `structuredContent.data._deprecation` 和 `summary` 输出弃用告警（`v7.0.0` 移除） |
| **CLI 按命令严格参数校验** | 89 个全局平铺选项，传给无关子命令的参数会被静默忽略 | 22 个子命令在 `src/cli/commands.mjs` 独立声明允许选项，传入无关参数直接退出码 `1` 并提示拼写建议；支持 `<cmd> --help` | `governance approve` 保留曾误写入文档的 `--approver` → `--by` 弃用告警别名（`v7.0.0` 移除） |
| **CLI `--json` 与退出码统一** | `init` 不支持 `--json`；`run --audit` 遇到 `blocked` 返回 `1` | 所有门禁阻断（`blocked`）统一退出码 **`2`**；`init --json` 输出结构化 JSON 计划与变更清单 | 保留既有顶级数据字段，仅补充统一结果语义 |
| **6 处 Fail-Closed 收紧** | 缺 TS 编译器静默通过 Layer 3；CI 缺 `tsc/eslint` 仅告警；自定义 `--results` 绕过 Run Ledger；未初始化目录放行；畸形 URL 放行；损坏 `aitest.config.json` 回退默认值 | 以上 6 类场景全部改为 `outcome: "blocked"`（退出码 `2`） | CLI 明确提示修复动作；人工本地离线调试可显式传递 CLI 专属 `--allow-unbound-results`（降级为 T0，不暴露给 MCP） |
| **验证内核导入路径** | 内部/高级脚本从 `templates/playwright-qa/support/*.mjs` 导入 | 权威源码归位 `src/kernel/*`，并通过 `package.json#exports` 提供 `ai-test-workbench`、`ai-test-workbench/kernel`、`ai-test-workbench/target-guard`、`ai-test-workbench/schema-validator` | `templates/playwright-qa/support/` 仍保留确定性生成的脚手架副本供宿主 `<repo>/qa` 独立离线运行 |
| **`aitest.config.json` Schema 校验与按规则开关** | 无 Schema 校验且不支持按规则配置 | 启用严格 JSON Schema 校验；新增可选 `rules` 字段按规则码（`AITEST-G101..G115`）配置（修改仍受 `governance.lock` 保护，需人类 `governance approve`） | 所有合法 `v5` `aitest.config.json` 100% 向后兼容 |

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

---

## 3. 使用 `upgrade` 一键安全升级宿主 `<repo>/qa/` 内核

`v6.0.0` 新增 `upgrade` 命令，结合 `<repo>/qa/.aitest/template-manifest.json` 执行三方哈希安全升级（未改动文件自动升级，人工定制文件写出为 `<file>.aitest-new` 而不静默覆盖，且**绝不自动重签 `governance.lock`**）：

```bash
# 1. 先预览将要更新的文件与冲突
npx ai-test-workbench@6.0.0 upgrade --target /path/to/repo --dry-run

# 2. 执行升级（默认仅升级 support/** 与 scripts/audit-results.mjs；如需全量模板对比可加 --scope all）
npx ai-test-workbench@6.0.0 upgrade --target /path/to/repo

# 3. 检查变更并在确认无误后，由人类在本地终端重签治理锁
npx ai-test-workbench@6.0.0 governance status --target /path/to/repo
npx ai-test-workbench@6.0.0 governance approve --target /path/to/repo --by "alice@team" --reason "升级至 ai-test-workbench v6.0.0 内核"

# 4. 确认 doctor 无内核漂移告警
npx ai-test-workbench@6.0.0 doctor --target /path/to/repo
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
   npx ai-test-workbench@6.0.0 update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench@6.0.0 update-agents --target /path/to/repo --loop codex,claude
   ```
4. 若某 Agent 文件曾被人工修改，新版模板会写出为 `<file>.aitest-new` 并返回退出码 `2`；对比合并后删除 `.aitest-new`（或显式传 `--force` 覆盖）。
5. 运行 `npm run typecheck && npm run lint`、离线 `smoke` 与目标环境回归验证，再由人类执行 `governance approve`。
