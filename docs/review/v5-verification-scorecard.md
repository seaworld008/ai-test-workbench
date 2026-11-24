# AI Test Workbench v5.0 深度优化验收评分卡 (`Scorecard`)

> [English Version](./v5-verification-scorecard.en.md) · [审查报告 (2026-11)](./architecture-code-review-2026-11.md) · [优化路线图](./optimization-roadmap-2026-2027.md) · [机器基准原始数据](../../bench/scorecard.json)

本文档记录基于《架构与代码审查报告》与《分阶段优化路线图》完成 `v5.0.0` 全量深度重构后的**实测北极星指标对比**与**全项闭环核验清单**。所有数据均可通过仓库内置命令 `npm test`、`npm run demo:verify` 与 `npm run bench` 在本机确定性复现。

---

## 1. 北极星指标前后实测对比 (`v4.0` 审查基线 vs `v5.0.0` 实测)

| 北极星指标 | `v4.0.0` 审查实测值 | `v5.0` 目标阈值 | `v5.0.0` 本机实测值 | 验证数据源 |
|---|---|---|---|---|
| **假绿逃逸率 (`FGER`)** | `100%`（8/8 构造绕过全部放行） | `0%` | **`0.0%`（26/26 作弊补丁全部拦截）** | `test/adversarial/diff-bypasses.cases.json` + `bench/scorecard.json` |
| **种子缺陷检出率 (`SDDR`)** | 未自动化量化 | `>= 90%` | **`100.0%`（7/7 真实缺陷全检出）** | `examples/demo-webapp/server.mjs` (`DEMO_DEFECT`) + `npm run bench` |
| **诊断分类准确率 (`Triage Accuracy`)** | 存在 5xx/网络拦截/文案断言误判为 D 类 | `>= 95%` | **`100.0%`（45/45 语料全对）** | `test/adversarial/triage.cases.json` |
| **凭据脱敏召回率 (`Redaction Recall`)** | 漏放 JSON `"password"` 与 JWT | `100%` | **`100.0%`（35/35 凭据零泄露）** | `test/adversarial/redaction.cases.json` |
| **误修率 (`Mis-Heal Rate`)** | 仅靠提示词软约束 | `0%` | **`0.0%`（B/C/D 类由状态机硬阻断改测试）** | `src/heal.mjs` + `test/governance-and-ledger.test.mjs` |
| **CDP Web Vitals `LCP / CLS / INP`** | `LCP` 恒为 `null`、`CLS` 恒为 `0` | 真实非空测量 | **实测 `LCP = 16~20ms`、`CLS` / `INP` 实时采集** | `src/perf.mjs` (`PerformanceObserver`) + `test/perf.test.mjs` |

---

## 2. 10 大 P0 审查问题闭环矩阵 (`F-01` .. `F-10`)

| 编号 | 审查发现问题 | `v5.0.0` 根治方案与落点模块 | 验证测试 |
|---|---|---|---|
| **F-01** | Healer Diff 守卫被 8 种常见弱化改法绕过且不看 `tests/` 之外 | 落地 `S0–S5` 断言强度格 + `AITEST-G101..G113` 全目录语义守卫（含未跟踪文件与配置） | `test/adversarial.test.mjs` (20 例) + `bench` (26 例) |
| **F-02** | 治理配置与 `waivers.json` 可被 Agent 自行篡改或自签豁免 | 新增 `.aitest/governance.lock`（11 项受保护文件 SHA-256）+ 人类专属 CLI `governance approve` + 严格豁免上限/TTL | `test/governance-and-ledger.test.mjs` |
| **F-03** | `aitest_audit` 读取未绑定的陈旧 `results.json` | 新增 `src/ledger.mjs`（ULID `runId` + 输入源码指纹绑定），代码或用例变动后旧结果立即失效 | `test/governance-and-ledger.test.mjs` |
| **F-04** | `LCP` 恒为 `null`、`CLS` 恒为 `0`；缺少 WCAG 2.1 标签 | 改用预注入 `PerformanceObserver({ buffered: true })` + 多样本中位数/P75；补齐 `wcag21a` / `wcag21aa` | `test/perf.test.mjs` + `base.ts` |
| **F-05** | `explore` 默认放行 POST，且 `/graphql` 在默认安全写白名单 | `explore` 默认拒绝一切非 `GET/HEAD/OPTIONS` 请求并封禁 `sendBeacon`；移除 `/graphql` 白名单并拦截 GraphQL `mutation` | `test/origin-guard.test.mjs` + `src/explore.mjs` |
| **F-06** | 出站仅有黑名单，且 `page.request` / `context.request` 绕过守卫 | 支持 `TEST_EGRESS_MODE=allowlist`；在 `base.ts` 统一代理 `context.request`、`page.request` 与 `context.route`，ESLint 禁裸调 `request.newContext()` | `templates/playwright-qa/tests/fixtures/base.ts` |
| **F-07** | JSON `"password"` 与 JWT 逃逸脱敏；外部 MCP 预设用 `@latest` | 升级 `redactSecrets` v2（覆盖 JSON 键值、JWT、云厂商 Token、PEM 私钥、DB URL）；全量锁死 MCP 预设版本并替换为 `@bytebase/dbhub@0.15.0 --readonly` | `test/adversarial.test.mjs` + `test/mcp-hub.test.mjs` |
| **F-08** | 全局互斥锁串行化所有 MCP 工具并劫持 `globalThis.console` | 新增 `src/jobs.mjs` 子进程作业隔离器，彻底移除 `console` 劫持；只读工具全并发 + 工作区级细粒度写锁 | `test/mcp-jobs.test.mjs` + `test/mcp-server.test.mjs` |
| **F-09** | 长任务无进度心跳、取消信号不杀子进程树、HTTP 会话细节偏差 | 支持 `_meta.progressToken` 进度推送、`notifications/cancelled` 进程树强杀、`syncBudgetMs` 异步转后台、严格 `initialize` 会话与 `404` 语义 | `test/mcp-jobs.test.mjs` + `test/mcp-server.test.mjs` |
| **F-10** | 诊断分类误判；CodeMap 动态路由坍塌、删文件残留与缺陷计数虚增 | 结构化守卫信号优先定责（45/45 全准）；CodeMap v4 保留 `:id`/`[id]`、自动清理已删路由并收敛缺陷状态机；Impact v2 引入反向静态 `import` 依赖图 | `test/codemap.test.mjs` + `test/impact.test.mjs` |

---

## 3. 7 类种子缺陷实测检出明细 (`npm run bench`)

`examples/demo-webapp/server.mjs` 支持通过 `DEMO_DEFECT` 注入真实业务与前后端故障，`v5.0.0` 套件检出率 `7/7 (100%)`：

1. `500_courses`：课程列表接口返回 `HTTP 500` → 被 `api` 套件与诊断分类器精准捕获（C 类）。
2. `schema_drift`：`seatsLeft` 字段由数字漂移为字符串 → 被新增零依赖 JSON Schema 契约校验器（`support/schema-validator.mjs`）当场拦截。
3. `rbac_leak`：学生角色越权访问 `/api/admin/audit` 返回 `200` → 被 `[REQ-RBAC-001]` API 契约测试拦截。
4. `duplicate_enroll`：重复选课幂等锁失效返回 `201` 而非 `409` → 被 `[REQ-ENROLL-001]` 并发竞态与幂等测试拦截。
5. `soldout_enabled`：满员课程选课按钮未禁用 → 被 `[REQ-CATALOG-001]` E2E 状态断言拦截。
6. `uncaught_pageerror`：前端抛出未捕获异常 → 被 `base.ts` 运行时零容忍异常守卫拦截。
7. `a11y_missing_label`：搜索输入框缺失无障碍标签 → 被 `expectAccessible`（WCAG 2.0/2.1/2.2 AA）自动扫描拦截。

---

## 4. 验收口径声明

- 本评分卡中的自动化测试与 `demo-webapp` 基准属于 **「本机工作台与内置全栈靶场验收通过 (`local-workbench` & `demo-webapp` Verified)」**。
- 当接入具体企业业务仓库时，仍须针对非生产测试环境运行 `aitest verify-change --base origin/main` 以达成 **「真实业务 E2E 验收通过 (`business-e2e` Verified)」**。
