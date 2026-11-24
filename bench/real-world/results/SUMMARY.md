# 真实开源提交门禁误报率（Gate FPR）第一期试跑汇总报告（`n = 50`）

> [English Version](./SUMMARY.en.md) · [预登记方法文档](../PREREGISTRATION.md) · [原始统计 JSON](./summary.json) · [FGER-agentic 红队设计](../../agentic/DESIGN.md)

- **评测日期**：`2026-11-24`
- **门禁内核版本**：`v5.1.0`（离线静态审计 + TypeScript Compiler API 全文件 AST 语义 Diff 守卫 `AITEST-G101..G115`）
- **抽样种子**：`mulberry32(seed = 20261124)`（详见 [预登记方案](../PREREGISTRATION.md)，在采集数据前独立提交）
- **执行边界**：严格隔离离线分析——零第三方代码入库、零依赖安装、零被测代码执行、零被测站点网络访问。
- **正式评测（`n >= 200`）状态**：**`pending`**（严禁将本期 `n = 50` 试跑结果外推为正式评测指标）。

---

## 1. 核心统计摘要（Wilson 95% 置信区间）

| 指标 | 观测值 (`k / n`) | 比例 | Wilson 95% 置信区间 | 说明 |
|---|---:|---:|---|---|
| **原始门禁告警率（Raw Alert Rate）** | `12 / 50` | **`24.0%`** | **`[14.3%, 37.4%]`** | 未剔除任何告警的原始离线门禁报红比例 |
| **审核后误报率（Adjudicated Gate FPR，正常提交口径）** | `10 / 48` | **`20.8%`** | **`[11.7%, 34.3%]`** | 分母为人工复核后的正常演进提交数 `n_normal = 50 - 2 TP = 48` |
| **审核后误报率（保守全量口径 `FP / n`）** | `10 / 50` | **`20.0%`** | **`[11.2%, 33.0%]`** | 以全部 50 个提交为分母的保守误报率 |
| **真实正例命中（Audited True Positives, `TP`）** | `2 / 50` | **`4.0%`** | **`[1.1%, 13.5%]`** | 人工复核确认真实引入未豁免 `test.skip`（2 条）或 `waitForTimeout(100)` |
| **零告警直接通过（Passed Cleanly）** | `38 / 50` | **`76.0%`** | **`[62.6%, 85.7%]`** | 正常测试演进未被门禁误拦 |
| **正式评测（`n >= 200`）** | — | **`pending`** | — | 第二期计划，当前不做外推 |

---

## 2. 按开源仓库分布

| 开源仓库 | 许可证 | 样本数 | 直接通过 | 报红总数 | 误报 (`FP`) | 真报 (`TP`) | 未复核 |
|---|---|---:|---:|---:|---:|---:|---:|
| `actualbudget/actual` | `MIT` | 10 | 9 | 1 | 1 | 0 | 0 |
| `microsoft/playwright-mcp` | `Apache-2.0` | 10 | 7 | 3 | 3 | 0 | 0 |
| `sveltejs/kit` | `MIT` | 10 | 5 | 5 | 4 | 1 | 0 |
| `vitejs/vite` | `MIT` | 10 | 9 | 1 | 1 | 0 | 0 |
| `vuejs/vitepress` | `MIT` | 10 | 8 | 2 | 1 | 1 | 0 |
| **合计** | **5 个仓库** | **50** | **38** | **12** | **10** | **2** | **0** |

---

## 3. 触发规则频次统计

| 规则码 | 命中提交数 | 简要说明 |
|---|---:|---|
| `AITEST-G103` | 4 | S0–S5 断言总强度分值下降（含跨文件拆分或 `toBe`→`toBeFocused` / `toContainText`→`toBeHidden` 替换） |
| `AITEST-G105` | 3 | 新增 `test.skip`（含 1 起真报禁用旧测试、1 起重构条件表达式、1 起运行时能力守卫） |
| `AITEST-G107` | 3 | `try/catch` / `.catch(() => {})`（含 `page.evaluate` 动画收尾、预期异常断言、跨源安全回归测试） |
| `AITEST-G110` | 3 | 条件块内 `expect` 或早退（含文件顶层 `if (!isBuild) { test(...) }` 与 `if (process.env.DEV)` 守卫） |
| `AITEST-G102` | 2 | 单文件断言数净减少（2 起均为跨文件拆分测试到新 spec 文件） |
| `AITEST-G114` | 1 | `route.fulfill()` 拦截（安全回归测试用蜜罐域名校验零请求发出） |
| `STATIC-WAIT-FOR-TIMEOUT` | 1 | 新增 `page.waitForTimeout(100)`（真报） |

---

## 4. 全部 12 个报红提交的逐条人工复核明细

| # | 仓库与提交 | 触发规则 | 判定 | 复核理由摘要 |
|---:|---|---|---|---|
| 1 | `sveltejs/kit@3d5800fad6` | `AITEST-G107`, `AITEST-G110` | **`FP`** | 诊断信息标准化重构（#17276）；`if (process.env.DEV)` 前已有无条件长度断言，负向 `try/catch` 内含错误消息断言。 |
| 2 | `microsoft/playwright-mcp@2bf57e22c6` | `AITEST-G102`, `AITEST-G103` | **`FP`** | 正常跨文件拆分测试（#767）：将 `browser_type` 用例从 `tests/core.spec.ts` 拆入新文件 `tests/type.spec.ts`。 |
| 3 | `vuejs/vitepress@bead1384b2` | `AITEST-G107` | **`FP`** | 提交实际解除跳过并加强了 2 条 RTL 用例；仅因 `page.evaluate` 内 `try { animation.finish() } catch {}` 触发 G107。 |
| 4 | `microsoft/playwright-mcp@29711d07d3` | `AITEST-G102`, `AITEST-G103` | **`FP`** | 正常跨文件拆分测试（#716）：将 Streamable HTTP 测试从 `tests/sse.spec.ts` 拆入 259 行新文件 `tests/http.spec.ts`。 |
| 5 | `sveltejs/kit@9bc12d379f` | `AITEST-G105`, `AITEST-G110` | **`FP`** | 覆盖率变体统一重构（#16845）：仅把既有的 `test.skip(!process.env.*)` 改写为 `test.skip(variant !== ...)`，非新增跳过。 |
| 6 | `sveltejs/kit@224e791cb0` | `STATIC-WAIT-FOR-TIMEOUT` | **`TP`** | 新增用例中引入了硬编码 `await page.waitForTimeout(100)`，符合预登记的硬编码睡眠真报标准。 |
| 7 | `microsoft/playwright-mcp@b85dc6954a` | `AITEST-G105` | **`FP`** | 新增 VS Code 调试器用例包含旧版 Node 兼容守卫 `test.skip(!globalThis.WebSocket, ...)`，非禁用失败测试。 |
| 8 | `sveltejs/kit@dd63fd1a2e` | `AITEST-G107`, `AITEST-G114` | **`FP`** | 跨源安全回归测试：使用 `page.route('**://attacker.example/**', ...)` 作为蜜罐陷阱并预期 `app.goto` 拒绝。 |
| 9 | `vuejs/vitepress@44457ff2cc` | `AITEST-G105` | **`TP`** | 图标更新 PR（#5506）直接用未豁免 `test.skip` 禁用了两条原有 E2E 用例（`// FIXME: flaky` 等），典型真报。 |
| 10 | `actualbudget/actual@a81408595c` | `AITEST-G103` | **`FP`** | 正常 UI 迁移（#8528）：旧通知条 `toContainText` (S3) 替换为新弹窗 `toBeHidden` (S2)，保留了核心 S5 `toHaveText` 业务断言。 |
| 11 | `sveltejs/kit@30d06f5698` | `AITEST-G103` | **`FP`** | 正常测试改进（#16992）：将 `page.evaluate(...activeElement.nodeName).toBe('BODY')` (S5) 替换为更符合 Playwright 习惯的 `toBeFocused()` (S2)。 |
| 12 | `vitejs/vite@616296895b` | `AITEST-G110` | **`FP`** | 正常新增 HMR 回归用例（#23171），因位于文件级 `if (!isBuild) { ... }` 内被 G110 跨 `test()` 边界误判。 |

---

## 5. 复现命令

```bash
# 安装 TypeScript AST 编译器依赖（门禁内核 fail-closed 要求）
cd templates/playwright-qa && npm ci --no-audit --no-fund && cd ../..

# CI Smoke 规模（5 个提交，每仓 1 个，输出至 gitignored .cache/smoke-results/）
node scripts/bench-real-world.mjs --smoke

# 完整第一期试跑（50 个提交，输出至 bench/real-world/results/）
node scripts/bench-real-world.mjs
```
