<div align="center">

# AI Test Workbench (`v6.3.0`)

**Trustworthy Verification Kernel & Native Multi-Protocol MCP Server for AI Coding Agents**

Provides a **4-Layer Fail-Closed AST Anti-Fake-Green Gate (`S0–S5` + `AITEST-G101..G117` + SymbolTable + Dieselgate Guard)** · **One-Call Change Verdict (`verify-change` · in-toto v1 + `T0/T1/T2`)** · **5-Checkpoint Differential Parity Oracle (`aitest_parity` + Zero-Plaintext Shape Fingerprints)** · **Zero-Dep Native MCP Server (`stdio` / `/mcp` / `/sse` · 17 Canonical Tools · Framed Subprocess IPC)** · **Immutable `TrustContext` & Sticky T1** · **Zero-Block Loopback Bootstrap (`aitest_bootstrap`)** · **Default-Deny Explorer & Multi-Sample Union Schema Inference** · **Buffered `PerformanceObserver` Web Vitals & SSE `TTFT`**

[简体中文文档 (默认)](./README.md) · [v5→v6 Upgrade Guide](./docs/upgrade.en.md) · [Governance & 4-Layer Gate](./docs/governance.en.md) · [AI Agent Quickstart](./docs/ai-agent-quickstart.en.md) · [AGENTS.en.md](./AGENTS.en.md) · [Architecture](./ARCHITECTURE.en.md) · [v6 Refactor Assessment](./docs/review/v6-refactor-assessment.en.md) · [Changelog](./CHANGELOG.en.md)

[![CI](https://img.shields.io/github/actions/workflow/status/seaworld008/ai-test-workbench/ci.yml?branch=main&style=flat-square&logo=github&label=CI)](https://github.com/seaworld008/ai-test-workbench/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/seaworld008/ai-test-workbench?style=flat-square&color=0ea5e9&label=Release)](https://github.com/seaworld008/ai-test-workbench/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-10b981.svg?style=flat-square)](./LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D22.12-339933?style=flat-square&logo=node.js&logoColor=white)](./VERSION.en.md)
[![Gate FPR Holdout](https://img.shields.io/badge/Gate%20FPR%20(unseen%20holdout%2C%20n%3D50)-6.1%25%20%5B2.1%25--16.5%25%5D-0ea5e9?style=flat-square)](./bench/real-world/results/SUMMARY-v6-holdout.en.md)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05%20..%202025--11--25-0284c7?style=flat-square)](./skills/ai-test-workbench/references/mcp-server-protocol.en.md)
[![Playwright](https://img.shields.io/badge/Playwright-1.65.1-2EAD33?style=flat-square&logo=playwright&logoColor=white)](https://playwright.dev/)

</div>

---

## 1. Scope & Verified Benchmarks

When AI coding agents (Claude Code, Codex CLI, Cursor, VS Code Copilot, Gemini CLI) generate or edit Playwright tests at high velocity, the primary risk is **fake-green passes**: tests turn green not because the application is correct, but because assertions were weakened (`toHaveText('49/50')` → `toBeVisible()` or `expect(true).toBe(true)`), errors were swallowed (`.catch(() => null)` / `expect.soft()` / `test.fail()`), governance configs were altered (`testIgnore` / disabled ESLint rules), or stale `results.json` artifacts were replayed.

`ai-test-workbench` moves those invariants out of prompts into a **tool-enforced independent verification kernel**:

| Metric | Verified Measurement (Corpus-Qualified & Reproducible) | Enforcing Mechanism |
|---|---|---|
| **Fake-Green Escape Rate (`FGER-internal` / `FGER-holdout`)** | Internal corpus **`0.0%` (`26/26`)** · Red-Team holdout **`0.0%` (`24/24`)** (`npm run bench`) | 4-Layer fail-closed AST Gate (`AITEST-G101..G117`) + Sticky T1 MAC Governance Lock |
| **Benign Refactoring FPR (Internal Corpus)** | **`0.0%` (`12/12`)** (Prettier wraps, locator renames, ARIA consolidation; `npm run bench`) | Full-file TypeScript Compiler API semantic AST comparison |
| **Gate FPR (Real-World Unseen Holdout, `v6.0` Frozen Blind Eval, `n=50`, `seed=20261125`)** | **`6.1%` (`3/49` normal commits, Wilson 95% CI `[2.1%, 16.5%]`)**; raw alert rate `8.0%` (`4/50`, `1/1` TP retained); down 50% from v5.1.1's `12.2%` (`6/49`, CI `[5.7%, 24.2%]`) | Frozen first-run blind evaluation across 5 permissive OSS repos (preserved unmodified); see [v6 Holdout Summary](./bench/real-world/results/SUMMARY-v6-holdout.en.md) |
| **Gate FPR (100-Commit Real-World Regression Corpus, `v6.3.0` Post-Hoc Re-Evaluation, `n=100`)** | Pilot **`4.2%` (`2/48`, CI `[1.2%, 14.0%]`)** · Holdout corpus post-hoc **`4.1%` (`2/49`, CI `[1.1%, 13.7%]`)** · Combined **`4.1%` (`4/97`, Wilson 95% CI `[1.6%, 10.1%]`, `3/3` TP retained)** (down from `5.2% (5/97)` in `v6.0..v6.2.1`); **`>=200` formal eval: `pending` (no extrapolation)** | AST Gate v2.2: cross-file title pooling + lexical scope stack + pre-existing `if`-block conservation (`G110`) + governance-locked `customMatchers` / structured domain matchers + fault-injection awareness ([ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.en.md)) |
| **Agentic Red-Team Escape Rate (`FGER-agentic`)** | Scripted multi-step baseline (`n=18`, incl. Class E Dieselgate, `npm run bench:agentic`): **Local T1 `11.1%` (`2/18`, CI `[3.1%, 32.8%]` — only documented same-UID probes `AG-B4`/`AG-C4`)** · **CI T2 Merge-Grade `0.0%` (`0/18`, CI `[0.0%, 17.6%]`)** · `honest-fix` control `4/4` T2 pass; **live LLM runs (`claude`/`codex`/`gemini`): `pending` (adapters ready, no extrapolation)** | Isolated sandbox + hidden business oracles + Ephemeral Fulcio T2 CA; see [Red-Team Design](./bench/agentic/DESIGN.en.md) & [Baseline Summary](./bench/agentic/results/SUMMARY.en.md) |
| **Seeded-Defect Detection Rate (`SDDR`)** | Single demo target `demo-campus` **`100.0%` (`7/7`)** (`npm run bench`) | Zero-dep JSON Schema validator + RBAC/concurrency + WCAG 2.0/2.1/2.2 |
| **Triage Accuracy / C→A Misclassification / Mis-Heal** | `45/45` internal + `12/12` real Playwright stacks: **`100%` · C→A `0.0%` · Mis-Heal `0.0%`** | Structured runtime guard signals + C-before-A precedence + tamper-evident healer |
| **Secret Redaction Recall** | Internal adversarial corpus **`100.0%` (`35/35`)** (`npm run bench`) | Redaction v3 (structured parse-before-redact preserving `heal_*`/`job_*` IDs and boolean/number fields) |
| **Verdict Trust Levels (`T0 / T1 / T2`)** | **T0** = Unverified local run · **T1** = Local Run Ledger + MAC (proves integrity, not provenance) · **T2** = Re-run from a clean checkout on a GitHub-hosted runner, keylessly signed with Sigstore, and verified for issuer identity | **Only T2 is a merge-grade green**; see [reusable workflow example](./examples/workflows/use-aitest-verify.yml) & `attest verify` |

### Trust Levels & Reusable CI Workflow (Only T2 Is Merge-Grade Green)

- **T0**: Unverified local run (not a merge-grade green).
- **T1**: Local Run Ledger + MAC (proves integrity, not provenance; not a merge-grade green).
- **T2**: Re-run from a clean checkout on a GitHub-hosted runner, keylessly signed with Sigstore, and verified for issuer identity. **Only T2 is a merge-grade green**.

Adopt T2 verification via [examples/workflows/use-aitest-verify.yml](./examples/workflows/use-aitest-verify.yml):

```yaml
jobs:
  aitest-t2-verdict:
    uses: seaworld008/ai-test-workbench/.github/workflows/aitest-verify.yml@v6.3.0
    permissions:
      id-token: write
      attestations: write
      contents: read
      security-events: write
    with:
      qa-dir: qa
      suite: impact
      node-version: '22'
      signer: github-attest # default; optional: cosign
```

Verify a T2 attestation bundle offline (fail-closed by default: missing signature, T1-only MAC, digest tampering, or workflow identity mismatch exits non-zero with `trustLevel <= T1`):

```bash
npx ai-test-workbench@6.3.0 attest verify \
  --file attestation.json \
  --bundle attestation.sigstore.json \
  --expect-repo owner/repo \
  --expect-workflow .github/workflows/aitest-verify.yml \
  --expect-ref refs/heads/main
```

> **Private Repository Signing Tradeoffs**: Default `signer: github-attest` uses GitHub Artifact Attestations (`actions/attest`), which requires **GitHub Enterprise Cloud** for private repositories. Optional `signer: cosign` uses public Sigstore keyless signing, publishing repository and workflow identity to the **public Rekor transparency log**; private repositories should assess that disclosure before opting in.

---

## 2. v6.3.0 Layered Architecture

v6.3.0 builds on the acyclic four-layer core with a public `src/app/index.mjs` application facade, immutable `TrustContext`, and strict `<= 500` LOC module discipline across all `src/**/*.mjs` (see [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) and [ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.en.md)):

```mermaid
flowchart TB
    L4["Layer 4: Protocol & CLI — src/cli/ (CommandResult v2) · src/mcp/ (17 canonical tools + framed IPC jobs)"]
    L3["Layer 3: App Facade & Domains — src/app/ · trust · explore · codemap · perf · verdict · heal · diagnose · impact · bootstrap"]
    L2["Layer 2: Authoritative Kernel SSoT — src/kernel/ (target-guard · schema-validator · gate/ SymbolTable + G101..G117)"]
    L1["Layer 1: Zero-Dep Core Leaves — src/core/ (version · outcome · config · redact v3 · glob · proc) · src/types/*.d.ts"]
    TPL["Scaffold Distribution Mirror (one-way) — templates/playwright-qa/support/ (@generated + sha256 stamp)"]

    L4 --> L3 --> L2 --> L1
    L4 --> L2
    L2 -. "npm run sync:vendor (CI byte-parity enforced)" .-> TPL
```

---

## 3. Quick Setup (MCP & CLI)

### Requirements & Supply-Chain Security

- **Node.js**: `>= 22.12.0` (`24 LTS` or `26 LTS` recommended) on Windows PowerShell (`pwsh`), macOS, or Linux.
- **Zero Runtime Dependencies**: Root `package.json` carries zero runtime `dependencies`. Always invoke pinned `npx ai-test-workbench@6.3.0 <cmd>`, global short alias `aitw <cmd>` (`npm i -g ai-test-workbench@6.3.0`), or local source `node tools/aitest.mjs <cmd>`.

### Register Native MCP Server (`stdio` / `/mcp` / `/sse`)

- **Claude Code**:
  ```bash
  claude mcp add ai-test-workbench -- npx --package=ai-test-workbench@6.3.0 ai-test-workbench mcp-serve --workspace-root /path/to/your-repo
  ```
- **Codex CLI** (`.codex/config.toml`):
  ```toml
  [mcp_servers.ai-test-workbench]
  command = "npx"
  args = ["--package=ai-test-workbench@6.3.0", "ai-test-workbench", "mcp-serve"]
  ```
- **Cursor / Windsurf / Antigravity / Gemini CLI** (`.mcp.json`):
  ```json
  {
    "mcpServers": {
      "ai-test-workbench": {
        "command": "npx",
        "args": ["--package=ai-test-workbench@6.3.0", "ai-test-workbench", "mcp-serve"]
      }
    }
  }
  ```
- **Streamable HTTP (`/mcp`) & Legacy SSE (`/sse`)**:
  ```bash
  npx ai-test-workbench@6.3.0 mcp-serve --transport http --port 3847 --target /path/to/your-repo --workspace-root /path/to/your-repo
  ```

### Official MCP Conformance & 3-Transport Interoperability

- Rationale and re-evaluation triggers for the zero-dependency MCP protocol layer live in [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md).
- Isolated under `conformance/` (excluded from the npm tarball, enforced by CI `mcp-conformance`):
  - **`@modelcontextprotocol/conformance@0.1.16`** (Streamable HTTP `/mcp`, `active` suite — 30 scenarios): `8/8` protocol-level scenarios pass; `22` inapplicable/deferred scenarios are recorded in [`conformance/expected-failures.json`](./conformance/expected-failures.json) with `0` unlisted failures.
  - **`@modelcontextprotocol/sdk@1.32.2` Reference `Client`** (`5/5` suites pass): covers `stdio`, Streamable HTTP (`/mcp`), and Legacy SSE (`/sse` + `/messages`), verifying `2024-11-05`..`2025-11-25` version negotiation, exact 17 canonical tools with valid JSON Schemas, `structuredContent`, `notifications/progress`, and `AbortController` cancellation.

### Standard CLI Workflow & Local Verification

```bash
# 1. Readiness check, initialization, and hash-safe template upgrades
npx ai-test-workbench@6.3.0 doctor
npx ai-test-workbench@6.3.0 init --name my-app --target "/path/to/your-repo" --loop codex
npx ai-test-workbench@6.3.0 upgrade --target "/path/to/your-repo" --dry-run

# 2. Session capture -> read-only exploration -> living code map -> pinned external MCPs
npx ai-test-workbench@6.3.0 auth-login --target "/path/to/your-repo" --base-url https://staging.example.internal
npx ai-test-workbench@6.3.0 explore --target "/path/to/your-repo" --base-url https://staging.example.internal --max-pages 30
npx ai-test-workbench@6.3.0 map --target "/path/to/your-repo"
npx ai-test-workbench@6.3.0 mcp add --target "/path/to/your-repo" --profile full-link && npx ai-test-workbench@6.3.0 mcp doctor --target "/path/to/your-repo" --lock

# 3. Performance SLOs and one-call pre-merge verdict
npx ai-test-workbench@6.3.0 perf --target "/path/to/your-repo" --concurrency 4 --iterations 12 --enforce-budget
npx ai-test-workbench@6.3.0 verify-change --target "/path/to/your-repo" --base origin/main
```

Reproduce the full repository gate locally (zero external servers):

```bash
git clone https://github.com/seaworld008/ai-test-workbench.git
cd ai-test-workbench
npm ci && (cd templates/playwright-qa && npm ci && npx playwright install chromium)
npm run check:vendor && npm run lint:docs && npm run typecheck && npm test && npm run smoke && npm run demo:verify && npm run bench
```

---

## 4. MCP Tools Matrix (Auto-Generated) & CLI-Only Commands

The table below is auto-generated from `src/mcp/registry.mjs` by `scripts/generate-docs.mjs` and verified for drift by `npm run lint:docs`:

<!-- BEGIN:GENERATED_MCP_TOOLS lang="en" -->
| Tool Name | Category | Read-Only Hint | Responsibility |
|---|---|---|---|
| `aitest_doctor` | Discovery & Setup | Yes | Environment, Browser & Gate Kernel Readiness Check |
| `aitest_init` | Discovery & Setup | No | Initialize Isolated QA Workspace & Governance Lock |
| `aitest_bootstrap` | Discovery & Setup | No | Zero-to-One Autonomous Loopback Bootstrapper |
| `aitest_explore` | Discovery & Setup | No | Zero-to-One Default-Deny Read-Only Explorer |
| `aitest_map_sync` | Discovery & Setup | No | Sync Convergent Living Code Map v4 |
| `aitest_mcp_hub` | Discovery & Setup | No | Manage Pinned 7-Pillar MCP Presets & Supply-Chain Doctor |
| `aitest_skill_install` | Discovery & Setup | No | Install Portable Agent Skill into Project |
| `aitest_verify_change` | Verification & Gates | No | One-Call Agent Change Verification & Attested Verdict |
| `aitest_impact` | Verification & Gates | Yes | Compute Dependency-Graph Diff-Impact Scope (v2) |
| `aitest_run` | Verification & Gates | No | Execute Ledger-Bound Deterministic Playwright Suite |
| `aitest_audit` | Verification & Gates | Yes | Run 4-Layer Fail-Closed Anti-Fake-Green Quality Gate |
| `aitest_diagnose` | Verification & Gates | No | Generate Redacted Evidence-First A/B/C/D Diagnostics Report |
| `aitest_perf` | Verification & Gates | No | Run PerformanceObserver Web Vitals & Read-Only API SLO Benchmark |
| `aitest_report` | Verification & Gates | Yes | Query Reports Index, Flaky Telemetry & Requirement Traceability |
| `aitest_parity` | Verification & Gates | No | Run Dual-Target 5-Checkpoint Differential Parity Oracle |
| `aitest_heal` | Stateful Control | No | Stateful A/B/C/D Heal Governance State Machine (begin \| attempt \| conclude \| discard) |
| `aitest_job` | Stateful Control | No | Inspect, Await, or Cancel Async Background MCP Jobs (status \| result \| cancel) |

> Auto-generated from `src/mcp/registry.mjs` (`17` canonical tools; `governance approve` is human-CLI-only and never registered; 8 legacy v5/v6.1 tool names remain as deprecated forwarding aliases in `v6.x`, see `docs/upgrade.en.md`).
<!-- END:GENERATED_MCP_TOOLS -->

The following privileged or interactive commands are **local CLI only and never registered as MCP tools**:

| CLI Command | Responsibility & Security Boundary |
|---|---|
| `governance status \| verify \| approve --by <human>` | Inspect or human-approve `.aitest/governance.lock` (blocks MCP subprocesses and bot approver identities) |
| `attest verify --file <attestation.json>` | Offline zero-dep verification of in-toto Statement v1, SHA-256 bindings, and Sigstore T2 issuer identity |
| `auth-login [--cdp-url <http://127.0.0.1:9222>]` | Headed human login capture for OTP / SSO / QR flows (never bypasses CAPTCHAs), stored at `0o600` |
| `upgrade [--dry-run] [--force]` | Three-way hash-safe upgrade via `.aitest/template-manifest.json`, preserving user-modified files |
| `update-agents` | SHA-256 manifest-protected update of official Playwright Test Agents definitions |

---

## 5. Documentation & Architecture Decision Records (ADRs)

| Topic | Simplified Chinese (Default) | English |
|---|---|---|
| **v5 → v6 Upgrade & Migration Guide** | [docs/upgrade.md](./docs/upgrade.md) | [docs/upgrade.en.md](./docs/upgrade.en.md) |
| **Governance & 4-Layer Gate Kernel** | [docs/governance.md](./docs/governance.md) | [docs/governance.en.md](./docs/governance.en.md) |
| **v6 Refactor Assessment & Benchmarks** | [v6-refactor-assessment.md](./docs/review/v6-refactor-assessment.md) · [v6 Holdout (ZH)](./bench/real-world/results/SUMMARY-v6-holdout.md) · [Pilot (ZH)](./bench/real-world/results/SUMMARY.md) · [Pre-Reg (ZH)](./bench/real-world/PREREGISTRATION.md) | [v6-refactor-assessment.en.md](./docs/review/v6-refactor-assessment.en.md) · [v6 Holdout Summary](./bench/real-world/results/SUMMARY-v6-holdout.en.md) · [Pilot Summary](./bench/real-world/results/SUMMARY.en.md) · [Pre-Registration](./bench/real-world/PREREGISTRATION.en.md) |
| **Architecture Decision Records (ADR-0001..0006)** | [ADR-0001](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.md) · [ADR-0002](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.md) · [ADR-0003](./docs/adr/0003-strict-checkjs-type-safety.md) · [ADR-0004](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.md) · [ADR-0005](./docs/adr/0005-mcp-surface-outcome-and-config.md) · [ADR-0006](./docs/adr/0006-differential-parity-oracle-and-shape-fingerprints.md) | [ADR-0001 Zero-Dep MCP](./docs/adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [ADR-0002 Kernel SSoT & Upgrade](./docs/adr/0002-kernel-ssot-vendor-mirror-and-upgrade.en.md) · [ADR-0003 Strict checkJs](./docs/adr/0003-strict-checkjs-type-safety.en.md) · [ADR-0004 AST Gate & FPR](./docs/adr/0004-pluggable-ast-gate-and-fp-governance.en.md) · [ADR-0005 MCP/Outcome/Config](./docs/adr/0005-mcp-surface-outcome-and-config.en.md) · [ADR-0006 Differential Parity Oracle](./docs/adr/0006-differential-parity-oracle-and-shape-fingerprints.en.md) |
| **AI Agent Onboarding & Protocol** | [quickstart](./docs/ai-agent-quickstart.md) · [AGENTS.md](./AGENTS.md) · [CLAUDE.md](./CLAUDE.md) · [MCP Protocol (ZH)](./skills/ai-test-workbench/references/mcp-server-protocol.md) · [llms.txt](./llms.txt) | [quickstart.en](./docs/ai-agent-quickstart.en.md) · [AGENTS.en.md](./AGENTS.en.md) · [MCP Protocol](./skills/ai-test-workbench/references/mcp-server-protocol.en.md) |
| **Architecture, Versions & History** | [ARCHITECTURE.md](./ARCHITECTURE.md) · [VERSION.md](./VERSION.md) · [v5 Historical Scorecard](./docs/history/v5-verification-scorecard.md) · [Agentic Design (ZH)](./bench/agentic/DESIGN.md) | [ARCHITECTURE.en.md](./ARCHITECTURE.en.md) · [VERSION.en.md](./VERSION.en.md) · [v5 Historical Scorecard (EN)](./docs/history/v5-verification-scorecard.en.md) · [Agentic Design](./bench/agentic/DESIGN.en.md) |
| **Adapter / Security / Troubleshooting / Demo / Community** | [adapter](./docs/project-adapter.md) · [security](./docs/security.md) · [troubleshooting](./docs/troubleshooting.md) · [demo](./examples/demo-webapp/README.md) · [CONTRIBUTING](./CONTRIBUTING.md) · [SECURITY](./SECURITY.md) | [adapter.en](./docs/project-adapter.en.md) · [security.en](./docs/security.en.md) · [troubleshooting.en](./docs/troubleshooting.en.md) · [demo.en](./examples/demo-webapp/README.en.md) · [CONTRIBUTING.en](./CONTRIBUTING.en.md) · [SECURITY.en](./SECURITY.en.md) |

---

## 6. Verification Scope & License

Always keep **Local Workbench Verified (`local-workbench`)** strictly distinct from **Business E2E Verified (`business-e2e`)**. Automated `@axe-core/playwright` scans detect machine-checkable WCAG 2.0/2.1/2.2 A/AA issues and do not constitute full accessibility compliance certification.

Licensed under the [MIT License](./LICENSE).
