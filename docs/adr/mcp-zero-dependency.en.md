# ADR-001: Keep MCP Protocol Layer Zero-Dependency and Enforce Official Conformance Testing

> [中文版](./mcp-zero-dependency.md) · [Architecture Overview](../../ARCHITECTURE.en.md) · [Main README](../../README.en.md)

- **Status**: Accepted
- **Date**: 2026-11-24
- **Scope**: Root `ai-test-workbench` npm package (`package.json`) and `src/mcp/` protocol & transport modules

---

## 1. Context

`ai-test-workbench` ships an AI-agent-first trustworthy verification kernel and multi-protocol MCP server supporting `stdio`, Streamable HTTP (`/mcp`), and Legacy SSE (`/sse` + `/messages`), exposing 21 typed tools, resources, and prompts.

During the v5 architecture review, two paths were evaluated for the MCP protocol layer:

1. **Option A (Zero Runtime Dependencies + Isolated Conformance Harness)**: Keep the root package at zero runtime dependencies (`dependencies` omitted/empty), maintain the modular native protocol implementation in `src/mcp/`, do not publish a separate SDK wrapper package, and add an isolated `conformance/` workspace pinned to the official `@modelcontextprotocol/conformance` suite and `@modelcontextprotocol/sdk` reference client as a mandatory CI gate.
2. **Option B (Adopt Official SDK or Ship a Parallel Wrapper Package)**: Add `@modelcontextprotocol/sdk` as a root runtime dependency or maintain an optional parallel package wrapping the SDK.

---

## 2. Decision

**Adopt Option A**:

1. **Keep the root package zero-dependency**: Root `package.json` declares zero runtime `dependencies`, and no separate SDK-wrapper package is published.
2. **Enforce objective interoperability via official tooling**: Maintain an isolated `conformance/` directory (excluded from `package.json#files` and omitted from the published npm tarball) with pinned `devDependencies`:
   - `@modelcontextprotocol/conformance` (official MCP specification conformance runner)
   - `@modelcontextprotocol/sdk` (used strictly as a test reference `Client` across `stdio`, Streamable HTTP, and Legacy SSE to verify version negotiation, tool discovery, `structuredContent`, progress notifications, and request cancellation)
3. **Track known gaps explicitly**: Any known unsupported scenario from the official conformance suite must be explicitly listed in `conformance/expected-failures.json` with a rationale and issue link. Any unlisted failure fails the CI `mcp-conformance` job immediately.

---

## 3. Rationale

- **Minimal supply-chain footprint**: As a trustworthy verification kernel executed via `npx ai-test-workbench@5.1.0 ...` and CI runners, zero runtime dependencies eliminate transitive dependency drift, shrink install latency, and minimize supply-chain exposure.
- **Bounded protocol surface**: The workbench currently relies on a well-defined, stable core of MCP — `initialize` version negotiation (`2024-11-05` through `2025-11-25`), `ping`, `logging/setLevel`, `tools/list`, `tools/call` (including `structuredContent`), `resources/*`, `prompts/*`, `notifications/progress`, and `notifications/cancelled`. This surface is cleanly separated across `protocol.mjs`, `registry.mjs`, `resources.mjs`, `security.mjs`, `transport-http.mjs`, and `transport-stdio.mjs`.
- **Avoid dual-track drift**: Publishing a parallel SDK wrapper would duplicate security invariants (workspace root intersection, DNS rebinding protection, constant-time Bearer checks, process-tree job cancellation) and double maintenance cost.
- **Falsifiable compliance**: Relying solely on self-authored unit tests risks blind spots. Running both the official `@modelcontextprotocol/conformance` suite and the official `@modelcontextprotocol/sdk` client provides independent specification verification.

---

## 4. Consequences

### Positive
- The published npm package remains lightweight with zero third-party runtime dependencies.
- Security controls and child-process cancellation remain transparent and directly auditable in `src/mcp/`.
- CI `mcp-conformance` validates every pull request against the official conformance suite and SDK client across all three transports.

### Trade-offs & Mitigations
- New MCP specification features are not inherited automatically from SDK upgrades and must be implemented deliberately.
- **Mitigation**: Periodically bump the pinned versions in `conformance/package.json` so protocol regressions surface immediately in CI.

---

## 5. Re-evaluation Triggers

This ADR **must** be reopened and re-evaluated (considering adopting `@modelcontextprotocol/sdk` or introducing a dedicated adapter package) if any of the following occur:

1. **Persistent unfixable conformance gaps**: Core mandatory scenarios in `@modelcontextprotocol/conformance` fail for more than two release cycles without a clean fix, or the list of core failures in `conformance/expected-failures.json` grows over time.
2. **Requirement for heavy new protocol capabilities**: Product requirements explicitly call for any of the following complex MCP features, which should not be re-implemented from scratch:
   - **MCP OAuth 2.1 / Protected Resource Metadata authorization flows** (dynamic client registration, PKCE, token refresh, multi-tenant auth)
   - **Elicitation** (interactive server-to-client structured user prompts)
   - **MCP Tasks** (spec-native long-running task protocol replacing or bridging custom `aitest_job_*` tools)
   - **Sampling / bidirectional server-initiated requests and full SSE resumability (`Last-Event-ID` event-store replay)**
3. **Client compatibility maintenance burden**: Transport changes across major MCP hosts (Codex, Claude Code, VS Code, Cursor) cause protocol maintenance effort to outweigh work on the verification kernel itself.
