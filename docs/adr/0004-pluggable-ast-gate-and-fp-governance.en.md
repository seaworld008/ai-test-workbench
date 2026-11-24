# ADR-0004: Pluggable AST Gate Rule Engine & Changeset/Scope-Aware False-Positive Governance

> [简体中文 (默认)](./0004-pluggable-ast-gate-and-fp-governance.md) · [English README](../../README.en.md) · [Governance Guide](../governance.en.md)

- **Status**: Accepted (Implemented in `v6.0.0`)
- **Date**: `2026-11-24`

---

## 1. Context & Problem Statement

In `v5.1.1`, Layer 3 lived inside a monolithic `1,649`-line `ast-analyzer.mjs` where all `AITEST-G101..G115` rules were entangled in one function without lexical scope tracking or commit-level changeset visibility. Across 50 real-world commits from 5 open-source repositories, false-positive rate measured `20.8%` (`10/48`, Wilson 95% CI `[11.7%, 34.3%]`).

---

## 2. Architecture & False-Positive Governance Design

1. **Modular Rule Engine (`src/kernel/gate/`)**:
   - Split into `ts-loader.mjs`, `constant-eval.mjs`, `lattice.mjs`, `parser-inspectors.mjs`, `parser.mjs`, `diff-parser.mjs`, `changeset.mjs`, `static-runner.mjs`, and 4 rule modules (`rules/{governance,assertion,control-flow,locator-and-oracle}-rules.mjs` + `rules/index.mjs`), each `<= 600` lines.
   - Each rule emits structured `GateFinding` records and supports `aitest.config.json#rules` overrides (protected by `governance.lock`, requiring human `governance approve`).
2. **Five Systemic FP Fixes (Zero Anti-Cheat Regression)**:
   - **Commit-level cross-file test pooling (`G102/G103`)**: `compareChangesetAst` correlates split/moved tests across sibling spec files in the same commit.
   - **Explicit lexical scope stack (`G107/G110`)**: Distinguishes `top-level`, `describe`, `hook`, `test`, and `browser-evaluate` (`page.evaluate`/`locator.evaluate`), excluding file-level `if (!isBuild) { test(...) }`, browser-side `try/catch`, and negative error-assert `try/catch`.
   - **Structural skip count delta & runtime capability guards (`G105`)**: Counts net new skips per scope and allows narrow runtime capability guards (`globalThis.WebSocket`) without relaxing arbitrary `process.env` gating.
   - **Calibrated Web-First lattice (`G103`)**: Places `toBeFocused`, `toBeDisabled`, `toBeHidden`, `toBeChecked`, and DOM `evaluate` probes appropriately at `S3`.
   - **Fault-injection & honeypot awareness (`G114`)**: Recognizes `route.fulfill({ status >= 400 })` fault-injection tests and security honeypot traps while keeping `2xx` fake-success interception hard-blocked.

---

## 3. Blind Unseen Holdout Evaluation

Before modifying any rule, `50` strictly disjoint unseen commits (`seed = 20261125`, `0` overlap with the pilot corpus) were sampled into `bench/real-world/holdout-v6-corpus.json`. Zero post-hoc tuning was performed on holdout diffs:

| Corpus | BEFORE FPR (Wilson 95% CI) | AFTER FPR (Wilson 95% CI) | True Positives Retained |
|---|---:|---:|---:|
| **Unseen Holdout (`n=50`, `n_normal=49`)** | `12.2% (6/49)` `[5.7%, 24.2%]` | **`6.1% (3/49)` `[2.1%, 16.5%]`** | `1/1` |
| **Pilot (`n=50`, `n_normal=48`)** | `20.8% (10/48)` `[11.7%, 34.3%]` | **`4.2% (2/48)` `[1.2%, 14.0%]`** | `2/2` |
| **Combined (`n=100`, `n_normal=97`)** | `16.5% (16/97)` `[10.4%, 25.1%]` | **`5.2% (5/97)` `[2.2%, 11.5%]`** | `3/3` |

Anti-cheat regressions remained strictly zero: `FGER-int = 0.0% (26/26)`, `FGER-holdout = 0.0% (24/24)`, `Gate-FPR(internal) = 0.0% (12/12)`.

---

## 4. Known Residual FPs & Boundaries

The remaining 3 unseen-holdout FPs involve deeper cross-module helper abstractions whose exact resolution would require full `ts.createProgram` type resolution across target `node_modules`, which remains explicitly out of scope for offline single-commit AST analysis.
