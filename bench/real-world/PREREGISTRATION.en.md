# Pre-Registered Protocol: Real-World Open-Source Commit Gate FPR Evaluation (Phase 1 Pilot)

> [中文版](./PREREGISTRATION.md) · [4-Layer Anti-Fake-Green Governance](../../docs/governance.en.md) · [Main README](../../README.en.md)

- **Protocol Version**: `1.0.0`
- **Pre-Registration Date**: `2026-11-24`
- **System Under Evaluation**: `ai-test-workbench@5.1.0` 4-layer anti-fake-green gate kernel (offline static audit + TypeScript AST full-file semantic diff guard `AITEST-G101..G115`)
- **Pre-Registration Commitment**: This document is authored and committed to Git history **before** collecting any GitHub commits or generating `bench/real-world/corpus.json`. Repository eligibility, commit exclusion rules, PRNG sampling seed, and false-positive adjudication criteria are frozen prior to data collection; samples may never be silently dropped post-hoc to improve metrics.

---

## 1. Objective and Phased Scope

Synthetic internal regression benchmarks (`bench/scorecard.json`) verify gate behavior on known test cases, but cannot establish the false positive rate (FPR) of the gate on real-world Playwright test maintenance commits.

This benchmark proceeds in two explicit phases:

1. **Phase 1 — Real-World Pilot (This Phase)**: Target sample size **`n >= 50`** real open-source commits (minimum floor **`n = 30`** if constrained by network or time). Report the exact observed `n`, per-commit adjudication notes for every flagged commit, and the Wilson 95% confidence interval.
2. **Phase 2 — Formal Evaluation (`pending`)**: Expand to **`n >= 200`** commits across broader domains and repositories. Explicitly labeled `pending` in README; **extrapolating Phase 1 pilot numbers to Phase 2 is strictly prohibited**.

---

## 2. Repository Eligibility Criteria

Candidate repositories must satisfy all of the following objective criteria:

1. **Real Playwright Test Suite**: Public GitHub open-source repository containing real Playwright test files (`*.spec.ts`, `*.spec.js`, `*.test.ts`, `*.e2e.ts`, etc. using `@playwright/test`).
2. **Permissive License**: Top-level SPDX license is one of `MIT`, `Apache-2.0`, `BSD-2-Clause`, `BSD-3-Clause`, or `ISC`.
3. **Recent Activity**: Active commits within the **last 24 months** prior to `2026-11-24`. Exclude archived repositories, forks, and read-only mirrors.
4. **Multi-Repository Diversity**: Corpus spans at least **4 distinct repositories** with balanced per-repo quotas to prevent a single codebase style from dominating results.
5. **No Third-Party Code Committed**: `bench/real-world/corpus.json` stores **metadata only** (`{ repo, sha, parentSha, license, testPaths }`). Third-party source code is never committed into this repository; evaluation runs shallow-fetch target objects into the gitignored `bench/real-world/.cache/` directory.

---

## 3. Commit Exclusion Rules

Candidate commits from eligible repositories are filtered strictly by the following mechanical rules prior to running the gate:

1. **Merge & Root Commits**: Exclude merge commits (`parents.length !== 1`) and root commits lacking a parent so every sample has a single unambiguous `parentSha -> sha` diff pair.
2. **Non-Modification File Changes**: Exclude commits that only add (`A`) or only delete (`D`) entire test files; require at least one modified Playwright test file (`M` or rename-modify `R`) present in both `parentSha` and `sha`.
3. **Bulk Mechanical Churn**: Exclude commits modifying `> 50` total files (repo-wide formatting sweeps, mass renames, dependency bumps, or automated codemods).
4. **Non-Target Files**: Evaluate only Playwright `.ts`/`.tsx`/`.js`/`.mjs` test files; exclude non-Playwright unit tests, snapshots, and binary assets.
5. **No Silent Removal**: Once a commit enters `corpus.json` via deterministic sampling, it must not be silently removed if it triggers an alert. Any edge case discovered during manual review must be recorded transparently in the results JSON.

---

## 4. Deterministic Sampling Protocol

- **PRNG**: 32-bit `mulberry32` deterministic pseudorandom generator.
- **Locked Pre-Registered Seed**: **`seed = 20261124`**.
- **Procedure**:
  1. Collect eligible recent commits from each selected repository's default branch.
  2. Sort candidates canonically by `repo + ":" + sha` to eliminate API ordering drift.
  3. Shuffle each repository's candidate pool deterministically with `mulberry32(20261124)` and draw commits via round-robin / balanced per-repo quotas up to the target sample size (`n = 50` target, `n >= 30` minimum floor).
  4. Persist only metadata into `bench/real-world/corpus.json` along with the sampling seed and per-repo counts.

---

## 5. Isolated Offline Gate Execution Protocol

- **Strict Isolation**: `scripts/bench-real-world.mjs` MUST NOT install target repository dependencies, MUST NOT execute target repository code or build scripts, and MUST NOT send any network traffic to tested applications. Network access is restricted strictly to read-only Git object fetching into the gitignored `.cache/` directory.
- **Evaluated Gate Scope**: For each `testPath` in a commit, extract `parentSha:<path>` and `sha:<path>` from Git and invoke the repository's real gate kernel (`templates/playwright-qa/support/gate/ast-analyzer.mjs`):
  1. **Layer 3 Full-File TypeScript AST Semantic Diff Guard**: `compareSpecSourcesAst(testPath, baseSource, headSource)` across `AITEST-G101..G115` (net assertion reduction, S0–S5 assertion strength downgrade, `.not` flip, newly introduced `skip`/`fixme`/`only`/`fail`, `{ force: true }`, swallowed `catch`, excessive timeouts, self-referential oracles, S0 tautologies, `page.route(...fulfill)` fake mocks, locator degradation, 5xx oracle flips, critical tag removal).
  2. **Differential Layer 2 Static Anti-Pattern Check**: Newly introduced hardcoded `waitForTimeout()` or raw `request.newContext()` added in `sha` compared to `parentSha` (pre-existing legacy patterns untouched by the commit are not blamed on the commit).
  3. **Scope Transparency**: Layer 0 (`.aitest/governance.lock`) and Layer 1 (`Run Ledger`) require local workbench initialization and test execution, so external historical commits are evaluated in `offline-static-ast-only` mode without fabricating runtime verdicts.

---

## 6. Operational Definition of False Positive (`FP`)

Every commit flagged red (`flagged === true`) is manually reviewed against its real `git show <sha>` diff and classified into one of two categories:

| Label | Operational Definition | Representative Examples |
|---|---|---|
| **False Positive (`FP`)** | The gate flagged red, yet manual inspection determines the commit is **legitimate test or product evolution** rather than test weakening or defect masking. | Extracting repeated `expect(...)` calls into an external helper/Page Object causing a single-file count drop; removing tests for deprecated features; refactoring equivalent assertions into custom matchers. |
| **True Positive (`TP`)** | The gate flagged red, and manual inspection confirms the commit **genuinely introduced a gated anti-pattern** that an AI Agent governance gate is designed to block or require human approval for. | Adding unwaived `test.skip()` / `test.fixme()` / `test.only()`; adding `{ force: true }`; introducing hardcoded `waitForTimeout(...)`; swallowing exceptions in `.catch(() => {})`; deleting or weakening assertions to bypass failure. |

**Mandatory Dual Reporting**: Results and README MUST report both:
- **Adjudicated Gate FPR**: `FP / n_normal` (where `n_normal = n - TP`, plus `FP / n`), and
- **Raw Gate Alert Rate**: `flagged / n`,
alongside per-commit details (`repo`, `sha`, rule codes, `FP`/`TP` label, and written rationale) for every flagged commit.

---

## 7. Statistical Method (Wilson 95% Confidence Interval)

For any observed binomial proportion $(k, n)$, compute the **Wilson Score 95% Confidence Interval** (two-sided $\alpha = 0.05$, $z = 1.959964$):

$$\hat{p} = \frac{k}{n}, \quad \text{CI}_{95\%} = \left[ \frac{\hat{p} + \frac{z^2}{2n} - z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}},\; \frac{\hat{p} + \frac{z^2}{2n} + z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}} \right]$$

- Even when $k = 0$, the Wilson score interval produces a strict non-zero upper bound (e.g., $n = 50, k = 0 \Rightarrow [0.0\%, 7.1\%]$), avoiding misleading Wald `0% ± 0%` claims.
- Phase 1 pilot intervals are reported strictly for the observed `n`; the formal `n >= 200` evaluation remains explicitly `pending`.
