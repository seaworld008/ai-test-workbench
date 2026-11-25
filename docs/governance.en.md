# Four-Layer Anti-Fake-Green Gate, Governance Lock & Heal State Machine (`v6.2`)

> [简体中文 (默认)](./governance.md) · [English README](../README.en.md) · [Architecture](../ARCHITECTURE.en.md) · [Upgrade Guide](./upgrade.en.md)

`ai-test-workbench v6.2` is a standalone **Trustworthy Verification Kernel** for AI coding agents. Anti-fake-green enforcement and safety boundaries are **tool-enforced and fail-closed**, backed by a frozen `TrustContext` opened once at command entry and propagated explicitly across every gate and ledger verifier.

---

## 1. Four-Layer Anti-Fake-Green Gate Kernel (`src/kernel/gate/`)

Every `npx ai-test-workbench@6.2.0 audit`, `npx ai-test-workbench@6.2.0 run --audit`, or `npx ai-test-workbench@6.2.0 verify-change` evaluates four fail-closed layers (any missing dependency, ledger, lock, or unbound input yields tri-state `blocked`, exit code `2`):

| Layer | Gate | Core Checks | Blocked Cheat Patterns |
|---|---|---|---|
| **Layer 0** | **Governance Integrity Lock, Sticky T1 & Config Schema** | Verifies protected-path SHA-256 digests, multi-machine `macs`, and host sticky T1 anti-strip markers, JSON-Schema-validates `aitest.config.json`, and restricts `aitest_init` sealing to unmodified fresh templates | Deleting `governance.lock` and calling `aitest_init` to re-sign tampering, stripping `mac` fields back to T0, self-authoring `waivers.json`, corrupting configs |
| **Layer 1** | **Static TypeScript & Playwright Rules** | `tsc --noEmit` + `eslint-plugin-playwright` (banning raw `request.newContext()` and `test.fail()`) + unified `static-runner` AST checks; missing compilers block in CI or when `governance.lock && node_modules` exist | Zero-assertion shells, `.only`, `waitForTimeout()`, `{ force: true }`, unguarded API requests |
| **Layer 2** | **Run Ledger Binding & Waiver Audit** | Verifies `.aitest/runs/<runId>/manifest.json`, workspace input fingerprint, and `results.json` SHA-256 binding (custom `--results` without `--expected-run-id` blocks); separates `passed / failed / flaky / quarantined / skipped / policyExcludedMutation` (`maxSkipped=0` default); enforces human waivers (`<= 5`, `<= 14d` TTL) | Reusing stale green `results.json`, deleting ledgers to revert to T0, bot-approved waivers, excessive TTL |
| **Layer 3** | **AST SymbolTable, Lattice & Dieselgate Guard (`S0–S5`)** | Runs **17 standalone rules (`AITEST-G101..G117`)** via TypeScript AST, lexical scope stack, and `SymbolTable` (`G116` status-literal equivalence, `G117` product-side Dieselgate guard, commit-level pooling, `.aitest/baseline-ref` branch-new exemption, `git mv` out-of-tests block) | Deleting assertions, `const`/DOM semantic weakening, `S0` tautologies, `test.fail()`, `expect.poll`/listener cheats, `200->201` flips, product User-Agent/Header test bypasses |

---

## 2. Human-Only Governance Approval (`npx ai-test-workbench@6.2.0 governance`)

Protected files are sealed in `<repo>/qa/.aitest/governance.lock` with an append-only `.aitest/governance-audit.jsonl` trail:

```bash
# Inspect protected governance file hashes (read-only)
npx ai-test-workbench@6.2.0 governance status --target "/path/to/repo"

# Re-seal governance.lock locally as a human after intentional config or waiver edits
npx ai-test-workbench@6.2.0 governance approve --target "/path/to/repo" --by "alice@team" --reason "Update staging perf budget"
```

> [!IMPORTANT]
> **Physical Privilege Isolation**: `governance approve` is **never registered as an MCP tool**, hard-blocks when `AITEST_MCP_CHILD=1`, and rejects bot/agent approver identifiers (`codex`, `claude`, `ai-agent`, `healer`).

---

## 3. Stateful Heal Governance (`npx ai-test-workbench@6.2.0 heal` / `aitest_heal`)

All failure remediation flows through a T1-MAC-protected state machine:

1. **`aitest_heal(action="begin")`** (CLI: `heal begin`): Reads the latest Run Ledger and structured A/B/C/D diagnostics into `.aitest/heals/<sessionId>.json`:
   - **Class A (locator/wait drift)**: Permits repair (`allowedToEditTests: true`), capped at **3 cumulative attempts across sessions**.
   - **Class B (environment/auth/guard block)**: **Hard-blocks test edits** (exit `2`); prompts fixing infrastructure or running `auth-login`.
   - **Class C (5xx, uncaught runtime error, contract/business defect)**: **Hard-blocks test edits** (exit `2`); emits `reports/defects/<id>.md` with 32-char W3C `Trace-ID`.
   - **Class D (ambiguous requirement)**: **Hard-blocks test edits**; pauses for human clarification.
2. **`aitest_heal(action="attempt")`** (CLI: `heal attempt`): Re-checks Governance Lock + AST Semantic Diff Guard + targeted re-run; trips and escalates on assertion weakening or cap exhaustion.
3. **`aitest_heal(action="conclude")`** (CLI: `heal conclude`): Archives audit trail and writes Class-C defect tickets.

---

## 4. Historical Flaky Telemetry & Quarantine (`Flaky Quarantine`)

- Every run appends to `.aitest/runs/index.jsonl`; `src/flaky.mjs` computes rolling 20-run flaky rates.
- Non-critical flaky tests can be placed in T1-MAC-signed `.aitest/quarantine.json` (max `7-day` TTL; auto-released after `5` consecutive clean passes), preventing silent permanent skips.

---

## 5. One-Call Change Verdict (`npx ai-test-workbench@6.2.0 verify-change` / `aitest_verify_change`)

Chains the full fail-closed pipeline in one call:
`governance verify` -> `Git merge-base` -> `Import-Graph Impact v2` -> `Playwright Run (Run Ledger)` -> `4-Layer Gate Audit` -> `Heal Conflict Check` -> `Diagnose & Trace Matrix`, producing:
- Machine-verifiable attestation: `<repo>/qa/.aitest/runs/<runId>/attestation.json` (in-toto Statement v1)
- Human-readable verdict: `<repo>/qa/reports/verdict-summary.md` (explicitly separating `local-workbench` vs `business-e2e`)
- SARIF 2.1.0 report: `<repo>/qa/reports/verdict.sarif.json`

---

## 6. Trust Levels (`T0 / T1 / T2`) & Reusable CI Attestation Workflow

| Trust Level | Definition | Merge-Grade Green? |
|---|---|---|
| **T0** | Unverified local run or downgraded scope | No |
| **T1** | Local Run Ledger + HMAC (proves integrity, not provenance) | No |
| **T2** | Clean checkout re-run on a GitHub-hosted runner, signed keyless via Sigstore with verified workflow OIDC identity | **Yes (only merge-grade green)** |

- Wire `.github/workflows/aitest-verify.yml` via [examples/workflows/use-aitest-verify.yml](../examples/workflows/use-aitest-verify.yml).
- Verify attestations offline with:
  ```bash
  npx ai-test-workbench@6.2.0 attest verify --file <attestation.json> --bundle <attestation.sigstore.json> --expect-repo <owner/repo> --expect-workflow <workflow-path> --expect-ref <ref>
  ```
- Private repository note: `signer: github-attest` (default) uses GitHub Artifact Attestations (requires GitHub Enterprise Cloud on private repos); `signer: cosign` logs repository identity to the public Rekor transparency log.
