# 全链路 Trace-ID 根因定位与性能 SLO 评测提示词 (`full-link-rca-and-perf.md`)

> [English Version](./full-link-rca-and-perf.en.md) · [全链路 MCP 参考](../skills/ai-test-workbench/references/full-link-mcp-and-codemap.md)

请在 `<repo>/qa/` 内结合 `knowledge/SYSTEM_MAP.md`、`reports/ai-diagnostics.md` 与已接入的只读系统 MCP（`grafana`、`prometheus`、`loki`、`sentry`、`postgres-readonly`/`mysql-readonly`、`redis-readonly`、`k6`）排查故障或评估性能：

## 标准工作流
1. 读取 `knowledge/SYSTEM_MAP.md`（或 MCP Resource `system-map`），定位失败路由对应的前端组件 → API 接口 → 后端 Controller → 数据库实体表。
2. 调用 `aitest_diagnose`（或查阅 `reports/ai-diagnostics.md`）获取脱敏 Playwright `error-context.md`、捕获到的分布式 `traceIds` 及精确时间窗 `[startedAt, finishedAt]`。
3. **严格只读**调用系统 MCP 联动排查：
   - **Loki / Grafana MCP**：按 `{env=~"staging|test"} |= "<traceId>"` 在故障时间窗检索后端链路日志；
   - **Sentry MCP**：查看同时间窗内未解决的前后端异常堆栈；
   - **Prometheus / `aitest_perf`**：执行 `npx ai-test-workbench@5.1.1 perf --target . --routes <route> --concurrency 4 --iterations 12 --enforce-budget`，检查 TTFB/LCP/CLS、重复请求瀑布、接口 P95 与连接池水位；
   - **PostgreSQL / MySQL / Redis MCP**：仅用 `SELECT` / `GET` 验证业务状态是否一致（**严禁** `INSERT`、`UPDATE`、`DELETE`、`FLUSH`）。
4. 明确归类 **A / B / C / D**：仅允许对 A 类定位器问题执行最多 3 轮修复，修完跑 `npx ai-test-workbench@5.1.1 run --suite all --audit` 与 `npx ai-test-workbench@5.1.1 map` 更新活体知识地图。
