# 实测探针报告：`@playwright/test@1.65.1` Test Agents 与 CLI 能力核验

> [English Version](./agents-probe-1.65.1.en.md) · **验证日期**：2026-11-23 · **实测环境**：Windows (`pwsh`), Node.js `v26.11.0`, npm `11.20.0`, `@playwright/test@1.65.1` · **探针沙箱**：`.sandbox/agent-probe/`（Git 已忽略）

本文档记录在实现 Agent 同步、配置与防假绿门禁前，对 `@playwright/test@1.65.1` 官方命令真实行为的实测结论。

## 1. `playwright init-agents --help` 行为实测

```text
Usage: npx playwright init-agents [options]
  --loop <loop>        "claude", "codex", "copilot", "opencode", "vscode", "vscode-legacy"
  -c, --config <file>  指定 seed 配置
  --project <project>  指定 seed 项目
```

1. **工作目录解析 (`cwd`)**：`init-agents` 按 `process.cwd()` 输出 `.codex/`、`.claude/`、`.mcp.json` 与 `specs/README.md`，因此 `src/agents.mjs` 必须在隔离暂存目录或目标 `qa/` 内运行。
2. **保留 `seed.spec.ts` vs 覆盖 Agent 文件**：已有 `tests/seed.spec.ts` 不会被覆盖，但重跑会无条件覆盖 `.codex/agents/*.toml`、`.claude/agents/*.md` 与 `.mcp.json`，因此我们引入 `qa/.aitest/agents-manifest.json` SHA-256 指纹保护与 `*.aitest-new` 冲突侧车。
3. **跨引擎不冲突**：`codex` 与 `claude` 的代理定义分属不同目录，连续初始化互不覆盖；并执行路径脱敏确保不残留临时沙箱绝对路径。
4. **内置 Healer 默认加 `test.fixme()` 隐患**：官方 `.codex/agents/playwright_test_healer.toml` 明确写有 *"mark this test as test.fixme() so that it is skipped"*，实证了独立三层防假绿门禁（ESLint + `audit-results.mjs` + `--diff-base`）的必要性。

## 2. `playwright run-test-mcp-server` 与 `playwright test` 实测结论

- `@playwright/test` 已自带 `run-test-mcp-server`（支持 `-c, --config <file>`、`--headless`），无需单独安装 `@playwright/mcp`。
- `playwright test` 实测原生支持 `--only-changed [ref]`、`--last-failed`、`--fail-on-flaky-tests`、`--grep-invert <grep>` 与 `--tsconfig <path>`，由 `runner.mjs` 直接复用。
