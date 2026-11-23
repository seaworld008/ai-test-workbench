# 四层可信防假绿门禁、治理锁与自愈状态机指南 (`v5.0`)

> [English Version](./governance.en.md) · [简体中文主文档](../README.md) · [架构设计](../ARCHITECTURE.md) · [验证评分卡](./review/v5-verification-scorecard.md)

`ai-test-workbench v5.0` 的核心定位是 **AI 编码 Agent 的独立可信验证内核（Trustworthy Verification Kernel）**。我们不依赖提示词里的“君子协定”约束模型，而是通过**工具强执（Tool-Enforced Governance）**从根源阻断假绿逃逸。

---

## 1. 四层可信防假绿门禁内核 (`support/gate-kernel.mjs`)

每次执行 `aitest audit`、`aitest run --audit` 或一键判决 `aitest verify-change` 时，都会依次通过以下四道硬门禁：

| 层级 | 门禁名称 | 核心校验内容 | 阻断典型作弊手段 |
|---|---|---|---|
| **Layer 0** | **治理文件防篡改锁 (`governance.lock`)** | 校验 `eslint.config.mjs`、`playwright.config.ts`、`aitest.config.json`、`waivers.json`、`perf-budget.json`、`support/*.mjs`、`tests/fixtures/base.ts` 等 11 个受保护文件的 SHA-256 指纹 | Agent 私自关掉 ESLint 规则、在 `playwright.config.ts` 加 `testIgnore` 或调大 `retries: 5`、自己往 `waivers.json` 写豁免 |
| **Layer 1** | **静态类型与 Playwright 规则门禁** | `tsc --noEmit` + `eslint-plugin-playwright`（含禁止 `request.newContext()` 与 `test.fail()`） | 零断言空壳测试、`.only`、`waitForTimeout()`、`{ force: true }`、绕过安全 Fixture 直接裸发请求 |
| **Layer 2** | **运行账本绑定与豁免审计 (`Run Ledger`)** | 校验 `.aitest/runs/<runId>/manifest.json` 绑定关系与源码输入指纹；严拆 `passed / failed / flaky / quarantined / skipped / policyExcludedMutation`；按 `file:line` 去重 `@mutation`；强制 `waivers.json` 人类审批人、关联单号、`<= 5` 条上限与 `<= 14 天` 有效期 | 拿上一次绿色的陈旧 `results.json` 蒙混过关、Bot 自签豁免、超长有效期豁免 |
| **Layer 3** | **断言强度格与语义 Diff 守卫 (`S0–S5`)** | 扫描整个 `qa/`（含未跟踪新文件），计算每个用例块的断言强度格（`S5` 精确值 -> `S4` 结构/契约 -> `S3` 子串/正则 -> `S2` 可见/状态 -> `S1` 弱存在 -> `S0` 恒真），拦截 `AITEST-G101..G113` 共 13 类语义退化 | `toHaveText('49/50')` 改成 `toBeVisible()`、`expect(true).toBe(true)`、`test.fail()`、`.catch(() => null)`、`expect.soft()`、`if (...) { expect(...) }`、把 `200` 断言改成 `500` 迎合崩坏接口、空 `verifyNothing()` 辅助函数 |

---

## 2. 人类专属治理审批协议 (`aitest governance`)

受保护治理文件默认锁定在 `<repo>/qa/.aitest/governance.lock`，配套只追加审计日志 `.aitest/governance-audit.jsonl`：

```bash
# 查看受保护治理文件哈希状态（Agent 与人工均可只读执行）
npx ai-test-workbench governance status --target "/path/to/repo"

# 人工修改受保护配置或新增合规豁免后，由人类在本地终端重签治理锁
npx ai-test-workbench governance approve --target "/path/to/repo" --approver "alice@team" --reason "更新 staging 性能预算基线"
```

> [!IMPORTANT]
> **特权物理隔离**：`governance approve` **绝不暴露为 MCP 工具**，且当检测到 `AITEST_MCP_CHILD=1`（由 MCP 服务端派生的子进程）时直接拒绝执行，并拦截 `codex`、`claude`、`ai-agent`、`healer` 等机器人审批名。

---

## 3. 有状态自愈会话状态机 (`aitest heal` / `aitest_heal_*`)

取代无记忆的自由改码循环，所有失败修复必须通过状态机推进：

1. **`aitest_heal_begin`**：读取最新 `Run Ledger` 与结构化诊断信号（`A / B / C / D`），创建 `.aitest/heals/<sessionId>.json`：
   - **A 类（定位器/等待同步漂移）**：允许进入修复态（`allowedToEditTests: true`），最多 **3 轮尝试**。
   - **B 类（环境/网络/门禁阻断）**：**硬阻断改测试**（退出码 `2`），提示修复基础设施或重新执行 `auth-login`。
   - **C 类（后端 `5xx`、未捕获异常、契约/业务缺陷）**：**硬阻断改测试**（退出码 `2`），自动附带 W3C `Trace-ID` 生成标准缺陷工单 `reports/defects/<id>.md`。
   - **D 类（需求歧义）**：**硬阻断改测试**，暂停并请求用户确认预期验收口径。
2. **`aitest_heal_attempt`**：每轮修改定位器后，自动执行单测重跑 + 语义 Diff 守卫 + 治理锁校验；一旦检测到断言降级或触及第 3 轮上限仍未恢复，立即熔断升级。
3. **`aitest_heal_conclude`**：归档自愈审计轨迹与最终复核状态。

---

## 4. 历史抖动率统计与自动隔离区 (`Flaky Quarantine`)

- 每次运行自动写入 `.aitest/runs/index.jsonl`，由 `src/flaky.mjs` 滑动统计近 20 次运行的用例抖动率。
- 抖动率超标用例可记入 `.aitest/quarantine.json`（最长 `7 天` TTL 到期自动失效；连续 `5 次` 干净通过自动解除隔离），严禁静默永久跳过。

---

## 5. 一键可信变更判决 (`aitest verify-change` / `aitest_verify_change`)

在代码提交或 PR 合并前，只需一次调用即可串联完整闭环：
`governance verify` → `Import-Graph Impact v2` → `Playwright Run (Run Ledger)` → `4-Layer Gate Audit` → `Diagnose & Trace Matrix`，自动产出：
- 机器可验签证明书：`<repo>/qa/.aitest/runs/<runId>/attestation.json`
- 人类可读判决书：`<repo>/qa/reports/verdict-summary.md`（显式区分 `local-workbench` 与 `business-e2e` 验收口径）
- GitHub Code Scanning 兼容报告：`<repo>/qa/reports/verdict.sarif.json`
