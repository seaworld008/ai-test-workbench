# Native Multi-Protocol MCP Server Reference (`mcp-serve` v4.0)

> [简体中文 (默认)](./mcp-server-protocol.md) · [SKILL.md](../SKILL.md)

- **Protocol Versions**: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05`.
- **Transports**: `stdio` (default NDJSON with `AITEST_MCP_CAPTURED_STDIO=1` FD-1 isolation), **Streamable HTTP** (`POST/GET/DELETE /mcp`, session headers, batch JSON-RPC, JSON or SSE response), and **Legacy HTTP+SSE** (`GET /sse` + `POST /messages`).
- **HTTP Guardrails**: `Origin` allowlisting (`403` DNS-rebinding defense) and mandatory Bearer `--auth-token` / `AITEST_MCP_TOKEN` (`401`) for non-loopback binds.
- **12 Tools** returning validated `structuredContent` + `nextRecommendedActions` + `ToolAnnotations`, plus static/template `Resources` (`aitest://project/{target}/*`) and bilingual `Prompts`.
