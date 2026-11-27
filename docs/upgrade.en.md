# v5.x / v6.6 to v6.7.0 Upgrade & Migration Guide (`upgrade.en.md`)

> [简体中文 (默认)](./upgrade.md) · [Version Compatibility Matrix](../VERSION.en.md) · [Governance Guide](./governance.en.md) · [ADR-0007 Graph Sidecar](./adr/0007-external-code-graph-engine.en.md) · [Changelog](../CHANGELOG.en.md)

This guide documents all breaking changes from **`v5.1.1` / `v6.1.0` / `v6.6.0`** to **`v6.7.0`**, backward-compatibility aliases retained throughout `v6.x` (removed in `v7.0.0`), the `v6.5 → v6.7` polyglot monorepo / CodeMap v5.1 / sidecar graph engine migration, and `@playwright/test` maintenance steps.

---

## 1. Core Changes Summary (`v5.x / v6.1 -> v6.7.0`)

| Area | `v5.1.1` / `v6.1.0` Behavior | `v6.7.0` Behavior | Compatibility & Removal Window |
|---|---|---|---|
| **MCP Tool Surface (21 -> 17)** | Separate `aitest_heal_*`, `aitest_job_*`, `aitest_flaky_report`, `aitest_trace_matrix` | Consolidated into **`aitest_heal`** (with `discard`), **`aitest_job`**, and **`aitest_report`** (`view: "summary" \| "flaky" \| "traceability" \| "lessons"`), plus **`aitest_bootstrap`** and **`aitest_parity`**; preserves **17 canonical tools** and adds read-only resource `aitest://project/{target}/graph-summary` | `tools/call` forwards all **8 legacy names** throughout `v6.x` with `structuredContent.data._deprecation` and summary warnings (removed in `v7.0.0`) |
| **Per-Command Strict CLI Flags** | Single 89-flag global bag silently ignored unrelated options | Every subcommand (including `map --engine/--query`, `mcp install-engine`/`engine-status` with targetless global support, and `upgrade --scope engines`) declares exact flags in `src/cli/`; `--json` usage errors exit **`64`**, and `mcp`/`map`/`impact` emit structured `USAGE_ERROR`/`WORKSPACE_NOT_INITIALIZED` recovery actions | `governance approve` retains `--approver` -> `--by`; `flaky` / `trace-matrix` remain forwarded to `report --view` (`v7.0.0` removal) |
| **Unified `CommandResult v2`, Framed IPC & Exit Codes** | Tail-text stdout scraping for MCP child JSON; mixed usage exit codes | Uniform `CommandResult v2` envelopes (`0=pass / 1=fail / 2=blocked / 64=usage`) over `AITEST_RESULT_FILE` framed IPC | Existing top-level JSON data keys preserved alongside `schemaVersion`, `blockerKind`, `recoverySteps` |
| **Immutable `TrustContext`, Sticky T1 & Redirect Firewall** | Cross-machine lock fallback could relax missing `mac`; `aitest_init` re-signed missing locks | Frozen `TrustContext` opened once; multi-machine `macs` map + sticky T1 anti-strip; governance lock seals **`.aitest/mcp.lock`** and **`.aitest/engine-manifest.json`** inside `.aitest/governance.lock`; 10-hop redirect re-validation | CLI offline `--allow-unbound-results` (T0) remains CLI-only; clean CI verifies protected-file SHA-256 and downgrades unsigned T1 to T0 |
| **CodeMap v5.1, Diff-Impact v3.1 & 8-Pillar MCP Hub** | Regex-only static map (`codeMap: 4`), file-level reverse impact, 7-pillar MCP | Polyglot monorepo auto-discovery + L0 full-stack extractors (Vue 3 single-object router/TS generic HTTP/cross-file prefix helpers/`.cjs` + Python `FastAPI`/`Flask`/`aiohttp`/`Starlette`/`Django` + SQLAlchemy/Django/DDL/TypeORM) + L1 (`codebase-memory-mcp@0.12.1` optional sidecar with `AITEST_DATA_DIR` migration & ephemeral tmpdir leak prevention) + L2 **CodeMap v5.1 (`schemaVersion: 5`)**, **Diff-Impact v3.1** (shared-`.git` monorepo diff remapping + Python `.py` reverse-import graph + Global Infra Guard + `<20ms` `pipe-sharded-v1`), and **8-Pillar MCP Hub** (adding `code-intelligence`) | Automatic `v4 -> v5` migration preserving runtime routes & defects; degrades cleanly to zero-dep `builtin` mode when sidecar is absent |
| **`aitest.config.json` Schema, SymbolTable, Dieselgate & Lockstep** | `AITEST-G101..G115` (15 rules) | **`18` pluggable gate rules** (`AITEST-G101..G118`); adds optional `codeMap.engine` and `codeMap.externalEngine` schema validation; governance lock seals `known-blockers.json`, `corpus/**`, `fixtures/upstream-cassettes/**`, `support/project-rules.json`, `.aitest/mcp.lock`, and `.aitest/engine-manifest.json` | All valid `v5` / `v6.x` `aitest.config.json` files remain 100% compatible |

---

## 2. MCP Client Migration Mapping

Update prompts, scripts, or agent rules referencing legacy v5 tool names as follows:

| Deprecated v5 Name (forwarded with warning in v6.x) | Canonical v6 Call |
|---|---|
| `aitest_heal_begin({ target, testId })` | `aitest_heal({ action: "begin", target, testId })` |
| `aitest_heal_attempt({ target, sessionId, skipRun })` | `aitest_heal({ action: "attempt", target, sessionId, skipRun })` |
| `aitest_heal_conclude({ target, sessionId, outcome, summary })` | `aitest_heal({ action: "conclude", target, sessionId, outcome, summary })` |
| `aitest_job_status({ jobId })` | `aitest_job({ action: "status", jobId })` |
| `aitest_job_result({ jobId, waitMs })` | `aitest_job({ action: "result", jobId, waitMs })` |
| `aitest_job_cancel({ jobId })` | `aitest_job({ action: "cancel", jobId })` |
| `aitest_flaky_report({ target })` *(v5/v6.1)* | `aitest_report({ view: "flaky", target })` |
| `aitest_trace_matrix({ target })` *(v5/v6.1)* | `aitest_report({ view: "traceability", target })` |

---

## 3. Upgrading Host `<repo>/qa/` Safely with `upgrade`

`upgrade` uses `<repo>/qa/.aitest/template-manifest.json` for 3-way hash-safe updates (unmodified managed files update cleanly; customized files emit `<file>.aitest-new` without overwriting; `governance.lock` is **never** auto-approved):

```bash
# 1. Preview planned updates and any local conflicts
npx ai-test-workbench@6.7.0 upgrade --target /path/to/repo --dry-run

# 2. Apply upgrade (defaults to support/** and scripts/audit-results.mjs; pass --scope all for full template check, or --scope engines for graph sidecar status)
npx ai-test-workbench@6.7.0 upgrade --target /path/to/repo

# 3. Review changes and re-seal governance.lock locally as a human reviewer
npx ai-test-workbench@6.7.0 governance status --target /path/to/repo
npx ai-test-workbench@6.7.0 governance approve --target /path/to/repo --by "alice@team" --reason "Upgrade to ai-test-workbench v6.7.0 kernel"

# 4. Verify zero kernel version drift
npx ai-test-workbench@6.7.0 doctor --target /path/to/repo
```

---

## 4. v6.5 / v6.6 → v6.7 Migration: Polyglot Monorepos, CodeMap v5.1 & External Graph Engine

Upgrading from `v6.5.0` / `v6.6.0` to `v6.7.0` is non-breaking and requires no manual test edits:

1. **CodeMap v5.1 & Polyglot Monorepo Auto-Discovery**: `npx ai-test-workbench@6.7.0 map --target /path/to/repo` automatically discovers nested depth-1 and depth-2 (`src|apps|packages|services|modules`) subprojects (Vue 3/TS, Python `FastAPI`/`Flask`/`aiohttp`/`Starlette`/`Django`/`Pytest`, Java, Go, Rust, PHP), supports shared-`.git` monorepo diff remapping and Python `.py` reverse-import narrowing, seamlessly upgrades legacy `schemaVersion: 4` maps to `5` (preserving runtime routes and defects), and emits the `<20ms` lazy-hydrated `knowledge/graph-impact-index.json` (`pipe-sharded-v1`).
2. **Optional Pinned Sidecar Engine Install (`AITEST_DATA_DIR` Migration & `N-1` Rollback)**:
   ```bash
   # Online install of pinned v0.12.1 (verifies 6-platform SHA-256 & Zip-Slip, writes .aitest/engine-manifest.json)
   npx ai-test-workbench@6.7.0 mcp install-engine --target /path/to/repo --engine codebase-memory-mcp

   # Air-gapped / internal mirror install (strict SHA-256 enforced)
   npx ai-test-workbench@6.7.0 mcp install-engine --target /path/to/repo --engine codebase-memory-mcp --from-file ./codebase-memory-mcp-linux-amd64-portable.tar.gz --expected-sha256 <64hex>
   npx ai-test-workbench@6.7.0 mcp install-engine --target /path/to/repo --engine codebase-memory-mcp --mirror-url https://artifacts.internal/cbm/v0.12.1

   # Inspect sidecar status & version pin drift (v6.7.0 supports targetless / uninitialized read-only status)
   npx ai-test-workbench@6.7.0 mcp engine-status
   npx ai-test-workbench@6.7.0 mcp engine-status --target /path/to/repo
   npx ai-test-workbench@6.7.0 upgrade --target /path/to/repo --scope engines --dry-run
   ```
   - Upgrades retain the previous **`N-1`** binary directory for instant rollback; set `AITEST_DATA_DIR` (or `AITEST_CBM_BIN_DIR` / `AITEST_CBM_RUNTIME_DIR` / `AITEST_CBM_CACHE_DIR`) to migrate sidecar data directories cleanly, while ephemeral `os.tmpdir()` skips and `AITEST_DISABLE_EXTERNAL_GRAPH=1` prevent throwaway CBM cache leaks. To stay strictly on zero-dep L0 indexing, pass `--engine builtin` or configure `"codeMap": { "engine": "builtin" }` in `aitest.config.json`.
3. **Windows Defender / EDR & NTFS Ancestor ACL Guidance**:
   - The sidecar binary lives in `%LOCALAPPDATA%\aitw\bin\cbm\<ver>\codebase-memory-mcp.exe` (or custom `AITEST_DATA_DIR\bin\cbm\<ver>\`), never under `<repo>/qa/.aitest/`. If corporate EDR or Windows Defender quarantines the unsigned OSS binary, follow `doctor` recovery guidance to allowlist that directory per local security policy.
   - If the user profile ancestor carries untrusted mutation ACEs (e.g., `CodexSandboxUsers`, `Everyone`, `BUILTIN\Users`) rejected by CBM's NTFS DACL check, the workbench automatically falls back to `%SystemDrive%\aitw-rt` and `%SystemDrive%\aitw-cbm` hardened via `icacls /inheritance:r /grant:r "<user>:(OI)(CI)F"` (unless `AITEST_DATA_DIR` / `AITEST_CBM_RUNTIME_DIR` / `AITEST_CBM_CACHE_DIR` is explicitly configured).
4. **Governance Lock Sealing for `.aitest/mcp.lock` & `.aitest/engine-manifest.json`**:
   - Since `v6.6.0`, whenever `.aitest/mcp.lock` or `.aitest/engine-manifest.json` exists, it is automatically sealed inside `.aitest/governance.lock`. After running `mcp install-engine` or `mcp doctor --lock`, re-seal locally as a human reviewer via `npx ai-test-workbench@6.7.0 governance approve --target /path/to/repo --by "<human>" --reason "Seal graph engine manifest and mcp.lock"`.

---

## 5. Safely Upgrading `@playwright/test` & Official Test Agents

1. Keep exact pinned versions (no `^`) in `<repo>/qa/package.json` matching your CI Docker image `mcr.microsoft.com/playwright:v<version>-noble`.
2. Run `npm install` inside `qa/` to update `package-lock.json`, then install the matching Chromium build:
   ```bash
   npx playwright install chromium
   ```
3. Preview and sync official Test Agents definitions:
   ```bash
   npx ai-test-workbench@6.7.0 update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench@6.7.0 update-agents --target /path/to/repo --loop codex,claude
   ```
4. If an agent file was customized locally, the incoming template is written to `<file>.aitest-new` (exit code `2`). Merge and remove `.aitest-new` (or pass `--force` explicitly).
5. Run `npm run typecheck && npm run lint`, offline `smoke`, and target regressions, then re-seal via human `governance approve`.
