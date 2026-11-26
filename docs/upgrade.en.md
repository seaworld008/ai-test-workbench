# v5.x to v6.4.0 Upgrade & Migration Guide (`upgrade.en.md`)

> [简体中文 (默认)](./upgrade.md) · [Version Compatibility Matrix](../VERSION.en.md) · [Governance Guide](./governance.en.md) · [Changelog](../CHANGELOG.en.md)

This guide documents all breaking changes from **`v5.1.1` / `v6.1.0`** to **`v6.4.0`**, backward-compatibility aliases retained throughout `v6.x` (removed in `v7.0.0`), the automated `upgrade` workflow, and `@playwright/test` maintenance steps.

---

## 1. Breaking Changes Summary (`v5.x / v6.1 -> v6.4.0`)

| Area | `v5.1.1` / `v6.1.0` Behavior | `v6.4.0` Behavior | Compatibility & Removal Window |
|---|---|---|---|
| **MCP Tool Surface (21 -> 17)** | Separate `aitest_heal_*`, `aitest_job_*`, `aitest_flaky_report`, `aitest_trace_matrix` | Consolidated into **`aitest_heal`** (with `discard`), **`aitest_job`**, and **`aitest_report`** (`view: "summary" \| "flaky" \| "traceability" \| "lessons"`), plus **`aitest_bootstrap`** and the dual-target differential oracle **`aitest_parity`**; `tools/list` exposes **17 canonical tools** | `tools/call` forwards all **8 legacy names** throughout `v6.x` with `structuredContent.data._deprecation` and summary warnings (removed in `v7.0.0`) |
| **Per-Command Strict CLI Flags** | Single 89-flag global bag silently ignored unrelated options | Every subcommand (including `bootstrap`, `parity`, `learn`, and `report --view`) declares exact flags in `src/cli/commands.mjs`; `--json` usage errors exit **`64`** | `governance approve` retains `--approver` -> `--by`; `flaky` / `trace-matrix` remain forwarded to `report --view` (`v7.0.0` removal) |
| **Unified `CommandResult v2`, Framed IPC & Exit Codes** | Tail-text stdout scraping for MCP child JSON; mixed usage exit codes | Uniform `CommandResult v2` envelopes (`0=pass / 1=fail / 2=blocked / 64=usage`) over `AITEST_RESULT_FILE` framed IPC | Existing top-level JSON data keys preserved alongside `schemaVersion`, `blockerKind`, `recoverySteps` |
| **Immutable `TrustContext`, Sticky T1 & Redirect Firewall** | Cross-machine lock fallback could relax missing `mac`; `aitest_init` re-signed missing locks | Frozen `TrustContext` opened once; multi-machine `macs` map + sticky T1 anti-strip; `aitest_init` seals clean untouched templates only; 10-hop redirect re-validation | CLI offline `--allow-unbound-results` (T0) remains CLI-only; clean CI verifies protected-file SHA-256 and downgrades unsigned T1 to T0 |
| **Kernel SSoT, App Facade & Exports** | Scripts coupled directly to internals or `templates/playwright-qa/support/*.mjs` | Authoritative `src/kernel/*` wrapped behind `src/app/index.mjs`; exports `.`, `./kernel`, `./app`, `./target-guard`, `./schema-validator` | `templates/playwright-qa/support/` stays synced by transitive closure for standalone host `<repo>/qa` runs |
| **`aitest.config.json` Schema, SymbolTable, Dieselgate & Lockstep** | `AITEST-G101..G115` (15 rules) | Adds `SymbolTable`, `AITEST-G116` (HTTP status equivalence), `AITEST-G117` (Dieselgate product-branching guard), and `AITEST-G118` (cross-directory `lockstepRules` sync gate) for **`18` pluggable gate rules** (`AITEST-G101..G118`); governance lock now also seals `known-blockers.json`, `corpus/**`, `fixtures/upstream-cassettes/**`, and `support/project-rules.json`, alongside `.aitest/baseline-ref` branch-new exemption | All valid `v5` / `v6.x` `aitest.config.json` files remain 100% compatible |

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

`v6.0.0` introduces `upgrade`, using `<repo>/qa/.aitest/template-manifest.json` for 3-way hash-safe updates (unmodified managed files update cleanly; customized files emit `<file>.aitest-new` without overwriting; `governance.lock` is **never** auto-approved):

```bash
# 1. Preview planned updates and any local conflicts
npx ai-test-workbench@6.4.0 upgrade --target /path/to/repo --dry-run

# 2. Apply upgrade (defaults to support/** and scripts/audit-results.mjs; pass --scope all for full template check)
npx ai-test-workbench@6.4.0 upgrade --target /path/to/repo

# 3. Review changes and re-seal governance.lock locally as a human reviewer
npx ai-test-workbench@6.4.0 governance status --target /path/to/repo
npx ai-test-workbench@6.4.0 governance approve --target /path/to/repo --by "alice@team" --reason "Upgrade to ai-test-workbench v6.4.0 kernel"

# 4. Verify zero kernel version drift
npx ai-test-workbench@6.4.0 doctor --target /path/to/repo
```

---

## 4. Safely Upgrading `@playwright/test` & Official Test Agents

1. Keep exact pinned versions (no `^`) in `<repo>/qa/package.json` matching your CI Docker image `mcr.microsoft.com/playwright:v<version>-noble`.
2. Run `npm install` inside `qa/` to update `package-lock.json`, then install the matching Chromium build:
   ```bash
   npx playwright install chromium
   ```
3. Preview and sync official Test Agents definitions:
   ```bash
   npx ai-test-workbench@6.4.0 update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench@6.4.0 update-agents --target /path/to/repo --loop codex,claude
   ```
4. If an agent file was customized locally, the incoming template is written to `<file>.aitest-new` (exit code `2`). Merge and remove `.aitest-new` (or pass `--force` explicitly).
5. Run `npm run typecheck && npm run lint`, offline `smoke`, and target regressions, then re-seal via human `governance approve`.
