# ADR-0004：可插拔 AST 门禁规则引擎与跨文件/作用域感知误报治理

> [English Version](./0004-pluggable-ast-gate-and-fp-governance.en.md) · [简体中文主文档](../../README.md) · [治理指南](../governance.md)

- **状态**：已采纳（Accepted，落地于 `v6.0.0`）
- **决策日期**：`2026-11-24`

---

## 1. 背景与问题陈述

在 `v5.1.1` 中，Layer 3 语义门禁集中在 `1,649` 行的单一文件 `ast-analyzer.mjs` 中：全部 `AITEST-G101..G115` 规则耦合在一个大比较函数内，且缺乏词法作用域栈与提交级跨文件视角。在 5 个开源仓库的 50 个真实提交试跑中，门禁误报率达 `20.8%`（`10/48`，Wilson 95% CI `[11.7%, 34.3%]`）。

---

## 2. 架构与误报治理设计

1. **模块化规则引擎（`src/kernel/gate/`）**：
   - 将原上帝文件拆分为 `ts-loader.mjs`、`constant-eval.mjs`、`lattice.mjs`、`parser-inspectors.mjs`、`parser.mjs`、`diff-parser.mjs`、`changeset.mjs`、`static-runner.mjs` 及 4 组独立规则文件（`rules/{governance,assertion,control-flow,locator-and-oracle}-rules.mjs` + `rules/index.mjs`），所有单文件均 `<= 600` 行。
   - 每条规则均产出结构化 `GateFinding`（`ruleId`、`severity`、`file`、`line`、`message`），支持按 `aitest.config.json#rules` 独立配置（仍受 `governance.lock` 保护，修改须经人类 `governance approve`）。
2. **五项系统性降误报机制（不牺牲防作弊拦截能力）**：
   - **提交级跨文件断言池化（`G102/G103`）**：通过 `compareChangesetAst` 对同一提交内新增/修改 spec 做跨文件测试标题匹配，识别测试拆分迁移。
   - **显式词法作用域栈（`G107/G110`）**：区分 `top-level`、`describe`、`hook`、`test` 与 `browser-evaluate`（`page.evaluate` / `locator.evaluate`），排除文件级 `if (!isBuild) { test(...) }`、浏览器端 `try/catch` 及负向错误断言 `try/catch`。
   - **结构化 `skip` 计次与运行时能力守卫（`G105`）**：按作用域净增量统计新增 `skip`，仅放行特定运行时能力探测（如 `globalThis.WebSocket`），绝不放宽任意 `process.env` 门控。
   - **Web-First 断言强度格校准（`G103`）**：将 `toBeFocused`、`toBeDisabled`、`toBeHidden`、`toBeChecked` 等标准状态断言与 DOM `evaluate` 探针合理归类至 `S3`。
   - **故障注入与蜜罐陷阱感知（`G114`）**：区分测试错误路径的 `route.fulfill({ status >= 400 })` 与安全蜜罐回调，同时继续硬阻断 `2xx` 伪造成功载荷。

---

## 3. 盲测未见留出集实测结果

在修改规则前先以新随机种子 `20261125` 抽取 `50` 个与试跑集完全不重叠（`0` 交集）的未见真实提交（`bench/real-world/holdout-v6-corpus.json`），零留出集后验调参实测前后变化：

| 评测集 | 改前误报率 (Wilson 95% CI) | 改后误报率 (Wilson 95% CI) | 真实异常召回 |
|---|---:|---:|---:|
| **未见留出集 (`n=50`, `n_normal=49`)** | `12.2% (6/49)` `[5.7%, 24.2%]` | **`6.1% (3/49)` `[2.1%, 16.5%]`** | `1/1` 保留 |
| **试跑集 (`n=50`, `n_normal=48`)** | `20.8% (10/48)` `[11.7%, 34.3%]` | **`4.2% (2/48)` `[1.2%, 14.0%]`** | `2/2` 保留 |
| **合并集 (`n=100`, `n_normal=97`)** | `16.5% (16/97)` `[10.4%, 25.1%]` | **`5.2% (5/97)` `[2.2%, 11.5%]`** | `3/3` 保留 |

同步验证对抗指标零回退：`FGER-int = 0.0% (26/26)`、`FGER-holdout = 0.0% (24/24)`、`Gate-FPR(internal) = 0.0% (12/12)`。

---

## 4. 已知剩余误报与边界

剩余未见留出集 3 例误报均属于更深层的语义重构（如引入新抽象包装函数后原内联断言移至外部 helper），在不引入完整 `ts.createProgram` 跨文件类型解析的前提下明确列为已知边界。
