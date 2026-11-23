# Changelog

> [简体中文 (默认)](./CHANGELOG.md) · [English README](./README.en.md)

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [4.0.0] - 2026-11-23

### Added
- **AI-Agent-First Native Multi-Protocol MCP Server (`src/mcp-server.mjs` & `aitest mcp-serve`)**:
  - Zero-dependency MCP server supporting revisions **`2025-11-25`**, **`2025-06-18`**, **`2025-03-26`**, and **`2024-11-05`** across **`stdio`**, **Streamable HTTP (`/mcp`)**, and **Legacy HTTP+SSE (`/sse` + `/messages`)**.
  - Exposes **12 strongly typed tools** (with JSON Schema `inputSchema`, `outputSchema`, `ToolAnnotations`, and `structuredContent` + `nextRecommendedActions`), static & dynamic **Resources / Templates**, bilingual **Prompts**, `ping`, and `logging/setLevel`.
  - Enforces HTTP `Origin` DNS-rebinding guards (`403`), mandatory Bearer authentication on non-loopback binds (`401`), and `AITEST_MCP_CAPTURED_STDIO=1` subprocess stdout isolation.
- **AI-Agent Discovery & Chinese-Default / Paired-English Docs**:
  - Added `AGENTS.md`/`.en.md`, `CLAUDE.md`, `llms.txt`, `docs/ai-agent-quickstart.md`/`.en.md`, `prompts/first-time-ai-agent.md`/`.en.md`, `skills/ai-test-workbench/references/mcp-server-protocol.md`, and `docs/architecture-and-prompts-blueprint.en.md`.
  - Converted all `.md` files to Chinese by default with paired `.en.md` counterparts verified automatically in CI via `scripts/check-docs-and-hygiene.mjs` (`npm run lint:docs`).
- **7th MCP Pillar (`orchestrator`)**: Registered `ai-test-workbench` itself as a built-in preset across all `mcp-hub` profiles.

### Improved & Fixed
- Added `--json` output to `src/diagnose.mjs` and `src/skill-install.mjs`; added `.gemini/skills/` (`gemini`) and `.github/skills/` (`copilot`) skill destinations; validated SQL table identifiers in `diagnose.mjs`; expanded `src/report.mjs` to index `SYSTEM_MAP.md`, `code-map.json`, `system-overview.md`, and perf summaries.

## [3.0.0] - 2026-11-23

### Added
- **Self-Evolving Living Code Map (`aitest map` / `src/codemap.mjs`)**: Indexes host routes (including broken lazy imports), backend controllers, and Prisma/SQL/ORM tables, incrementally fusing runtime exploration, test results, and perf baselines into `knowledge/SYSTEM_MAP.md`.
- **6-Pillar Read-Only System MCP Hub (`aitest mcp` / `src/mcp-hub.mjs`)**: Generates & audits `.mcp.json` / `.codex/config.toml` across Playwright, Chrome DevTools, Grafana (`--disable-write`), Prometheus, Loki, Sentry, read-only PostgreSQL/MySQL, Redis (`--readonly`), k6, and OpenAPI.
- **CDP Web Vitals & Concurrent GET API SLO Engine (`aitest perf` / `src/perf.mjs`)**.
- **Distributed Trace-ID RCA Correlation (`base.ts` + `src/diagnose.mjs`)**.

## [2.1.0] - 2026-11-23

### Added
- **Zero-to-One Read-Only Explorer (`aitest explore` / `src/explore.mjs`)** generating `reports/system-topology.json` and `specs/system-overview.md`.

## [2.0.0] - 2026-11-23

### Added
- Initial open-source release with isolated `<repo>/qa/`, official Playwright Test Agents manifest management, 3-layer anti-fake-green gate, 4-layer base fixtures, interactive `auth-login`, Diff-Impact (`impact`), and local Smart Campus demo server.
