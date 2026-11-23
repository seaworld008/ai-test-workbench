# ADR-0001: MCP Protocol Stack Evolution & Zero-Dependency Kernel Decision

> [简体中文 (默认)](./0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [English README](../../README.en.md) · [Architecture](../../ARCHITECTURE.en.md) · [Optimization Roadmap](../review/optimization-roadmap-2026-2027.en.md)

- **Status**: Accepted (Implemented in `v5.0.0`)
- **Date**: `2026-11-23`
- **Related Review IDs**: `F-08`, `F-09`, `M-01..M-09`, `A-01`, `R0-3`, `R1-5`

---

## 1. Context & Problem Statement

During the `v4.0` architecture and code review ([architecture-code-review-2026-11.en.md](../review/architecture-code-review-2026-11.en.md)), we identified structural bottlenecks in our original single-file MCP server (`src/mcp-server.mjs`):

1. **In-Process Global Mutex & Console Hijacking (`F-08`)**: Every tool call shared one global mutex and mutated `globalThis.console.*`, causing fast read-only tools (`doctor`, `report`, `impact`) to block behind long Playwright runs.
2. **Missing Progress Heartbeats, Cancellation & Async Jobs (`F-09`, `M-02`, `M-03`)**: `aitest_run`, `aitest_explore`, and `aitest_perf` calls exceeding 60s risked client timeouts, and `notifications/cancelled` could not kill spawned Chromium process trees.
3. **Streamable HTTP Session & Auth Edge Cases (`M-04`, `M-05`, `S-06`)**: Non-`initialize` requests implicitly allocated sessions, unknown `Mcp-Session-Id` headers did not return `404`, sessions lacked idle TTL / `maxSessions` eviction, and Bearer tokens were not compared with `crypto.timingSafeEqual`.

For `v5.0`, we evaluated whether to **adopt `@modelcontextprotocol/sdk` + `zod` as runtime dependencies** or **preserve a zero-dependency root package while refactoring into a modular multi-protocol kernel + isolated child-process Job Runner (`src/jobs.mjs`)**.

---

## 2. Options Compared

| Dimension | Option A: Adopt `@modelcontextprotocol/sdk` + `zod` | Option B (Accepted): Zero-Dependency Multi-Protocol Kernel v2 + Child-Process Job Runner (`src/jobs.mjs`) |
|---|---|---|
| **`npx -y ai-test-workbench` Cold Start** | Downloads dozens of transitive packages; slower cold start and fragile in air-gapped CI | **Instant startup**; `0` runtime `dependencies` in root `package.json` |
| **Supply-Chain Surface** | Larger transitive dependency graph | **Zero runtime third-party packages** (Playwright & ESLint stay isolated and exact-pinned inside `<repo>/qa`) |
| **Protocol Compatibility (`2024-11-05` .. `2025-11-25`)** | Varies across SDK major versions for Legacy SSE vs Streamable HTTP | Exact support for `stdio`, `Streamable HTTP (/mcp)`, and `Legacy SSE (/sse)`, including protocol-version-aware batch rejection on `>= 2025-06-18` |
| **Subprocess Isolation & Process-Tree Kill** | Still requires custom Playwright child-process & `taskkill /T` management | `src/jobs.mjs` runs heavy tools in isolated child processes (`AITEST_MCP_CHILD=1`), eliminating console hijacking and enabling clean process-tree termination |
| **Verification** | Tracks upstream SDK churn | Verified by dedicated contract tests in `test/mcp-server.test.mjs` and `test/mcp-jobs.test.mjs` |

---

## 3. Decision

We adopt **Option B: Zero-Dependency Multi-Protocol Kernel v2 (`src/mcp-server.mjs` + `src/jobs.mjs`)**:

1. **Isolated Child-Process Job Runner (`src/jobs.mjs`)**:
   - Long-running tools execute in isolated child processes without mutating `globalThis.console.*`.
   - `syncBudgetMs` returns inline when a tool finishes quickly and seamlessly transitions to an async background job (`jobId` + `aitest_job_status` / `aitest_job_result` / `aitest_job_cancel`) when work exceeds budget.
2. **Progress Notifications & Process-Tree Cancellation**:
   - Emits `notifications/progress` whenever `_meta.progressToken` is supplied.
   - Handles `notifications/cancelled` by terminating the entire child process tree via `killProcessTree(pid)`.
3. **Read Concurrency & Per-Workspace Write Locks**:
   - Read-only tools execute concurrently with zero global lock; mutating tools acquire a normalized per-workspace lock (`withWorkspaceWriteLock`) within `--allowed-root` boundaries.
4. **Hardened Streamable HTTP & Privilege Separation**:
   - Only `initialize` creates sessions; unknown/expired `Mcp-Session-Id` returns `404 Not Found`; sessions enforce idle TTL and `maxSessions` eviction; Bearer auth uses `crypto.timingSafeEqual`.
   - Human-only `aitest governance approve` is **never** exposed over MCP and hard-fails if `AITEST_MCP_CHILD=1`.

---

## 4. Re-evaluation Trigger

If future MCP specifications mandate complex binary multiplexing or dynamic OAuth 2.1 broker flows exceeding `1,500` LOC in the transport layer, we will open ADR-0002 to evaluate an optional adapter package.
