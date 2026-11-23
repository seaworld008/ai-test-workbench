# CLAUDE.md — Claude Code 工作区指引 / Workspace Guidance

> 默认中文说明见 [AGENTS.md](./AGENTS.md) 与 [README.md](./README.md) · English guide: [AGENTS.en.md](./AGENTS.en.md) · [README.en.md](./README.en.md)

当你在本仓库或通过 MCP 使用 `ai-test-workbench` 工作时，请遵循：

1. **优先读取 [AGENTS.md](./AGENTS.md)**（或英文 [AGENTS.en.md](./AGENTS.en.md)）中的 MCP 工具链顺序与安全边界。
2. **加载标准技能规范**：[skills/ai-test-workbench/SKILL.md](./skills/ai-test-workbench/SKILL.md)（中文版：[SKILL.zh-CN.md](./skills/ai-test-workbench/SKILL.zh-CN.md)）。
3. **启动原生 MCP 服务**（兼容 `stdio` / `Streamable HTTP` / `SSE`）：
   - `node tools/aitest.mjs mcp-serve`（`stdio`）
   - `node tools/aitest.mjs mcp-serve --transport http --port 3847`（`/mcp` + `/sse`）
4. **任何代码或文档修改提交前必跑**：`npm run lint:docs && npm test && npm run smoke`。
