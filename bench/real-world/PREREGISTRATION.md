# 真实开源提交门禁误报率（Gate FPR）预登记评测方案（第一期）

> [English Version](./PREREGISTRATION.en.md) · [四层防假绿治理指南](../../docs/governance.md) · [主文档 README](../../README.md)

- **预登记版本**：`1.0.0`
- **预登记日期**：`2026-11-24`
- **评测对象**：`ai-test-workbench@5.1.0` 四层防假绿门禁内核（离线静态审计 + TypeScript AST 全文件语义 Diff 守卫 `AITEST-G101..G115`）
- **预登记承诺**：本文档在采集任何真实 GitHub 提交与生成 `bench/real-world/corpus.json` 之前撰写并独立提交到 Git 历史，所有筛选规则、排除规则、随机种子与误报判定标准在数据采集前冻结，事后不得为压低指标而静默剔除样本。

---

## 1. 评测目标与分期范围

内部合成基准（`bench/scorecard.json`）只能验证门禁对已知回归语料的行为，无法证明门禁在真实世界 Playwright 测试代码演进中的误报率（False Positive Rate, FPR）。

为获得可复现、可审计的外部证据，本评测分两期推进：

1. **第一期（Real-World Pilot，本期实施）**：目标样本量 **`n >= 50`** 个真实开源提交（若受网络速率或时间限制，最低不少于 **`n = 30`** 个），如实报告实际样本量 `n`、全部报红提交的逐条人工复核记录及 Wilson 95% 置信区间。
2. **第二期（Formal Evaluation，状态：`pending`）**：扩展至 **`n >= 200`** 个跨行业/跨框架真实开源提交，当前明确标为 `pending`，**严禁将第一期试跑数字外推为正式评测结论**。

---

## 2. 样本来源筛选规则（Repository Eligibility）

候选仓库必须同时满足以下全部客观条件：

1. **真实 Playwright 测试资产**：公开 GitHub 开源仓库，声明或实际使用 Playwright Test（包含 `*.spec.ts` / `*.spec.js` / `*.test.ts` / `*.e2e.ts` 等使用 `@playwright/test` 的端到端测试文件）。
2. **宽松开源许可证**：仓库顶层许可证为常见宽松许可证之一（SPDX：`MIT`、`Apache-2.0`、`BSD-2-Clause`、`BSD-3-Clause`、`ISC`）。
3. **近期活跃维护**：在评测基准日（`2026-11-24`）前 **24 个月内**存在活跃提交；排除 archived（已归档）仓库、fork 仓库及纯只读镜像仓库。
4. **多仓库多样性**：语料须来自至少 **4 个**不同的独立开源仓库，且按仓库均衡配额抽样，防止单一仓库的编码风格主导结果。
5. **零第三方源码入库原则**：`bench/real-world/corpus.json` **只存储元数据** `{ repo, sha, parentSha, license, testPaths }`，绝不将第三方仓库源码提交进本仓库；执行评测时仅浅克隆/按需抓取目标对象到被 `.gitignore` 忽略的 `bench/real-world/.cache/` 目录。

---

## 3. 提交级排除规则（Commit Exclusion Rules）

在从合规仓库抽取候选提交时，按以下**事先固定的客观机械规则**过滤，不得按门禁输出反向过滤：

1. **合并提交与根提交**：排除 `parents.length !== 1` 的合并提交（Merge Commit）及无父提交的根提交，确保每个样本都有唯一确定的 `parentSha -> sha` 变更对。
2. **非修改型文件变更**：排除仅新增整个测试文件（`status = A`）或仅删除整个测试文件（`status = D`）的提交，至少包含 1 个在 `parentSha` 与 `sha` 中均存在的被修改 Playwright 测试文件（`status = M` 或重命名修改 `R`），以便完整测试 AST 语义 Diff 守卫。
3. **大规模机械变更**：排除单次提交总变更文件数 `> 50` 的全仓格式化、批量重命名、依赖升级或 Codemod 提交。
4. **非目标文件类型**：只纳入 Playwright `.ts` / `.tsx` / `.js` / `.mjs` 测试文件，排除纯非 Playwright 单元测试、纯快照文件与二进制资源。
5. **不可静默删样本**：一旦样本经确定性抽样进入 `corpus.json`，无论是否触发门禁报红，均不得静默删除；若人工复核发现个别提交本身确属故意禁用测试/WIP 临时提交，须在结果 JSON 中显式记录其分类与理由。

---

## 4. 确定性随机抽样种子（Deterministic Sampling）

- **固定 PRNG 算法**：32 位 `mulberry32` 确定性伪随机数生成器。
- **预登记锁定种子**：**`seed = 20261124`**。
- **抽样步骤**：
  1. 对每个入选仓库，从默认分支近期历史中检索满足第 2、3 节机械条件的候选提交列表。
  2. 将候选提交按 `repo + ":" + sha` 进行稳定字典序排序，消除 API 返回顺序波动。
  3. 使用 `mulberry32(20261124)` 对每个仓库的候选池执行确定性 Fisher-Yates 洗牌，按轮询/均衡配额抽取直至达到目标样本数（第一期目标 `n = 50`，最低下限 `n = 30`）。
  4. 将最终元数据列表写入 `bench/real-world/corpus.json`，并记录抽样时间戳与仓库配额分布。

---

## 5. 隔离离线评测规程（Offline Gate Execution）

- **严格隔离边界**：评测脚本 `scripts/bench-real-world.mjs` 运行时**禁止**安装被测仓库 `node_modules`、**禁止**执行被测仓库任何代码或构建脚本、**禁止**联网访问任何被测 Web 站点；网络活动仅限于只读 Git 对象拉取到本地 `.cache/` 目录（CI smoke 模式亦如此）。
- **门禁执行范围**：对每个样本提交的每个 `testPaths` 文件，提取 `parentSha:<path>` 与 `sha:<path>` 源码，直接调用本仓库门禁内核（`templates/playwright-qa/support/gate/ast-analyzer.mjs`）：
  1. **Layer 3 全文件 TypeScript AST 语义 Diff 守卫**：`compareSpecSourcesAst(testPath, baseSource, headSource)`，检查全部语义规则 `AITEST-G101..G115`（含断言净减少、S0–S5 断言强度降级、`.not` 反转、新增 `skip/fixme/only/fail`、新增 `{ force: true }`、吞异常 `catch`、超大超时、自指断言、恒真 S0 断言、`page.route(...fulfill)` 假成功桩、降级语义定位器、5xx 放行与移除关键标签）。
  2. **Layer 2 差异化静态反模式检查**：对比 `parentSha` 与 `sha` 在测试文件中新增的硬编码 `waitForTimeout()` 或原始 `request.newContext()`（仅统计本提交新引入项，不归咎仓库历史存量）。
  3. **适用性说明**：Layer 0（`.aitest/governance.lock`）与 Layer 1（`Run Ledger`）依赖目标仓库本地运行 Playwright 与治理初始化，外部开源历史提交不具备运行态账本，因此在离线静态与 AST 评测中标注为 `offline-static-ast-only`，不伪造运行态通过结论。

---

## 6. “误报（False Positive）”判定标准

对于每个被门禁报红（`flagged === true`）的提交，必须人工审阅真实 `git show <sha>` diff 与上下文，并按以下二元标准归类：

| 判定类别 | 定义与判定依据 | 典型示例 |
|---|---|---|
| **误报（`FP` — False Positive）** | 门禁报红，但人工复核认定该提交是**正常的测试或业务代码演进**，并非偷懒改弱测试或掩盖缺陷。 | 将重复断言提取到外部 Page Object / helper 函数导致单文件断言计数下降；随产品需求移除已下线功能的测试或替换为等价验证；合法改写断言结构（如 `expect(a).toBe(...)` 改为等效自定义匹配器或组合校验）。 |
| **真报（`TP` — True Positive）** | 门禁报红，且人工复核确认该提交**确实引入了门禁旨在拦截的风险模式**（在 AI Agent 治理场景下本应阻断或要求人工审批）。 | 新增未豁免的 `test.skip()` / `test.fixme()` / `test.only()`；新增 `{ force: true }` 绕过可交互检查；新增硬编码 `waitForTimeout(...)`；引入吞异常的 `.catch(() => {})`；直接删除或弱化现有断言以回避失败。 |

**透明披露原则**：汇总报告与 `README` 必须同时透明呈现：
- **审核后误报率（Adjudicated Gate FPR）**：`FP / n_normal`（其中 `n_normal = n - TP` 为经复核确认的正常演进提交数），以及 `FP / n`；
- **原始门禁告警率（Raw Gate Alert Rate）**：`flagged / n`（不经任何剔除的机械告警比例）；
- 全部被标记提交的明细 JSON（`repo`、`sha`、触发规则码、人工判定 `FP/TP` 与逐条理由）。

---

## 7. 统计方法（Wilson 95% 置信区间）

对于二项观测值 $(k, n)$（成功/误报次数 $k$，总样本数 $n$），使用 **Wilson Score 95% 置信区间**（双侧 $\alpha = 0.05$，$z = 1.959964$）：

$$\hat{p} = \frac{k}{n}, \quad \text{CI}_{95\%} = \left[ \frac{\hat{p} + \frac{z^2}{2n} - z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}},\; \frac{\hat{p} + \frac{z^2}{2n} + z\sqrt{\frac{\hat{p}(1-\hat{p})}{n} + \frac{z^2}{4n^2}}}{1 + \frac{z^2}{n}} \right]$$

- 当 $k = 0$ 时，Wilson 区间仍会给出非零上界（例如 $n = 50, k = 0 \Rightarrow [0.0\%, 7.1\%]$），杜绝 Wald 近似给出误导性的 `0% ± 0%`。
- 所有结果均以真实观测值 `(k, n)` 与对应 Wilson 95% CI 区间呈现；第一期试跑不作为正式发布达标外推依据。
