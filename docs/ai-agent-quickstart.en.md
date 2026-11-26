# AI Test Workbench — AI-Agent-First Onboarding & MCP Setup Guide (v6.4.0)

> [简体中文 (默认)](./ai-agent-quickstart.md) · [AGENTS.en.md](../AGENTS.en.md) · [MCP Protocol Reference](../skills/ai-test-workbench/references/mcp-server-protocol.md)

`ai-test-workbench` v6.4.0 ships a **zero-dependency native multi-protocol MCP Server** compatible with every major AI coding agent and all MCP transports & protocol revisions:

- **Transports**: `stdio` (default), **Streamable HTTP** (`/mcp`), and **Legacy HTTP+SSE** (`/sse` + `/messages`).
- **Protocol Versions**: `2025-11-25`, `2025-06-18`, `2025-03-26`, and `2024-11-05`.
- **Agent-Friendly Output**: All **17 canonical MCP tools** (including the dual-target differential parity oracle `aitest_parity` and read-only `aitest_report(view="lessons")`) return both text `content` and schema-validated `structuredContent` (`{ schemaVersion, ok, exitCode, outcome, tool, summary, recoverable, blockerKind, data, nextRecommendedActions }`) alongside `ToolAnnotations`.

---

## 1. Copy-Paste First-Time Prompts

### Scenario 1: First-Time Zero-Block Project Onboarding

```text
Onboard AI Test Workbench onto this repository using MCP tools:
1. Call `aitest_doctor` to verify Node >= 22.12 and Chromium readiness.
2. For local loopback apps call `aitest_bootstrap(target=".")` (or preview with `aitest_init(dryRun=true)` first) to initialize isolated `qa/` and `aitest.runtime.json`.
3. Call `aitest_explore(target=".", maxPages=20)` to capture ARIA specs and API schemas, then call `aitest_verify_change(target=".", mode="impact")` to verify the 4-layer fail-closed anti-fake-green gate.
4. Call `aitest_map_sync` to generate `knowledge/SYSTEM_MAP.md` and report next steps cleanly, keeping Local Workbench verification strictly separate from Business E2E verification.
```

### Scenario 2: Unfamiliar Multi-Tenant SaaS Exploration (0 -> 1 Atlas -> Code Map -> Deep Plan)

```text
Run zero-to-one read-only exploration and create a deep test plan:
1. If SMS OTP / SSO / CAPTCHA is required, prompt me to run:
   `npx ai-test-workbench@6.4.0 auth-login --target . --base-url <STAGING_URL>`
2. Once authenticated, call `aitest_explore(target=".", baseUrl="<STAGING_URL>", maxPages=30)` strictly read-only to map portals/switchers, routes, tables, and API errors.
3. Call `aitest_map_sync` to fuse source code and runtime telemetry into `knowledge/SYSTEM_MAP.md`, then read the `system-overview` and `system-map` resources.
4. Draft prioritized test plans in `qa/specs/` covering 0/1 empty states, pagination, cross-tenant isolation, and pre-existing bugs without normalizing defects.
```

### Scenario 3: Full-Link Observability, Perf & A/B/C/D Root-Cause Diagnosis

```text
Set up full-link System MCPs and investigate recent failures / slow endpoints:
1. Call `aitest_mcp_hub(action="add", target=".", profile="full-link")` followed by `aitest_mcp_hub(action="doctor", target=".")` to confirm read-only & secret hygiene.
2. Run `aitest_perf(target=".", concurrency=4, iterations=12, enforceBudget=true)` to measure Chromium CDP Web Vitals and API P95/RPS.
3. Run `aitest_diagnose(target=".")` and apply strict A/B/C/D triage (never skip/fixme Class-C bugs or delete assertions), correlating captured trace IDs with Grafana/Loki/Prometheus/Sentry/read-only DB MCPs.
```

---

## 2. Multi-Client MCP Configuration Examples

### 1. Claude Code

```bash
claude mcp add ai-test-workbench -- node /path/to/ai-test-workbench/tools/aitest.mjs mcp-serve --workspace-root /path/to/your-repo
```

Or `.mcp.json` (always pin an exact version when using `npx` once published):

```json
{
  "mcpServers": {
    "ai-test-workbench": {
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.4.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

### 2. OpenAI Codex CLI (`.codex/config.toml`)

```toml
[mcp_servers.ai-test-workbench]
command = "npx"
args = ["--package=ai-test-workbench@6.4.0", "ai-test-workbench", "mcp-serve"]
```

### 3. Cursor / Windsurf / VS Code Copilot / Gemini CLI / Antigravity

- **Cursor / Claude Desktop / Antigravity**:

```json
{
  "mcpServers": {
    "ai-test-workbench": {
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.4.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

- **VS Code Copilot** (`.vscode/mcp.json`):

```json
{
  "servers": {
    "ai-test-workbench": {
      "type": "stdio",
      "command": "npx",
      "args": ["--package=ai-test-workbench@6.4.0", "ai-test-workbench", "mcp-serve"]
    }
  }
}
```

### 4. Streamable HTTP (`/mcp`) & Legacy SSE (`/sse`) Mode

```bash
# Local loopback HTTP server (enforces Origin DNS-rebinding protection)
npx ai-test-workbench@6.4.0 mcp-serve --transport http --port 3847 --target /path/to/your-repo

# Non-loopback binding requires Bearer token authentication:
npx ai-test-workbench@6.4.0 mcp-serve --transport http --host 0.0.0.0 --port 3847 --auth-token "$AITEST_MCP_TOKEN"
```

```json
{
  "mcpServers": {
    "ai-test-workbench-http": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:3847/mcp"
    },
    "ai-test-workbench-legacy-sse": {
      "type": "sse",
      "url": "http://127.0.0.1:3847/sse"
    }
  }
}
```
