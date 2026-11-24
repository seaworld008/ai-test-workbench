# CLAUDE.md — Claude Code 工作区指引 / Workspace Guidance (v6.1.0)

> 默认中文说明见 [AGENTS.md](./AGENTS.md)、[docs/governance.md](./docs/governance.md) 与 [README.md](./README.md) · English guide: [AGENTS.en.md](./AGENTS.en.md) · [docs/governance.en.md](./docs/governance.en.md) · [README.en.md](./README.en.md)

当你在本仓库或通过 MCP 使用 `ai-test-workbench` 工作时，请遵循：

1. **优先读取 [AGENTS.md](./AGENTS.md)**（或英文 [AGENTS.en.md](./AGENTS.en.md)）中的 17 个权威 MCP 工具清单、一键终审 `aitest_verify_change` 与四层防假绿治理锁边界。
2. **加载标准技能规范**：[skills/ai-test-workbench/SKILL.md](./skills/ai-test-workbench/SKILL.md)（中文版：[SKILL.zh-CN.md](./skills/ai-test-workbench/SKILL.zh-CN.md)）。
3. **启动原生 MCP 服务**（兼容 `stdio` / `Streamable HTTP` / `SSE`，内置子进程作业隔离、进度通知与进程树取消）：
   - `node tools/aitest.mjs mcp-serve`（`stdio`）
   - `node tools/aitest.mjs mcp-serve --transport http --port 3847`（`/mcp` + `/sse`）
4. **任何代码或文档修改提交前必跑**：`npm run check:vendor && npm run lint:docs && npm run typecheck && npm test && npm run smoke && npm run demo:verify && npm run bench`。
