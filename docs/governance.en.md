# 4-Layer Anti-Fake-Green Gate Kernel, Governance Lock & Stateful Healer Guide (`v5.0`)

> [简体中文 (默认)](./governance.md) · [English README](../README.en.md) · [Architecture](../ARCHITECTURE.en.md) · [Verification Scorecard](./review/v5-verification-scorecard.en.md)

`ai-test-workbench v5.0` serves as an **independent Trustworthy Verification Kernel for AI coding agents**. Rather than trusting prompt-only instructions, governance rules are **tool-enforced** at the AST, git-diff, ledger, and filesystem-hash layers.

---

## 1. 4-Layer Anti-Fake-Green Gate Kernel (`support/gate-kernel.mjs`)

Every `aitest audit`, `aitest run --audit`, and one-call `aitest verify-change` invocation enforces four sequential gates:

| Layer | Gate | What It Verifies | Cheating Patterns Blocked |
|---|---|---|---|
| **Layer 0** | **Governance Tamper Lock (`governance.lock`)** | Verifies SHA-256 digests across 11 protected QA files (`eslint.config.mjs`, `playwright.config.ts`, `aitest.config.json`, `waivers.json`, `perf-budget.json`, `support/*.mjs`, `tests/fixtures/base.ts`, etc.) | Agent disabling ESLint rules, adding `testIgnore` or `retries: 5` in `playwright.config.ts`, or self-authoring `waivers.json` entries |
| **Layer 1** | **Static Type & Playwright Lint Gate** | `tsc --noEmit` + `eslint-plugin-playwright` (including bans on raw `request.newContext()` and `test.fail()`) | Zero-assertion specs, `.only`, `waitForTimeout()`, `{ force: true }`, bypassing guarded fixtures |
| **Layer 2** | **Run Ledger Binding & Waiver Accounting** | Validates `.aitest/runs/<runId>/manifest.json` workspace input hashes; strictly separates `passed / failed / flaky / quarantined / skipped / policyExcludedMutation`; deduplicates `@mutation` by `file:line`; enforces human `approvedBy`, linked `issue`/`traceId`, `<= 5` max waivers, and `<= 14d` TTL | Replaying stale green `results.json` after code changes, bot-signed waivers, indefinite test suppression |
| **Layer 3** | **Assertion Strength Lattice (`S0–S5`) & Semantic Diff Guard** | Inspects all tracked and untracked changes across `qa/`, scoring assertions from `S5` (exact value) -> `S4` (structural/schema) -> `S3` (substring/regex) -> `S2` (visibility/state) -> `S1` (existence/truthy) -> `S0` (tautology) across rules `AITEST-G101..G113` | Downgrading `toHaveText('49/50')` to `toBeVisible()`, `expect(true).toBe(true)`, `test.fail()`, `.catch(() => null)`, `expect.soft()`, `if (...) { expect(...) }`, flipping `200` to `500` to match broken APIs, empty `verifyNothing()` helpers |

---

## 2. Human-Only Governance Approval (`aitest governance`)

Protected governance files are sealed in `<repo>/qa/.aitest/governance.lock` alongside an append-only audit log `.aitest/governance-audit.jsonl`:

```bash
# Check governance lock integrity (read-only)
npx ai-test-workbench governance status --target "/path/to/repo"

# Re-seal protected governance files from a human terminal after intentional updates
npx ai-test-workbench governance approve --target "/path/to/repo" --approver "alice@team" --reason "Update staging LCP budget"
```

> [!IMPORTANT]
> **Privilege Separation**: `governance approve` is **never exposed as an MCP tool**, hard-fails whenever `AITEST_MCP_CHILD=1`, and rejects bot identities (`codex`, `claude`, `agent`, `healer`, etc.).

---

## 3. Stateful Heal Session State Machine (`aitest heal` / `aitest_heal_*`)

Instead of letting agents freely edit specs in an unmonitored loop, repairs follow a persisted state machine:

1. **`aitest_heal_begin`**: Reads the latest `Run Ledger` and structured diagnostics (`A / B / C / D`) to initialize `.aitest/heals/<sessionId>.json`:
   - **Class A (Locator / Sync Drift)**: Grants `allowedToEditTests: true` with a strict **3-attempt cap**.
   - **Class B (Environment / Auth / Guard Block)**: **Hard-blocks spec edits** (exit `2`) and surfaces infrastructure remediation steps.
   - **Class C (Backend `5xx`, Uncaught `pageerror`, Schema / Business Bug)**: **Hard-blocks spec edits** (exit `2`) and automatically writes a Trace-ID-linked defect ticket under `reports/defects/<id>.md`.
   - **Class D (Requirement Ambiguity)**: **Hard-blocks spec edits** and requests human clarification.
2. **`aitest_heal_attempt`**: Re-runs the target spec, Semantic Diff Guard, and Governance Lock check on each attempt; trips the circuit breaker on semantic weakening or after 3 failed tries.
3. **`aitest_heal_conclude`**: Seals the heal session record for auditability.

---

## 4. Flaky Telemetry & Auto-Quarantine

- Run history in `.aitest/runs/index.jsonl` computes rolling flaky rates over the last 20 runs (`src/flaky.mjs`).
- Quarantined specs in `.aitest/quarantine.json` carry a mandatory `<= 7d` TTL and auto-release after `5` consecutive clean passes.

---

## 5. One-Call Change Verdict (`aitest verify-change` / `aitest_verify_change`)

Before opening or merging a PR, one call orchestrates `governance verify` → `Import-Graph Impact v2` → `Playwright Run (Run Ledger)` → `4-Layer Gate Audit` → `Diagnose & Trace Matrix`, producing:
- Machine-verifiable attestation: `<repo>/qa/.aitest/runs/<runId>/attestation.json`
- Human-readable summary: `<repo>/qa/reports/verdict-summary.md` (explicitly labeling `local-workbench` vs `business-e2e` scope)
- GitHub Code Scanning report: `<repo>/qa/reports/verdict.sarif.json`
