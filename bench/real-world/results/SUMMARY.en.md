# Real-World Open-Source Commit Gate FPR Evaluation — Phase 1 Pilot Summary (`n = 50`)

> [中文版](./SUMMARY.md) · [Pre-Registered Protocol](../PREREGISTRATION.en.md) · [Raw Summary JSON](./summary.json) · [FGER-agentic Red-Team Design](../../agentic/DESIGN.en.md)

- **Evaluation Date**: `2026-11-24`
- **Gate Kernel Version**: `v5.1.0` (Offline static audit + TypeScript Compiler API full-file AST semantic diff guard `AITEST-G101..G115`)
- **Sampling Seed**: `mulberry32(seed = 20261124)` (pre-registered in [PREREGISTRATION.en.md](../PREREGISTRATION.en.md) and committed prior to data collection)
- **Isolation Guarantees**: Zero third-party source code committed, zero dependency installation, zero target code execution, zero network traffic to tested applications.
- **Formal Evaluation (`n >= 200`) Status**: **`pending`** (no extrapolation from this `n = 50` pilot).

---

## 1. Headline Metrics (Wilson 95% Confidence Intervals)

| Metric | Observed (`k / n`) | Rate | Wilson 95% CI | Notes |
|---|---:|---:|---|---|
| **Raw Gate Alert Rate** | `12 / 50` | **`24.0%`** | **`[14.3%, 37.4%]`** | Unfiltered offline gate red alerts across all 50 commits |
| **Adjudicated Gate FPR (Normal Commits)** | `10 / 48` | **`20.8%`** | **`[11.7%, 34.3%]`** | Denominator `n_normal = 50 - 2 TP = 48` normal evolution commits |
| **Adjudicated Gate FPR (All Commits `FP / n`)** | `10 / 50` | **`20.0%`** | **`[11.2%, 33.0%]`** | Conservative denominator across all 50 commits |
| **Audited True Positives (`TP`)** | `2 / 50` | **`4.0%`** | **`[1.1%, 13.5%]`** | Verified unwaived `test.skip` disabling 2 specs + new `waitForTimeout(100)` |
| **Passed Cleanly** | `38 / 50` | **`76.0%`** | **`[62.6%, 85.7%]`** | Normal test evolution passed with zero alerts |
| **Formal Evaluation (`n >= 200`)** | — | **`pending`** | — | Scheduled for Phase 2; no extrapolation |

---

## 2. Per-Repository Breakdown

| Repository | License | Sampled | Passed | Flagged | `FP` | `TP` | Unreviewed |
|---|---|---:|---:|---:|---:|---:|---:|
| `actualbudget/actual` | `MIT` | 10 | 9 | 1 | 1 | 0 | 0 |
| `microsoft/playwright-mcp` | `Apache-2.0` | 10 | 7 | 3 | 3 | 0 | 0 |
| `sveltejs/kit` | `MIT` | 10 | 5 | 5 | 4 | 1 | 0 |
| `vitejs/vite` | `MIT` | 10 | 9 | 1 | 1 | 0 | 0 |
| `vuejs/vitepress` | `MIT` | 10 | 8 | 2 | 1 | 1 | 0 |
| **Total** | **5 Repos** | **50** | **38** | **12** | **10** | **2** | **0** |

---

## 3. Triggered Rule Counts

| Rule Code | Flagged Commits | Summary |
|---|---:|---|
| `AITEST-G103` | 4 | Total S0–S5 strength drop (cross-file splits, `toBe`→`toBeFocused`, `toContainText`→`toBeHidden`) |
| `AITEST-G105` | 3 | `test.skip` (1 TP disabling existing tests, 1 condition rename refactor, 1 WebSocket runtime guard) |
| `AITEST-G107` | 3 | `try/catch` / `.catch(() => {})` (CSS animation settle in `page.evaluate`, negative-error assert, security test) |
| `AITEST-G110` | 3 | Conditional `expect` / early return (file-level `if (!isBuild) { test(...) }` and `if (process.env.DEV)` guards) |
| `AITEST-G102` | 2 | Single-file assertion count drop (both were cross-file splits moving tests into new spec files) |
| `AITEST-G114` | 1 | `route.fulfill()` used as a cross-origin honeypot trap in a security regression test |
| `STATIC-WAIT-FOR-TIMEOUT` | 1 | Newly introduced `page.waitForTimeout(100)` (`TP`) |

---

## 4. Per-Commit Adjudication Table (All 12 Flagged Commits)

| # | Repo & Commit | Rules | Label | Rationale |
|---:|---|---|---|---|
| 1 | `sveltejs/kit@3d5800fad6` | `AITEST-G107`, `AITEST-G110` | **`FP`** | Diagnostic catalog refactor (#17276); `if (process.env.DEV)` follows an unconditional length check, and negative `try/catch` asserts on expected error text. |
| 2 | `microsoft/playwright-mcp@2bf57e22c6` | `AITEST-G102`, `AITEST-G103` | **`FP`** | Cross-file split (#767): moved `browser_type` tests out of `tests/core.spec.ts` into new `tests/type.spec.ts`. |
| 3 | `vuejs/vitepress@bead1384b2` | `AITEST-G107` | **`FP`** | Un-skipped and strengthened 2 RTL tests; G107 fired on `try { animation.finish() } catch {}` inside `page.evaluate()`. |
| 4 | `microsoft/playwright-mcp@29711d07d3` | `AITEST-G102`, `AITEST-G103` | **`FP`** | Cross-file split (#716): moved Streamable HTTP coverage out of `tests/sse.spec.ts` into new 259-line `tests/http.spec.ts`. |
| 5 | `sveltejs/kit@9bc12d379f` | `AITEST-G105`, `AITEST-G110` | **`FP`** | Variant matrix refactor (#16845): rewrote pre-existing `test.skip(!process.env.*)` into `test.skip(variant !== ...)`. |
| 6 | `sveltejs/kit@224e791cb0` | `STATIC-WAIT-FOR-TIMEOUT` | **`TP`** | Introduced a brand-new hardcoded `await page.waitForTimeout(100)` sleep inside a new test. |
| 7 | `microsoft/playwright-mcp@b85dc6954a` | `AITEST-G105` | **`FP`** | New feature test (#979) guarded by runtime capability check `test.skip(!globalThis.WebSocket, ...)`. |
| 8 | `sveltejs/kit@dd63fd1a2e` | `AITEST-G107`, `AITEST-G114` | **`FP`** | Cross-origin security regression test using `page.route('**://attacker.example/**', ...)` as a honeypot trap and expecting `app.goto` rejection. |
| 9 | `vuejs/vitepress@44457ff2cc` | `AITEST-G105` | **`TP`** | Icon update PR (#5506) directly disabled two existing E2E specs with unwaived `test.skip(...)` (`// FIXME: flaky`). |
| 10 | `actualbudget/actual@a81408595c` | `AITEST-G103` | **`FP`** | UI migration (#8528): replaced legacy toast `toContainText` (S3) with modal `toBeHidden` (S2) while preserving the core S5 `toHaveText` outcome assertion. |
| 11 | `sveltejs/kit@30d06f5698` | `AITEST-G103` | **`FP`** | Idiomatic Playwright cleanup (#16992): replaced `page.evaluate(...activeElement.nodeName).toBe('BODY')` (S5) with `toBeFocused()` (S2). |
| 12 | `vitejs/vite@616296895b` | `AITEST-G110` | **`FP`** | New HMR regression test (#23171) inside file-level `if (!isBuild) { ... }` triggered G110 across the `test()` callback boundary. |

---

## 5. Reproduction Commands

```bash
# Install locked TypeScript AST compiler (required by fail-closed bench script)
cd templates/playwright-qa && npm ci --no-audit --no-fund && cd ../..

# CI smoke run (5 commits, 1 per repo, output written to gitignored .cache/smoke-results/)
node scripts/bench-real-world.mjs --smoke

# Full Phase 1 pilot run (50 commits, output written to bench/real-world/results/)
node scripts/bench-real-world.mjs
```
