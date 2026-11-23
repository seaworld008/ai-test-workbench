# 升级与 Agent 同步维护指南 (`upgrade.md`)

> [English Version](./upgrade.en.md) · [版本兼容矩阵](../VERSION.md)

## 安全升级 `@playwright/test` 与工作台版本

1. 检查当前锁定的 `qa/package.json` 与 `qa/package-lock.json`，并查阅 Playwright 官方发版说明。
2. 在 `qa/package.json` 中保持**精确版本号**（如 `"1.65.1"`，不带 `^`），保证与 CI 容器镜像 `mcr.microsoft.com/playwright:v<version>-noble` 完全一致。
3. 进入 `qa/` 执行 `npm install` 更新锁文件并同步安装匹配版本的 Chromium：
   ```bash
   npx playwright install chromium
   ```
4. 预览并同步官方 Test Agents 定义：
   ```bash
   npx ai-test-workbench update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench update-agents --target /path/to/repo --loop codex,claude
   ```
5. **冲突文件处理 (`*.aitest-new`)**：
   - `ai-test-workbench` 通过 `qa/.aitest/agents-manifest.json` 跟踪官方 Agent 文件的 SHA-256 哈希。
   - 若用户曾定制修改过某 Agent 文件，原件会被完整保留，新版模板则写出为 `<file>.aitest-new` 并返回 `CONFLICT`（退出码 `2`）。对比合并后删掉 `.aitest-new`（或显式传 `--force` 覆盖）。
6. 最后执行 `npm run typecheck && npm run lint`、离线 `smoke` 与在线 `e2e`/`api` 全量回归验证。
