# Real-World Open-Source Gate FPR — v6 Blind Unseen Holdout Before/After Summary

> [简体中文版本](./SUMMARY-v6-holdout.md) · [Preregistration Protocol](../PREREGISTRATION.en.md) · [Pilot Baseline Summary](./SUMMARY.en.md) · [v6 Refactor Assessment](../../../docs/review/v6-refactor-assessment.en.md)

- **Evaluation Date**: `2026-11-24`
- **Blind Holdout Discipline**: To prevent overfitting to the pilot corpus (`seed = 20261124`), we sampled **`50` strictly disjoint unseen commits** (`holdout-v6-corpus.json`) across all 5 open-source repositories using fresh deterministic seed **`seed = 20261125`** under [PREREGISTRATION.en.md](../PREREGISTRATION.en.md). All 5 systemic false-positive improvements were designed exclusively from the pilot root causes and evaluated blind (BEFORE vs AFTER) on the unseen holdout set with **zero post-hoc holdout tuning**.

---

## 1. Verified Before vs After Metrics (`VERIFIED`)

| Dataset | Rule Stage | Sample Size `n` | Raw Alert Rate (Wilson 95% CI) | Adjudicated FPR `FP / n_normal` (Wilson 95% CI) | TP Recall |
|---|---|---:|---|---|---:|
| **Unseen Holdout (`seed=20261125`, blind)** | BEFORE (`v5.1.1`) | 50 (`n_normal=49`) | `14.0%` (`7/50`, `[7.0%, 26.2%]`) | **`12.2%` (`6/49`, `[5.7%, 24.2%]`)** | `1/1 (100%)` |
| **Unseen Holdout (`seed=20261125`, blind)** | **AFTER (`v6` rules)** | 50 (`n_normal=49`) | `8.0%` (`4/50`, `[3.2%, 18.8%]`) | **`6.1%` (`3/49`, `[2.1%, 16.5%]`)** | **`1/1 (100%)`** |
| **Pilot Set (`seed=20261124`)** | BEFORE (`v5.1.1`) | 50 (`n_normal=48`) | `24.0%` (`12/50`, `[14.3%, 37.4%]`) | **`20.8%` (`10/48`, `[11.7%, 34.3%]`)** | `2/2 (100%)` |
| **Pilot Set (`seed=20261124`)** | **AFTER (`v6` rules)** | 50 (`n_normal=48`) | `8.0%` (`4/50`, `[3.2%, 18.8%]`) | **`4.2%` (`2/48`, `[1.2%, 14.0%]`)** | **`2/2 (100%)`** |
| **Combined 100-Commit Corpus** | BEFORE (`v5.1.1`) | 100 (`n_normal=97`) | `19.0%` (`19/100`, `[12.5%, 27.8%]`) | **`16.5%` (`16/97`, `[10.4%, 25.1%]`)** | `3/3 (100%)` |
| **Combined 100-Commit Corpus** | **AFTER (`v6` rules)** | 100 (`n_normal=97`) | `8.0%` (`8/100`, `[4.1%, 15.0%]`) | **`5.2%` (`5/97`, `[2.2%, 11.5%]`)** | **`3/3 (100%)`** |

---

## 2. Anti-Fake-Green Regression Verification (`npm run bench` · `VERIFIED`)

None of the 5 systemic FP reductions weakened adversarial cheat detection:

- `FGER-int = 0.0%` (`26/26` internal adversarial cheats blocked)
- `FGER-holdout = 0.0%` (`24/24` independent red-team holdout cheats blocked)
- `SDDR = 100.0%` (`7/7` S0 tautology/self-referential classifier probes detected)
- `Gate-FPR (internal) = 0.0%` (`12/12` internal benign refactors allowed)
- `Triage = 100.0%` · `RealStacks = 100.0% (C->A = 0.0%)` · `Redaction = 100.0%` · `MisHeal = 0.0%`

---

## 3. Holdout Adjudication Breakdown & Honest Remaining Gap Disclosure

Full rationale recorded in [holdout-v6-adjudications.json](../holdout-v6-adjudications.json):

| Commit | Label | BEFORE Rule(s) | AFTER Status | Summary |
|---|---|---|---|---|
| `vitejs/vite@278dc804` | `FP` | `AITEST-G110` | **Resolved (PASS)** | Un-skipped test inside file-level `if (!isBuild) { test(...) }` (`#23082`); resolved by lexical scope tracking |
| `vitejs/vite@16944824` | `FP` | `AITEST-G110` | **Resolved (PASS)** | Upgraded to `expect.poll()` inside file-level `if (!isBuild)` (`#23186`); resolved by lexical scope tracking |
| `microsoft/playwright-mcp@601a7430` | `FP` | `G102/G103/G105` | **Resolved (PASS)** | Typed response refactor (`#738`); resolved by changeset pooling + per-scope existing skip delta |
| `actualbudget/actual@935d2b50` | **`TP`** | `STATIC-WAIT-FOR-TIMEOUT` | **Retained (TP)** | AI-authored PR (`#8759`) added hardcoded `page.waitForTimeout(700)`, matching pre-registered TP criteria |
| `sveltejs/kit@ccbbea64` | `FP` | `G102/G103` | Flagged (residual FP) | Deflake refactor (`#16631`) in a 436-assertion file reduced count by 1 (`436 -> 435`) |
| `microsoft/playwright-mcp@4df162af` | `FP` | `G102/G103` | Flagged (residual FP) | Consolidated multi-assertion `toHaveTextContent` checks into custom `.toHaveResponse({...})` across 21 specs (`#796`) |
| `actualbudget/actual@b396629f` | `FP` | `AITEST-G110` | Flagged (residual FP) | Strengthened an existing `expect(request.postDataJSON()).toEqual(...)` inside a pre-existing `if (request.method() === 'POST')` handler (`#9486`); snippet-text diff treated the edited assertion as new |

> **Honest Scope Note**: Blind unseen-holdout Adjudicated FPR dropped from `12.2%` to **`6.1%`** (combined 100 commits: `16.5%` -> **`5.2%`**), cutting false positives in half on unseen commits and by 80% on the pilot set while keeping `0.0%` FGER and `100%` TP recall. Because we refuse to tune rules on the holdout set, the 3 residual unseen FPs are documented transparently as `v6.1` engineering targets rather than hidden via overfitting.
