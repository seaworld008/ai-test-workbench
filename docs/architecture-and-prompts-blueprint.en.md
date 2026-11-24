# AI Test Workbench (v4.0) — AI-Agent-First Full-Link Testing Workbench: Architecture & Implementation Prompts

> [简体中文完整架构蓝图 (默认)](../Playwright%20Test%20Agents%20+%20Codex%20%E5%8F%AF%E5%A4%8D%E7%94%A8%E6%9C%AC%E6%9C%BA%20AI%20%E8%87%AA%E5%8A%A8%E5%8C%96%E6%B5%8B%E8%AF%95%E5%B7%A5%E4%BD%9C%E5%8F%B0%E2%80%94%E2%80%94%E6%9E%B6%E6%9E%84%E8%AE%BE%E8%AE%A1%E4%B8%8E%E5%AE%9E%E6%96%BD%E6%8F%90%E7%A4%BA%E8%AF%8D.md) · [English README](../README.en.md) · [AI Agent Quickstart](./ai-agent-quickstart.en.md) · [AGENTS.en.md](../AGENTS.en.md)
> **Version**: v4.0 (AI-Agent-First · Multi-Protocol MCP Server · Living Code Map · 7-Pillar MCP Hub · Perf SLOs · 3-Layer Anti-Fake-Green Gates)  
> **Date**: 2026-11-23  
> **Goal**: Build an **AI-Agent-First**, Git-tracked, open-source package (`ai-test-workbench`), native **MCP Server**, and portable **Agent Skill (`SKILL.md`)** connecting **Native Multi-Protocol MCP Orchestration -> 0→1 Multi-Portal Exploration -> Living Code Map -> 7-Pillar Read-Only System MCPs -> Performance SLOs -> 3-Layer Anti-Fake-Green Deterministic Regression**.

---

## 1. Architecture Evolution (v1.0 → v4.0) & Independent Audit Fixes

| Release | Core Capability | Problems Solved |
|---|---|---|
| **v1.0 → v2.0** | `<repo>/qa/` isolation, SHA-256 `init-agents` manifest protection, Diff-Impact selection, 3-layer gate, 4-layer base fixtures, local demo server | Stopped CI LLM dependence, prevented Playwright default Healer `test.fixme()` drift, eliminated Windows `.cmd` `spawn EINVAL`, and blocked production targets |
| **v2.1** | `npx ai-test-workbench@5.1.1 auth-login` + `npx ai-test-workbench@5.1.1 explore` zero-to-one crawler | Handled SMS/SSO manual session capture and read-only multi-portal SaaS discovery before authoring tests |
| **v3.0** | Self-evolving Living Code Map (`npx ai-test-workbench@5.1.1 map`), 6-pillar read-only MCP Hub (`npx ai-test-workbench@5.1.1 mcp`), CDP/API Perf engine (`npx ai-test-workbench@5.1.1 perf`), distributed Trace-ID RCA | Connected frontend routes, backend controllers, DB tables, logs, metrics, and runtime tests across full systems |
| **v4.0** | **Native zero-dependency multi-protocol MCP Server (`mcp-serve`) + 7th `orchestrator` pillar + AI discovery (`AGENTS.md`/`llms.txt`/first-time prompts) + Chinese-default / paired English docs & automated hygiene CI gate** | **Eliminated shell-parsing fragility for AI agents via typed MCP `structuredContent` across `stdio`, Streamable HTTP (`/mcp`), and Legacy SSE (`/sse`), while ensuring full bilingual parity and zero secret/path leakage** |

### Key Issues Found & Fixed During v4.0 Independent Review
1. **Isolated `stdio` MCP Child Output (`src/proc.mjs` + `src/mcp-server.mjs`)**: Child `playwright test` / `npm` invocations inside `stdio` MCP mode never use `stdio: 'inherit'` when `AITEST_MCP_CAPTURED_STDIO=1` and run behind a console-capture mutex so OS FD 1 emits strictly valid NDJSON JSON-RPC frames.
2. **Streamable HTTP Security Boundaries**: Enforces `Origin` header allowlisting (`403 Forbidden` against DNS rebinding) and rejects non-loopback binds (`0.0.0.0`) without `--auth-token` / `AITEST_MCP_TOKEN` (`401 Unauthorized`).
3. **Structured JSON & Artifact Parity**: Added `--json` output to `diagnose.mjs` and `skill-install.mjs`, added `gemini` and `copilot` skill clients, sanitized table identifiers in `diagnose.mjs` SQL hints, and expanded `report.mjs` to index `SYSTEM_MAP.md`, `code-map.json`, `system-overview.md`, `perf-summary.md`, and `perf-report.json`.
4. **Automated Bilingual & Desensitization Hygiene (`scripts/check-docs-and-hygiene.mjs`)**: Verifies `.md` Chinese defaults, paired `.en.md` existence, valid relative doc links, and zero internal staging domains or local machine paths across tracked files.

---

## 2. Multi-Protocol MCP Architecture

- **Protocol Versions Supported**: `2025-11-25` (latest negotiated fallback), `2025-06-18`, `2025-03-26`, `2024-11-05`.
- **Transports**:
  - `stdio`: `node tools/aitest.mjs mcp-serve` (or pinned `npx --package=ai-test-workbench@5.1.1 ai-test-workbench mcp-serve`)
  - **Streamable HTTP** (`/mcp`): `POST` (single + JSON-RPC batch, `application/json` or `text/event-stream` per `Accept`, `Mcp-Session-Id` & `MCP-Protocol-Version` headers), `GET` (SSE stream), `DELETE` (close session)
  - **Legacy HTTP+SSE** (`GET /sse` + `POST /messages?sessionId=...`) + `GET /health`
- **Capabilities**:
  - **12 Typed Tools** (`aitest_doctor`, `aitest_init`, `aitest_explore`, `aitest_map_sync`, `aitest_impact`, `aitest_run`, `aitest_audit`, `aitest_diagnose`, `aitest_perf`, `aitest_mcp_hub`, `aitest_report`, `aitest_skill_install`) with `inputSchema`, `outputSchema`, `ToolAnnotations`, `content`, and `structuredContent` (`{ ok, exitCode, tool, summary, data, nextRecommendedActions }`).
  - **Resources & Templates**: Static (`aitest://docs/quickstart`, `aitest://skill/ai-test-workbench`, `aitest://mcp/presets`) + template URIs (`aitest://project/{target}/{system-map|code-map|system-overview|diagnostics|perf-summary}`) + `aitest://current/*` when `--target` is bound.
  - **Prompts (`prompts/get`)**: `first-time-onboarding`, `explore-unknown-system`, `generate-and-verify-specs`, `strict-healer-triage`, `full-link-rca-and-perf` (Chinese default, English via `lang: "en"`).

---

## 3. Ready-to-Use AI Agent Workflows & Prompts

See paired prompts under [`prompts/*.en.md`](../prompts/first-time-ai-agent.en.md) and multi-client MCP configurations (Claude Code, Codex CLI, Cursor, Windsurf, VS Code Copilot, Gemini CLI, Streamable HTTP, Legacy SSE) in [docs/ai-agent-quickstart.en.md](./ai-agent-quickstart.en.md).

---

## 4. Dual Verification Scope & Pre-Release Gates

Always distinguish **Local Workbench Verified** (CLI, MCP Server, multi-project isolation, offline smoke, 3-layer gate, local demo server) from **Business E2E Verified** (real non-production staging target + reviewed business assertions). Every release must pass `npm run lint:docs`, `npm test`, `npm run smoke`, `npm run demo:verify`, `npm pack --dry-run`, and Ubuntu + Windows GitHub Actions matrices.
