# ADR-0001: Zero-Dependency MCP Protocol Stack & Official Conformance Gate

> [简体中文 (默认)](./0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [English README](../../README.en.md) · [Architecture](../../ARCHITECTURE.en.md) · [v6.0 Refactor Assessment](../review/v6-refactor-assessment.en.md)

- **Status**: Accepted (`v5.0.0` initial implementation; `v6.0.0` consolidated with `mcp-zero-dependency` and 16 canonical tools)
- **Date**: `2026-11-24`

---

## 1. Context & Problem Statement

`ai-test-workbench` ships both a CLI and a native MCP server for local AI coding agents and CI pipelines. The core architectural decision is whether to add runtime dependencies (`@modelcontextprotocol/sdk` + `zod`) to the root package or keep root `dependencies` empty while maintaining a modular protocol stack under `src/mcp/` verified by an isolated upstream conformance suite.

---

## 2. Alternatives Considered

| Criterion | Option A: Runtime `@modelcontextprotocol/sdk` + `zod` in root | Option B (Adopted): Zero-Runtime-Dep `src/mcp/` + Isolated `conformance/` Gate |
|---|---|---|
| **`npx` cold start & air-gapped CI** | Downloads dozens of transitive packages; fragile offline | Root `dependencies` empty; millisecond startup with zero runtime installs |
| **Supply-chain surface** | Exposes users to transitive CVE churn | Zero third-party runtime packages; exact-pinned dev tools only |
| **Multi-version negotiation** | SDK major updates shift Legacy SSE / batching defaults | Deterministic negotiation across `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` |
| **Subprocess isolation & cancellation** | Requires a custom job runner regardless of SDK | `src/jobs.mjs` isolates child CLI processes, streams progress, and kills OS process trees |
| **Interoperability assurance** | Coupled to SDK implementation | Isolated `conformance/` pins `@modelcontextprotocol/conformance@0.1.16` and `@modelcontextprotocol/sdk@1.32.2` across all 3 transports in CI |

---

## 3. Decision

Adopt **Option B**:

1. **Zero Runtime Dependencies**: Root `package.json` omits `dependencies`. `src/mcp/` is decomposed into cohesive `<= 500`-line modules (`protocol.mjs`, `registry.mjs`, `tools/{shared,discovery,verification,stateful}.mjs`, `resources.mjs`, `security.mjs`, `transport-stdio.mjs`, `transport-http.mjs`) with zero circular imports.
2. **Isolated Conformance & Reference SDK Verification**: The standalone `conformance/` directory runs upstream `@modelcontextprotocol/conformance` scenarios and `@modelcontextprotocol/sdk` client tests over `StdioClientTransport`, `StreamableHTTPClientTransport`, and `SSEClientTransport` in CI.
3. **Privilege Isolation**: Human-only `npx ai-test-workbench@6.4.0 governance approve` is never registered in `src/mcp/registry.mjs` and is hard-blocked whenever `AITEST_MCP_CHILD=1`.

---

## 4. Re-Evaluation Triggers

Revisit adopting the official SDK if either condition triggers:

1. Required support for OAuth 2.1 dynamic client registration, MCP Elicitation, Sampling, or MCP Tasks pushes core transport/protocol code beyond `1,500` lines;
2. Upstream `@modelcontextprotocol/conformance` exposes a protocol interoperability gap that cannot be cleanly fixed in `src/mcp/`.
