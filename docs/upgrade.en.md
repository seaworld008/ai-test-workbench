# v5.x to v6.0.0 Upgrade & Migration Guide (`upgrade.en.md`)

> [简体中文 (默认)](./upgrade.md) · [Version Compatibility Matrix](../VERSION.en.md) · [Governance Guide](./governance.en.md) · [Changelog](../CHANGELOG.en.md)

This guide documents all breaking changes from **`v5.1.1`** to **`v6.0.0`**, backward-compatibility aliases retained throughout `v6.x` (removed in `v7.0.0`), the automated `upgrade` workflow, and `@playwright/test` maintenance steps.

---

## 1. Breaking Changes Summary (`v5.x -> v6.0.0`)

| Area | `v5.1.1` Behavior | `v6.0.0` Behavior | Compatibility & Removal Window |
|---|---|---|---|
| **MCP Tool Surface (21 -> 17)** | Separate tools `aitest_heal_begin`, `aitest_heal_attempt`, `aitest_heal_conclude` and `aitest_job_status`, `aitest_job_result`, `aitest_job_cancel` | Consolidated into **`aitest_heal`** (`action: "begin" \| "attempt" \| "conclude"`) and **`aitest_job`** (`action: "status" \| "result" \| "cancel"`); `tools/list` exposes **17 canonical tools** | `tools/call` accepts all 6 v5 names throughout `v6.x`, forwarding automatically with `structuredContent.data._deprecation` and a warning in `summary` (removed in `v7.0.0`) |
| **Per-Command Strict CLI Flags** | Single 89-flag global bag silently ignored unrelated options | Each of the 22 subcommands declares its exact allowed flags in `src/cli/commands.mjs`; unrelated flags exit `1` with closest-flag suggestion; `<cmd> --help` lists valid flags | `governance approve` retains `--approver` -> `--by` as a deprecated warning alias (removed in `v7.0.0`) |
| **Unified CLI `--json` & Exit Codes** | `init` lacked `--json`; `run --audit` exited `1` on `blocked` | All `blocked` gate outcomes uniformly exit **`2`**; `init --json` emits structured JSON plan/results | Existing top-level JSON data keys preserved |
| **6 Fail-Closed Tightening Changes** | Missing TS compiler passed Layer 3; missing `tsc/eslint` in CI warned only; custom `--results` skipped Ledger; uninitialized dirs passed; malformed URLs passed; corrupt `aitest.config.json` fell back to defaults | All 6 paths now return `outcome: "blocked"` (exit code `2`) | Actionable error guidance printed; CLI-only `--allow-unbound-results` remains for explicit human offline T0 audits (never exposed to MCP) |
| **Kernel Programmatic Imports** | Internal scripts imported `templates/playwright-qa/support/*.mjs` | Authoritative source lives in `src/kernel/*` and exports via `ai-test-workbench`, `ai-test-workbench/kernel`, `ai-test-workbench/target-guard`, and `ai-test-workbench/schema-validator` | `templates/playwright-qa/support/` stays synced as a standalone offline mirror for user `<repo>/qa` directories |
| **`aitest.config.json` Schema & Rule Overrides** | No schema validation or per-rule config | Strict JSON Schema validation enabled; optional `rules` map supports per-rule overrides (`AITEST-G101..G115`), protected by `governance.lock` | All valid `v5` `aitest.config.json` files remain 100% compatible |

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

---

## 3. Upgrading Host `<repo>/qa/` Safely with `upgrade`

`v6.0.0` introduces `upgrade`, using `<repo>/qa/.aitest/template-manifest.json` for 3-way hash-safe updates (unmodified managed files update cleanly; customized files emit `<file>.aitest-new` without overwriting; `governance.lock` is **never** auto-approved):

```bash
# 1. Preview planned updates and any local conflicts
npx ai-test-workbench@6.1.0 upgrade --target /path/to/repo --dry-run

# 2. Apply upgrade (defaults to support/** and scripts/audit-results.mjs; pass --scope all for full template check)
npx ai-test-workbench@6.1.0 upgrade --target /path/to/repo

# 3. Review changes and re-seal governance.lock locally as a human reviewer
npx ai-test-workbench@6.1.0 governance status --target /path/to/repo
npx ai-test-workbench@6.1.0 governance approve --target /path/to/repo --by "alice@team" --reason "Upgrade to ai-test-workbench v6.0.0 kernel"

# 4. Verify zero kernel version drift
npx ai-test-workbench@6.1.0 doctor --target /path/to/repo
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
   npx ai-test-workbench@6.1.0 update-agents --target /path/to/repo --loop codex,claude --dry-run
   npx ai-test-workbench@6.1.0 update-agents --target /path/to/repo --loop codex,claude
   ```
4. If an agent file was customized locally, the incoming template is written to `<file>.aitest-new` (exit code `2`). Merge and remove `.aitest-new` (or pass `--force` explicitly).
5. Run `npm run typecheck && npm run lint`, offline `smoke`, and target regressions, then re-seal via human `governance approve`.
