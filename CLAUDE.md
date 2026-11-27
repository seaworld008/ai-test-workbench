# CLAUDE.md — Claude Code 工作区指引 / Workspace Guidance (v6.7.0)

> 默认中文说明见 [AGENTS.md](./AGENTS.md)、[docs/governance.md](./docs/governance.md) 与 [README.md](./README.md) · English guide: [AGENTS.en.md](./AGENTS.en.md) · [docs/governance.en.md](./docs/governance.en.md) · [README.en.md](./README.en.md)

当你在本仓库或通过 MCP 使用 `ai-test-workbench` 工作时，请遵循：

1. **优先读取 [AGENTS.md](./AGENTS.md)**（或英文 [AGENTS.en.md](./AGENTS.en.md)）中的 17 个权威 MCP 工具清单、多语言 Monorepo 自发现、CodeMap v5.1 / Diff-Impact v3.1 与只读 `aitest://project/{target}/graph-summary` 资源、一键终审 `aitest_verify_change`、双目标差分先知 `aitest_parity` 及四层防假绿治理锁边界（含 `.aitest/mcp.lock` 与 `.aitest/engine-manifest.json`）。
2. **加载标准技能规范**：[skills/ai-test-workbench/SKILL.md](./skills/ai-test-workbench/SKILL.md)（中文版：[SKILL.zh-CN.md](./skills/ai-test-workbench/SKILL.zh-CN.md)）。
3. **启动原生 MCP 服务**（兼容 `stdio` / `Streamable HTTP` / `SSE`，内置子进程作业隔离、进度通知与进程树取消）：
   - `node tools/aitest.mjs mcp-serve`（`stdio`）
   - `node tools/aitest.mjs mcp-serve --transport http --port 3847`（`/mcp` + `/sse`）
4. **任何代码或文档修改提交前必跑**：`npm run check:vendor && npm run lint:docs && npm run typecheck && npm test && npm run smoke && npm run demo:verify && npm run bench && node scripts/bench-agentic.mjs --fast && node conformance/graph-engine/run-conformance.mjs --allow-skip-missing --json`。
