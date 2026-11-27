# Four-Layer Anti-Fake-Green Gate, Governance Lock & Heal State Machine (`v6.6`)

> [简体中文 (默认)](./governance.md) · [English README](../README.en.md) · [Architecture](../ARCHITECTURE.en.md) · [ADR-0007 Graph Sidecar](./adr/0007-external-code-graph-engine.en.md) · [Upgrade Guide](./upgrade.en.md)

`ai-test-workbench v6.6` is a standalone **Trustworthy Verification Kernel** for AI coding agents. Anti-fake-green enforcement, external graph-engine supply-chain verification, and safety boundaries are **tool-enforced and fail-closed**, backed by a frozen `TrustContext` opened once at command entry and propagated explicitly across every gate and ledger verifier.

---

## 1. Four-Layer Anti-Fake-Green Gate Kernel (`src/kernel/gate/`)

Every `npx ai-test-workbench@6.6.0 audit`, `npx ai-test-workbench@6.6.0 run --audit`, or `npx ai-test-workbench@6.6.0 verify-change` evaluates four fail-closed layers (any missing dependency, ledger, lock, or unbound input yields tri-state `blocked`, exit code `2`):

| Layer | Gate | Core Checks | Blocked Cheat Patterns |
|---|---|---|---|
| **Layer 0** | **Governance Integrity Lock, Sticky T1, Supply-Chain Lock & Config Schema** | Verifies protected-path SHA-256 digests (`eslint.config.mjs`, `playwright.config.ts`, `aitest.config.json`, `waivers.json`, `known-blockers.json`, `impact-map.json`, `corpus/**`, `fixtures/upstream-cassettes/**`, `support/**` incl. `project-rules.json`, `tests/fixtures/base.ts`, plus **`.aitest/mcp.lock`** and **`.aitest/engine-manifest.json`** via `src/core/config-schema.mjs` + `src/kernel/gate/policy.mjs`), multi-machine `macs`, and sticky T1 anti-strip markers; JSON-Schema-validates `aitest.config.json` (including `codeMap` / `externalEngine`); `src/mcp-hub/auditor.mjs` enforces native sidecar `--ui=false`, bans mutating update/install args, verifies exact semver pin & local binary SHA-256 (`strictChecksum`), and sanitizes indexed code metadata via `sanitizeUntrustedCodeMetadata` | Deleting `governance.lock` to re-sign via `aitest_init`, swapping sidecar binaries or tampering with `.aitest/mcp.lock` / `.aitest/engine-manifest.json`, forging upstream cassettes, unapproved `project-rules.json` injection, stripping `mac` fields back to T0, prompt injection via indexed code comments/symbols |
| **Layer 1** | **Static TypeScript & Playwright Rules** | `tsc --noEmit` + `eslint-plugin-playwright` (banning raw `request.newContext()` and `test.fail()`) + unified `static-runner` AST checks; missing compilers block in CI or when `governance.lock && node_modules` exist | Zero-assertion shells, `.only`, `waitForTimeout()`, `{ force: true }`, unguarded API requests |
| **Layer 2** | **Run Ledger Binding & Waiver Audit** | Verifies `.aitest/runs/<runId>/manifest.json`, workspace input fingerprint (with deterministic filesystem tree fallback for `.gitignore`d QA directories), and `results.json` SHA-256 binding (custom `--results` without `--expected-run-id` or `partialScope: true` ledgers block); separates `passed / failed / flaky / quarantined / skipped / policyExcludedMutation` (`maxSkipped=0` default); enforces human waivers (`<= 5`, `<= 14d` TTL) | Reusing stale green `results.json`, passing a partial `heal attempt` ledger as full green, deleting ledgers to revert to T0, bot-approved waivers |
| **Layer 3** | **AST SymbolTable, Lattice, Dieselgate & Lockstep Guard (`S0–S5`)** | Runs **18 standalone rules (`AITEST-G101..G118`)** via TypeScript AST, lexical scope stack, and `SymbolTable` (`G116` status-literal equivalence, `G117` product-side Dieselgate guard, `G118` cross-directory lockstep sync gate, `.aitest/baseline-ref` branch-new exemption, `git mv` out-of-tests block, plus governance-locked declarative `qa/support/project-rules.json`) | Deleting assertions, `const`/DOM semantic weakening, `S0` tautologies, `test.fail()`, `200->201` flips, product User-Agent/Header test bypasses, single-side lockstep drift, static copy-paste fallback shortcuts |

---

## 2. Human-Only Governance Approval (`npx ai-test-workbench@6.6.0 governance`)

Protected files (including `.aitest/mcp.lock` and `.aitest/engine-manifest.json`) are sealed in `<repo>/qa/.aitest/governance.lock` with an append-only `.aitest/governance-audit.jsonl` trail:

```bash
# Inspect protected governance file hashes (read-only)
npx ai-test-workbench@6.6.0 governance status --target "/path/to/repo"

# Re-seal governance.lock locally as a human after intentional config, graph sidecar, mcp.lock, known-blockers.json, or project-rules.json edits
npx ai-test-workbench@6.6.0 governance approve --target "/path/to/repo" --by "alice@team" --reason "Update staging perf budget and graph engine manifest"
```

> [!IMPORTANT]
> **Physical Privilege Isolation**: `governance approve` and `mcp install-engine` are **never registered as MCP tools**, hard-block when `AITEST_MCP_CHILD=1`, and reject bot/agent approver identifiers (`codex`, `claude`, `ai-agent`, `healer`). Both `upgrade --scope engines` and `aitw learn` **never auto-download binaries, mutate sealed files, or self-sign locks**.

---

## 3. Stateful Heal Governance (`npx ai-test-workbench@6.6.0 heal` / `aitest_heal`)

All failure remediation flows through a T1-MAC-protected state machine (if the failure matches an `open` entry in governance-locked `qa/known-blockers.json`, `begin` hard-blocks immediately with `blockerLinked: true` and exit code `2`):

1. **`aitest_heal(action="begin")`** (CLI: `heal begin`): Reads the latest Run Ledger and structured A/B/C/D diagnostics into `.aitest/heals/<sessionId>.json`:
   - **Class A (locator/wait drift)**: Permits repair (`repairPermitted: true`), capped at **3 cumulative attempts across sessions**.
   - **Class B (environment/auth/guard block)**: **Hard-blocks test edits** (exit `2`); prompts fixing infrastructure or running `auth-login`.
   - **Class C (5xx, uncaught runtime error, contract/business defect)**: **Hard-blocks test edits** (exit `2`); emits `reports/defects/<id>.md` with 32-char W3C/`sw8` `Trace-ID`, `serviceChains`, and `tenantAuthHints`.
   - **Class D (ambiguous requirement)**: **Hard-blocks test edits**; pauses for human clarification.
2. **`aitest_heal(action="attempt")`** (CLI: `heal attempt`): Re-checks Governance Lock + AST Semantic Diff Guard + isolated targeted re-run (writing `.aitest/heals/<sessionId>/attempt-<n>-results.json` without overwriting global `reports/results.json`); trips and escalates on assertion weakening or cap exhaustion.
3. **`aitest_heal(action="conclude")`** (CLI: `heal conclude`): Archives audit trail and writes Class-C defect tickets; `discard` permanently locks the session against resurrection.

---

## 4. Historical Flaky Telemetry & Quarantine (`Flaky Quarantine`)

- Every run appends to `.aitest/runs/index.jsonl`; `src/flaky.mjs` computes rolling 20-run flaky rates (excluding pre-conclusion failures resolved by verified A-class heal sessions).
- Non-critical flaky tests can be placed in T1-MAC-signed `.aitest/quarantine.json` (max `7-day` TTL; auto-released after `5` consecutive clean passes), preventing silent permanent skips.

---

## 5. One-Call Change Verdict & Additive-Only Diff-Impact v3 (`npx ai-test-workbench@6.6.0 verify-change` / `aitest_verify_change`)

Chains the full fail-closed pipeline in one call:
`governance verify` -> `Git merge-base` -> `Additive-Only Fail-Closed Diff-Impact v3 (Global Infra Guard + pipe-sharded-v1)` -> `Playwright Run (Run Ledger)` -> `4-Layer Gate Audit` -> `Optional Dual-Target Parity (--mode parity)` -> `Heal Conflict Check` -> `Diagnose & Trace Matrix`.

- **Additive-Only Fail-Closed Diff-Impact v3 (`src/impact/global-infra-guard.mjs` + `src/impact/graph-index.mjs` + `src/impact/graph-index-codec.mjs`)**:
  - Edits touching Spring global infrastructure (`spring.factories`, `AutoConfiguration.imports`, `WebFilter`, `Interceptor`, `ControllerAdvice`, `WebProperties`, etc.) or Vue global guards/unmapped global components unconditionally fall back to `mode: "full"`.
  - Symbol-level narrowing activates only when coverage thresholds pass, hunks resolve to innermost callable symbols, and no `> 65`-caller `*HIGH_FAN_IN*` sentinel is hit; all other cases fail closed to full suite.
- **Machine-Verifiable Attestation (`src/verdict.mjs`)**: `<repo>/qa/.aitest/runs/<runId>/attestation.json` (in-toto Statement v1), binding **`scope.graphEngine`** (`{ provider, version, binarySha256, mode, usedForNarrowing }`) directly into the attested scope.
- **Human-Readable Verdict & SARIF**: `<repo>/qa/reports/verdict-summary.md` (separating `local-workbench` vs `business-e2e`, plus the **Human Seam Gatekeeper Card**) and `<repo>/qa/reports/verdict.sarif.json`.

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
  npx ai-test-workbench@6.6.0 attest verify --file <attestation.json> --bundle <attestation.sigstore.json> --expect-repo <owner/repo> --expect-workflow <workflow-path> --expect-ref <ref>
  ```
- Private repository note: `signer: github-attest` (default) uses GitHub Artifact Attestations (requires GitHub Enterprise Cloud on private repos); `signer: cosign` logs repository identity to the public Rekor transparency log.
