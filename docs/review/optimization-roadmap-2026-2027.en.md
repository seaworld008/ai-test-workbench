# ai-test-workbench Optimization Roadmap 2026 Q4 – 2027 (English Summary)

> [简体中文完整版](./optimization-roadmap-2026-2027.md) · [Architecture & Code Review](./architecture-code-review-2026-11.en.md) · [v5.0 Scorecard](./v5-verification-scorecard.en.md) · [ADR-0001](../adr/0001-mcp-protocol-stack-and-zero-dep-kernel.en.md) · [README](../../README.en.md)

> **Execution Update (`v5.0.0` Delivered, 2026-11-24)**: R0 Trustworthy Kernel fixes, R1 Agent-Native Governance (`aitest_verify_change`, `governance.lock`, `Run Ledger`, stateful `aitest_heal_*`, `Flaky Quarantine`), and R2 intelligence & benchmark (`Import-Graph Impact v2`, `CodeMap v4`, `REQ-xxx` traceability, JSON Schema contracts, `npm run bench`) are complete and verified: **`FGER = 0.0% (26/26)`**, **`SDDR = 100.0% (7/7)`**, **`Triage = 100.0% (45/45)`**, **`Redaction = 100.0% (35/35)`**, **`Mis-Heal = 0.0%`**. See [v5-verification-scorecard.en.md](./v5-verification-scorecard.en.md).

## Positioning

ai-test-workbench is the **independent, trustworthy, auditable verification layer for AI coding agents**. Every code change gets one MCP call that returns a tamper-resistant, falsifiable, explainable verdict.

## Principles

1. The coding agent never defines its own success criteria.
2. Use AI once, then replay deterministically.
3. Every gate must be falsifiable and measured.
4. Governance is code, not prompts.
5. Local-first, read-only by default, deny by default.
6. Metrics drive convergence.

## North-Star Metrics

| Metric | R1 target | R2 target |
|---|---|---|
| Fake-Green Escape Rate (FGER) | ≤ 10% | ≤ 3% |
| Seeded Defect Detection Rate (SDDR) | ≥ 70% | ≥ 85% |
| Mutation Score on Changed Lines (MSCL) | pilot | ≥ 70% on core modules |
| Time-to-Verdict P50 | ≤ 8 min | ≤ 5 min |
| Impact recall | baseline | ≥ 98% |
| Triage accuracy | ≥ 80% | ≥ 90% |
| Mis-heal rate (C/D healed to green) | 0 | 0 |

## Phases

| Phase | Timebox | Version | Theme | Key work packages |
|---|---|---|---|---|
| R0 | 2–3 weeks | v4.1 | Trustworthy base | Governance lock and waiver approval; run ledger with result binding; MCP job runner (progress, cancel, async jobs, roots, session governance); correctness fixes (LCP/CLS/INP, WCAG 2.1 tags); safety hardening (default-deny explore, egress allowlist, request wrapping, redaction v2); adversarial test sets, claims registry, `@ts-check`; benchmark skeleton |
| R1 | 4–6 weeks | v4.2–4.3 | Agent-native verification loop | Core service layer with typed results; AST semantic diff guard with an assertion-strength lattice; flaky quarantine; triage v2 with traceparent injection; heal-session state machine; Code Map v2 lifecycle; MCP hub supply-chain locks; `aitest_verify_change` plus PR evidence (Job Summary, SARIF, attestation) |
| R2 | 6–10 weeks | v5.0 | Test adequacy and smart generation | Incremental mutation gate (Stryker) with ACH-style mutant-guided generation; Impact v2 (import graph, coverage map, history, recall); requirement traceability and oracle provenance; state-graph exploration with ARIA snapshots; base/head differential runs; OpenAPI contracts, property tests, perf v2; optional trace assertions |
| R3 | ongoing | v5.x | Metrics and ecosystem | Public benchmark scorecard; OTel GenAI telemetry and budgets; optional executors (Playwright MCP/CLI, visual agents); remote sandboxes; plugin SDK |

## Convergence Rules

- Phase exit gates are hard constraints.
- At most 3 work packages in progress at once.
- A "stop-doing" list rules out more MCP presets, a SaaS offering, natural-language execution, and an in-house browser agent.
- ADRs are required for breaking decisions.
- All public JSON is versioned by schema.
- Every claim must be bound to a test.
- Metrics are reviewed every two weeks.

See the Chinese version for full work-package designs, acceptance criteria, the metric dictionary, the risk register, and the two-week action list.
