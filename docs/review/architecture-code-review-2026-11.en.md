# ai-test-workbench v4.0 Architecture & Code Review (English Summary)

> [简体中文完整版](./architecture-code-review-2026-11.md) · [Optimization Roadmap](./optimization-roadmap-2026-2027.en.md) · [README](../../README.en.md)
>
> Review date: 2026-11-23 · Baseline: `main@e43e107` (v4.0.0). This is a **static review plus local workbench verification**. It is not a business E2E acceptance.

## Verdict

The positioning is right: an independent, governable verification layer for AI coding agents, built around anti-fake-green gates and A/B/C/D healer governance. The implementation is weaker than the positioning. Gates are line-level regexes, and governance rules live mostly in prompts. Several gates can produce false greens themselves.

## Scorecard (out of 5)

| Dimension | Score |
|---|---:|
| Positioning & vision fit | 4.5 |
| Architecture layering | 2.5 |
| MCP protocol & agent UX | 2.5 |
| Anti-fake-green gate effectiveness | 2.0 |
| Safety boundaries | 3.0 |
| Intelligence (explore/map/impact/diagnose) | 2.5 |
| Perf / a11y / contract | 2.0 |
| Engineering quality | 3.0 |
| Docs vs. claims | 3.0 |

## Top Findings

| ID | Finding | Severity | Evidence |
|---|---|---|---|
| F-01 | The healer diff guard is bypassable. All 8 weakening patterns tested passed (assertion weakening, tautologies, `test.fail`, `.catch(() => null)`, retries, `expect.soft`, config `testIgnore`, disabling ESLint rules). The guard only diffs `tests/`. | P0 | Verified |
| F-02 | Governance files (`eslint.config.mjs`, `playwright.config.ts`, `aitest.config.json`, `waivers.json`) have no hash lock or approval. Agents can rewrite them or self-approve waivers. | P0 | Static |
| F-03 | `results.json` is not bound to a run. A stale green result can pass `aitest_audit`. | P0 | Static |
| F-04 | LCP is always `null` and CLS is always `0`, because `getEntriesByType` cannot read those entries. A `PerformanceObserver` is required. | P0 | Verified |
| F-05 | The explore firewall allows POST by default, and `/graphql` is a default safe-write path. | P0 | Static |
| F-06 | Egress control is a denylist, not an allowlist. `page.request` and `context.request` bypass the guarded `request` proxy. | P0 | Static |
| F-07 | Redaction misses JSON `"password":"…"` pairs and JWTs. | P0 | Verified |
| F-08 | The MCP execution model parses stdout, serializes all calls behind a global mutex, and has no progress, cancellation, or timeout handling. Long runs hit client timeouts. | P0 | Static |
| F-09 | MCP `target` can be any path. HTTP sessions skip initialize validation and never expire. | P1 | Static |
| F-10 | The triage classifier labels the 5xx guard, network guard, and `toHaveText` mismatches as class D. | P1 | Verified |

Other notable issues:

- axe scans omit the `wcag21a` and `wcag21aa` tags.
- The Living Code Map never closes defects, inflates `seenCount` on every run, and drops dynamic routes.
- Impact selection has no dependency graph or coverage map.
- Tool annotations misreport side effects.
- Third-party MCP presets are unpinned.
- Versions are hard-coded in several places, and there is no type checking.

## Recommendations

1. Fix the gates before adding intelligence.
2. Move governance from prompts into enforced tooling: a policy engine, heal sessions, and protected files.
3. Build a seeded-bug benchmark early, so the fake-green escape rate and defect detection rate drive every later phase.

See the [roadmap](./optimization-roadmap-2026-2027.en.md) for phased work packages.
