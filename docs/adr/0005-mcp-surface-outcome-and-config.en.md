# ADR-0005: MCP Tool Surface Consolidation (21 -> 17), Unified Outcome Model & Centralized Config Layer

> [简体中文 (默认)](./0005-mcp-surface-outcome-and-config.md) · [English README](../../README.en.md) · [Upgrade Guide](../upgrade.en.md)

- **Status**: Accepted (Implemented in `v6.0.0`)
- **Date**: `2026-11-24`

---

## 1. Context & Problem Statement

In `v5.1.1`, the protocol and interface layer suffered from four structural issues:

1. Four circular import edges connected `mcp-hub.mjs`, `mcp-server.mjs`, `mcp/protocol.mjs`, and `mcp/resources.mjs`, while `protocol.mjs` hardcoded `aitest_job_*` and `aitest_mcp_hub` dispatch;
2. `tools/list` exposed 21 tools including 6 fine-grained state-machine verbs (`heal_begin/attempt/conclude` and `job_status/result/cancel`);
3. `cli.mjs` parsed a single global 89-flag bag that silently ignored unrelated flags passed to a subcommand;
4. `process.env` and `aitest.config.json` reads were scattered across modules alongside 6 fail-open edge cases and inconsistent exit codes.

---

## 2. Decision

1. **Zero Cycles & 17 Canonical MCP Tools**:
   - Extracted pure data module `src/mcp-hub/catalog.mjs` and routed `mcp serve` in `src/cli/commands.mjs`, reducing `src/**` import cycles to `0` (enforced in unit tests).
   - Decomposed `src/mcp/registry.mjs` into `src/mcp/tools/{shared,discovery,verification,stateful}.mjs` with declarative `execute(args, ctx)` and `validateExtra(args)` hooks, removing hardcoded tool branches from `protocol.mjs`.
   - Consolidated `aitest_heal(action: "begin"|"attempt"|"conclude")` and `aitest_job(action: "status"|"result"|"cancel")` so `tools/list` exposes **17 canonical tools**, while `tools/call` forwards all 6 deprecated v5 names across `v6.x` with `data._deprecation` metadata and summary warnings.
2. **Per-Command Strict CLI Option Registry (`src/cli/commands.mjs`)**:
   - All 22 subcommands declare exact option tables; unrelated flags exit `1` with closest-flag suggestions; `governance` retains `--approver -> --by` as a deprecated `v6.x` alias.
3. **Unified `Outcome` / Exit Codes & Centralized Config**:
   - Created `src/core/outcome.mjs` unifying `pass | fail | blocked` -> `0 | 1 | 2` (fixing `runner --audit` returning `1` on `blocked` and adding `init --json`).
   - Created `src/core/config.mjs` to load and JSON-Schema-validate `TEST_*`, `AITEST_*`, `.env`, and `aitest.config.json`, closing all 6 fail-open branches.

---

## 3. Compatibility & Migration

All breaking changes and `v6.x` compatibility aliases are documented in [docs/upgrade.en.md](../upgrade.en.md); deprecated aliases are scheduled for removal in `v7.0.0`.
