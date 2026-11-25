# Full-Link Root-Cause Analysis & Performance Verification Prompt

> [简体中文 (默认)](./full-link-rca-and-perf.md) · [Full-Link MCP Reference](../skills/ai-test-workbench/references/full-link-mcp-and-codemap.md)

Use inside `<repo>/qa/` when investigating failures with `knowledge/SYSTEM_MAP.md`, `reports/ai-diagnostics.md`, and connected Read-Only System MCPs (`grafana`, `prometheus`, `loki`, `sentry`, `postgres-readonly` / `mysql-readonly`, `redis-readonly`, `k6`).

## Workflow
1. Read `knowledge/SYSTEM_MAP.md` to map failing route -> frontend component -> API path -> backend controller -> DB table.
2. Inspect `reports/ai-diagnostics.md` for redacted Playwright `error-context.md`, distributed `traceIds`, and exact `[startedAt, finishedAt]` time window.
3. Query System MCPs strictly in **read-only mode**:
   - **Loki / Grafana**: Search `{env=~"staging|test"} |= "<traceId>"` across the failure window.
   - **Sentry**: Inspect matching unresolved exceptions / breadcrumbs in the time window.
   - **Prometheus / Perf**: Run `npx ai-test-workbench@6.2.1 perf --target . --routes <route> --concurrency 4 --iterations 12 --enforce-budget` and check P95 latency, DB pool saturation, and JS Heap / DOM size.
   - **PostgreSQL / MySQL / Redis MCP**: Run read-only `SELECT` / `GET` checks confirming backend or cache state (NEVER execute `INSERT`, `UPDATE`, `DELETE`, `FLUSH`).
4. Classify definitively into **A / B / C / D**, apply minimal fix (up to 3 attempts for Class A only), and run `npx ai-test-workbench@6.2.1 run --suite all --audit` + `npx ai-test-workbench@6.2.1 map` so the Living Code Map records the resolved state.
