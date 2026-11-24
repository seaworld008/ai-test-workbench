# Native Multi-Protocol MCP Server v2 Reference (`mcp-serve` v5.0)

> [简体中文 (默认)](./mcp-server-protocol.md) · [SKILL.md](../SKILL.md) · [ADR-0001](../../../docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md)

## 1. Protocols, Transports & Child-Process Job Execution

- **Protocol Versions**: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (zero runtime npm dependencies).
- **Transports**:
  1. `stdio`: NDJSON JSON-RPC with isolated child-process execution (`AITEST_MCP_CHILD=1`) and zero `globalThis.console` mutation.
  2. `Streamable HTTP` (`POST/GET/DELETE /mcp`): `initialize`-only session creation, `404 Not Found` on unknown/expired `Mcp-Session-Id`, idle TTL + `maxSessions` eviction, and batch rejection on `>= 2025-06-18`.
  3. `Legacy HTTP+SSE` (`GET /sse` + `POST /messages`): `2024-11-05` compatible.
- **Progress, Cancellation & Async Backgrounding (`src/jobs.mjs`)**:
  - Emits `notifications/progress` when `_meta.progressToken` is supplied.
  - Terminates spawned process trees via `killProcessTree` on `notifications/cancelled` or `aitest_job_cancel`.
  - Transitions calls exceeding `syncBudgetMs` into async background jobs (`aitest_job_status` / `aitest_job_result`).
- **Security**: `Origin` allowlisting (`403`), `crypto.timingSafeEqual` Bearer auth (`401`), fail-closed `--workspace-root` ceiling intersected with client roots, full path-argument traversal checks, live JSON Schema validation, and strict exclusion of all `governance` CLI commands from MCP.

## 2. Registered MCP Tools (Exact 21 Tools)

`tools/list` exposes **21 strongly-typed tools** from the single declarative registry (`src/mcp/registry.mjs`) with `inputSchema`, `outputSchema`, `ToolAnnotations`, and version-aware `structuredContent`:
`aitest_doctor`, `aitest_init`, `aitest_explore`, `aitest_map_sync`, `aitest_impact`, `aitest_run`, `aitest_audit`, `aitest_diagnose`, `aitest_perf`, `aitest_mcp_hub`, `aitest_report`, `aitest_skill_install`, `aitest_verify_change`, `aitest_heal_begin`, `aitest_heal_attempt`, `aitest_heal_conclude`, `aitest_flaky_report`, `aitest_trace_matrix`, `aitest_job_status`, `aitest_job_result`, and `aitest_job_cancel`.

## 3. Resources & Prompts

- **Static Resources**: `aitest://docs/quickstart`, `aitest://skill/ai-test-workbench`, `aitest://mcp/presets`.
- **Resource Templates**: `aitest://project/{target}/{system-map|code-map|system-overview|diagnostics|perf-summary}`.
- **Bilingual Prompts**: `first-time-onboarding`, `explore-unknown-system`, `generate-and-verify-specs`, `strict-healer-triage`, `full-link-rca-and-perf`.
