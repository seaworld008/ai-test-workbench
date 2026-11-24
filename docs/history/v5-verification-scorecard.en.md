# AI Test Workbench v5.0 Verification & Benchmark Scorecard

> [简体中文 (默认)](./v5-verification-scorecard.md) · [Architecture Review (2026-11)](./v4-architecture-code-review-2026-11.en.md) · [Optimization Roadmap](./v5-optimization-roadmap-2026-2027.en.md) · [Raw Machine Scorecard](../../bench/scorecard.json)

This scorecard records the measured **before-and-after North-Star metrics** and **P0 closure matrix** after completing the `v5.0.0` deep optimization. Every number below is deterministically reproducible via `npm test`, `npm run demo:verify`, and `npm run bench`.

---

## 1. North-Star Metrics (`v4.0` Baseline vs `v5.0.0` Measured)

| Metric | `v4.0.0` Audit Baseline | `v5.0` Target | `v5.0.0` Measured Result | Evidence Source |
|---|---|---|---|---|
| **Fake-Green Escape Rate (`FGER`)** | `100%` (8/8 bypasses escaped) | `0%` | **`0.0%` (`26/26` cheating patches blocked)** | `test/adversarial/diff-bypasses.cases.json` + `bench/scorecard.json` |
| **Seeded-Defect Detection Rate (`SDDR`)** | Unmeasured | `>= 90%` | **`100.0%` (`7/7` real defects caught)** | `examples/demo-webapp/server.mjs` (`DEMO_DEFECT`) + `npm run bench` |
| **Triage Classification Accuracy** | Misclassified 5xx, blocked origins, and text mismatches as Class D | `>= 95%` | **`100.0%` (`45/45` corpus cases exact)** | `test/adversarial/triage.cases.json` |
| **Secret Redaction Recall** | Leaked JSON `"password"` and JWTs | `100%` | **`100.0%` (`35/35` secret patterns scrubbed)** | `test/adversarial/redaction.cases.json` |
| **Mis-Heal Rate** | Prompt-only soft advice | `0%` | **`0.0%` (Class B/C/D hard-blocked by state machine)** | `src/heal.mjs` + `test/integration/governance-and-ledger.test.mjs` |
| **CDP Web Vitals (`LCP / CLS / INP`)** | `LCP` always `null`, `CLS` always `0` | Real non-null capture | **Live `LCP = 16–20ms`, real `CLS` & `INP`** | `src/perf.mjs` (`PerformanceObserver`) + `test/integration/perf.test.mjs` |

---

## 2. Closure Matrix for All 10 P0 Review Findings (`F-01` .. `F-10`)

| ID | Review Finding | `v5.0.0` Engineering Remediation | Automated Test |
|---|---|---|---|
| **F-01** | Healer Diff Guard bypassed by 8 weakening patterns and ignored files outside `tests/` | Implemented `S0–S5` Assertion Strength Lattice + `AITEST-G101..G113` full-workspace semantic diff guard (including untracked files & configs) | `test/adversarial/diff-and-redaction.test.mjs` (20) + `bench` (26) |
| **F-02** | Protected configs & `waivers.json` editable by agents | Added `.aitest/governance.lock` (SHA-256 across 11 protected files), human-only CLI `governance approve`, and strict waiver caps/TTL | `test/integration/governance-and-ledger.test.mjs` |
| **F-03** | `aitest_audit` accepted unbound stale `results.json` | Added `src/ledger.mjs` (ULID `runId` + workspace input hash binding); code/spec edits invalidate stale runs | `test/integration/governance-and-ledger.test.mjs` |
| **F-04** | `LCP` always `null`, `CLS` always `0`; missing WCAG 2.1 tags | Switched to pre-injected buffered `PerformanceObserver` with median/P75 aggregation; added `wcag21a` & `wcag21aa` | `test/integration/perf.test.mjs` + `base.ts` |
| **F-05** | `explore` allowed POST by default and whitelisted `/graphql` | Default-denied all non-`GET/HEAD/OPTIONS` requests in `explore`, blocked `sendBeacon`, removed `/graphql` from safe writes, and blocked GraphQL `mutation` payloads | `test/unit/origin-guard.test.mjs` + `src/explore.mjs` |
| **F-06** | Blacklist-only egress and unguarded `page.request` / `context.request` | Added `TEST_EGRESS_MODE=allowlist`, wrapped `context.request`, `page.request`, and `context.route` in `base.ts`, and banned raw `request.newContext()` in ESLint | `templates/playwright-qa/tests/fixtures/base.ts` |
| **F-07** | JSON `"password"` and JWTs escaped redaction; `@latest` MCP presets | Upgraded `redactSecrets` v2 (35/35 corpus); pinned all external MCP versions and replaced archived Postgres server with `@bytebase/dbhub@0.15.0 --readonly` | `test/adversarial/diff-and-redaction.test.mjs` + `test/unit/mcp-hub.test.mjs` |
| **F-08** | Single global MCP lock + `globalThis.console` hijacking | Added `src/jobs.mjs` isolated child-process runner with zero console mutation, concurrent read tools, and per-workspace write locks | `test/integration/mcp-jobs.test.mjs` + `test/integration/mcp-server.test.mjs` |
| **F-09** | Missing progress notifications, tree cancellation, and HTTP session strictness | Added `_meta.progressToken` heartbeats, `notifications/cancelled` process-tree kill, `syncBudgetMs` async jobs, and strict `initialize` / `404` / TTL / `timingSafeEqual` HTTP handling | `test/integration/mcp-jobs.test.mjs` + `test/integration/mcp-server.test.mjs` |
| **F-10** | Triage misclassification; CodeMap route collapse, stale entries & defect inflation | Structured guard telemetry precedes regex triage (45/45); CodeMap v4 preserves `:id`/`[id]`, prunes deleted routes, and converges defects; Impact v2 adds static reverse `import` graph | `test/unit/codemap.test.mjs` + `test/unit/impact.test.mjs` |

---

## 3. Seeded-Defect Benchmark Breakdown (`npm run bench`)

1. `500_courses`: `GET /api/courses` returns `HTTP 500` → Caught by `api` suite & classified as Class C.
2. `schema_drift`: `seatsLeft` drifts from `integer` to `string` → Caught by zero-dep JSON Schema contract validator (`support/schema-validator.mjs`).
3. `rbac_leak`: Student token receives `200` on `/api/admin/audit` → Caught by `[REQ-RBAC-001]` RBAC contract spec.
4. `duplicate_enroll`: Duplicate enrollment returns `201` instead of `409` → Caught by `[REQ-ENROLL-001]` idempotency & concurrency spec.
5. `soldout_enabled`: Sold-out course leaves enrollment button enabled → Caught by `[REQ-CATALOG-001]` E2E state assertion.
6. `uncaught_pageerror`: Uncaught frontend `Error` → Caught by `base.ts` runtime error gate.
7. `a11y_missing_label`: Search input lacks accessible label → Caught by `expectAccessible` (WCAG 2.0/2.1/2.2 AA).

---

## 4. Verification Scope Honesty

- Results in this scorecard constitute **Local Workbench & Built-In Full-Stack Target Verified (`local-workbench` & `demo-webapp`)**.
- Adopting repositories must still execute `aitest verify-change --base origin/main` against their non-production staging target to achieve **Business E2E Verified (`business-e2e`)**.
