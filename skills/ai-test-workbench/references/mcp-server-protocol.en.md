# Native Multi-Protocol MCP Server Reference (`mcp-serve` v6.0.0)

> [简体中文 (默认)](./mcp-server-protocol.md) · [SKILL.md](../SKILL.md) · [ADR-0001](../../../docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [ADR-0005](../../../docs/adr/0005-mcp-surface-outcome-and-config.en.md)

## 1. Protocols, Transports & Child-Process Job Execution

- **Protocol Versions**: `2025-11-25`, `2025-06-18`, `2025-03-26`, `2024-11-05` (zero runtime npm dependencies).
- **Transports**:
  1. `stdio`: `node tools/aitest.mjs mcp-serve` (or pinned `npx --package=ai-test-workbench@6.0.0 ai-test-workbench mcp-serve`; NDJSON JSON-RPC with isolated child-process execution `AITEST_MCP_CHILD=1` and zero `globalThis.console` mutation).
  2. `Streamable HTTP` (`POST/GET/DELETE /mcp`): `initialize`-only session creation, `404 Not Found` on unknown/expired `Mcp-Session-Id`, idle TTL + `maxSessions` eviction, and batch rejection on `>= 2025-06-18`.
  3. `Legacy HTTP+SSE` (`GET /sse` + `POST /messages`): `2024-11-05` compatible.
- **Progress, Cancellation & Async Backgrounding (`src/jobs.mjs`)**:
  - Emits `notifications/progress` when `_meta.progressToken` is supplied.
  - Terminates spawned process trees via `killProcessTree` on `notifications/cancelled` or `aitest_job(action="cancel", jobId=...)`.
  - Transitions calls exceeding `syncBudgetMs` into async background jobs queried via `aitest_job(action="status"|"result", jobId=...)`.
- **Security**: `Origin` allowlisting (`403`), `crypto.timingSafeEqual` Bearer auth (`401`), fail-closed `--workspace-root` ceiling intersected with client roots, full path-argument traversal checks, live JSON Schema validation, and strict exclusion of all `governance` CLI commands from MCP.

## 2. Registered Canonical MCP Tools (17 Tools, Auto-Generated)

<!-- BEGIN:GENERATED_MCP_TOOLS lang="en" -->
| Tool Name | Category | Read-Only Hint | Responsibility |
|---|---|---|---|
| `aitest_doctor` | Discovery & Setup | Yes | Environment, Browser & Gate Kernel Readiness Check |
| `aitest_init` | Discovery & Setup | No | Initialize Isolated QA Workspace & Governance Lock |
| `aitest_explore` | Discovery & Setup | No | Zero-to-One Default-Deny Read-Only Explorer |
| `aitest_map_sync` | Discovery & Setup | No | Sync Convergent Living Code Map v4 |
| `aitest_mcp_hub` | Discovery & Setup | No | Manage Pinned 7-Pillar MCP Presets & Supply-Chain Doctor |
| `aitest_skill_install` | Discovery & Setup | No | Install Portable Agent Skill into Project |
| `aitest_verify_change` | Verification & Gates | No | One-Call Agent Change Verification & Attested Verdict |
| `aitest_impact` | Verification & Gates | Yes | Compute Dependency-Graph Diff-Impact Scope (v2) |
| `aitest_run` | Verification & Gates | No | Execute Ledger-Bound Deterministic Playwright Suite |
| `aitest_audit` | Verification & Gates | Yes | Run 4-Layer Fail-Closed Anti-Fake-Green Quality Gate |
| `aitest_diagnose` | Verification & Gates | No | Generate Redacted Evidence-First A/B/C/D Diagnostics Report |
| `aitest_perf` | Verification & Gates | No | Run PerformanceObserver Web Vitals & Read-Only API SLO Benchmark |
| `aitest_trace_matrix` | Verification & Gates | Yes | Query Requirement <-> Spec Traceability Matrix (REQ-xxx) |
| `aitest_flaky_report` | Verification & Gates | Yes | Query Historical Flaky Telemetry & Quarantine List |
| `aitest_report` | Verification & Gates | Yes | Index Local Reports, Attestations, SARIF & Trace Artifacts |
| `aitest_heal` | Stateful Control | No | Stateful A/B/C/D Heal Governance State Machine (begin \| attempt \| conclude) |
| `aitest_job` | Stateful Control | No | Inspect, Await, or Cancel Async Background MCP Jobs (status \| result \| cancel) |

> Auto-generated from `src/mcp/registry.mjs` (`17` canonical tools; `governance approve` is human-CLI-only and never registered; 6 v5 names `aitest_heal_*` / `aitest_job_*` remain as deprecated forwarding aliases in v6.x).
<!-- END:GENERATED_MCP_TOOLS -->

## 3. Resources & Prompts

- **Static Resources**: `aitest://docs/quickstart`, `aitest://skill/ai-test-workbench`, `aitest://mcp/presets`.
- **Resource Templates**: `aitest://project/{target}/{system-map|code-map|system-overview|diagnostics|perf-summary}`.
- **Bilingual Prompts**: `first-time-onboarding`, `explore-unknown-system`, `generate-and-verify-specs`, `strict-healer-triage`, `full-link-rca-and-perf`.
