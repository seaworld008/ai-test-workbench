# 四层可信防假绿门禁、治理锁与自愈状态机指南 (`v6.0`)

> [English Version](./governance.en.md) · [简体中文主文档](../README.md) · [架构设计](../ARCHITECTURE.md) · [v6.0 升级指南](./upgrade.md)

`ai-test-workbench v6.0` 是面向 AI 编码 Agent 的**独立可信验证内核（Trustworthy Verification Kernel）**。防假绿与安全边界由**工具强执（Tool-Enforced & Fail-Closed）**落地，不依赖提示词软约定。

---

## 1. 四层可信防假绿门禁内核 (`src/kernel/gate/`)

每次执行 `npx ai-test-workbench@6.0.0 audit`、`npx ai-test-workbench@6.0.0 run --audit` 或一键判决 `npx ai-test-workbench@6.0.0 verify-change` 时，均依次经过以下四层 fail-closed 门禁（任何缺失、不可用或未绑定结果均返回三态 `blocked`，退出码 `2`）：

| 层级 | 门禁名称 | 核心校验内容 | 阻断典型作弊手段 |
|---|---|---|---|
| **Layer 0** | **治理文件防篡改锁 (`governance.lock`) 与配置校验** | 校验 `eslint.config.mjs`、`playwright.config.ts`、`aitest.config.json`、`waivers.json`、`perf-budget.json`、`impact-map.json`、`support/**/*.mjs`、`tests/fixtures/base.ts` 等 17 条受保护路径模式的 SHA-256 指纹与 T1 MAC，并按 JSON Schema 校验 `aitest.config.json` | Agent 篡改 ESLint/Playwright/治理规则、放宽 `retries`/`testIgnore`、自写 `waivers.json`、损坏配置回退默认值 |
| **Layer 1** | **静态类型与 Playwright 规则门禁** | `tsc --noEmit` + `eslint-plugin-playwright`（含禁止 `request.newContext()` 与 `test.fail()`）+ AST 静态断言检查；CI 环境缺失编译器默认 `blocked` | 零断言空壳测试、`.only`、`waitForTimeout()`、`{ force: true }`、绕过安全 Fixture 裸发请求 |
| **Layer 2** | **运行账本绑定与豁免审计 (`Run Ledger`)** | 校验 `.aitest/runs/<runId>/manifest.json`、源码输入指纹与 `results.json` SHA-256 绑定（自定义 `--results` 未传 `--expected-run-id` 默认阻断）；严拆 `passed / failed / flaky / quarantined / skipped / policyExcludedMutation`（默认 `maxSkipped=0`）；强制 `waivers.json` 人类审批、单号、`<= 5` 条与 `<= 14 天` TTL | 复用陈旧 `results.json` 蒙混过关、Bot 自签豁免、超长有效期或绕过账本 |
| **Layer 3** | **可插拔 AST 断言强度格与提交级语义 Diff 守卫 (`S0–S5`)** | 基于 TypeScript 编译器 AST 与显式词法作用域栈（`top-level/describe/hook/test/browser-evaluate`）运行 `AITEST-G101..G115` 共 15 条独立规则，并结合提交级跨文件断言池化与故障注入/蜜罐感知；缺 TS 编译器默认 `blocked` | 删减断言、高阶断言降级（如 `toHaveText` -> `toBeVisible`）、`S0` 恒真断言、`test.fail()`、`expect.soft()`、空 `catch` 吞错、测试体内条件包断言、伪造 `2xx` 后端响应 |

---

## 2. 人类专属治理审批协议 (`npx ai-test-workbench@6.0.0 governance`)

受保护治理文件锁定于 `<repo>/qa/.aitest/governance.lock`，并附只追加审计日志 `.aitest/governance-audit.jsonl`：

```bash
# 查看受保护治理文件哈希状态（Agent 与人工均可只读执行）
npx ai-test-workbench@6.0.0 governance status --target "/path/to/repo"

# 人工修改受保护配置或新增合规豁免后，由人类在本地终端重签治理锁
npx ai-test-workbench@6.0.0 governance approve --target "/path/to/repo" --by "alice@team" --reason "更新 staging 性能预算基线"
```

> [!IMPORTANT]
> **特权物理隔离**：`governance approve` **永不注册为 MCP 工具**，检测到 `AITEST_MCP_CHILD=1` 时立即硬阻断，同时拒绝 `codex`、`claude`、`ai-agent`、`healer` 等机器人审批标识。

---

## 3. 有状态自愈会话状态机 (`npx ai-test-workbench@6.0.0 heal` / `aitest_heal`)

所有失败修复均通过带 T1 MAC 保护的状态机推进：

1. **`aitest_heal(action="begin")`**（CLI：`heal begin`）：读取最新 `Run Ledger` 与结构化诊断信号（`A / B / C / D`），创建 `.aitest/heals/<sessionId>.json`：
   - **A 类（定位器/等待同步漂移）**：允许进入修复态（`allowedToEditTests: true`），跨会话累计最多 **3 轮尝试**。
   - **B 类（环境/网络/门禁阻断）**：**硬阻断改测试**（退出码 `2`），提示修复环境或重新运行 `auth-login`。
   - **C 类（后端 `5xx`、未捕获异常、契约/业务缺陷）**：**硬阻断改测试**（退出码 `2`），自动附带 32 位 W3C `Trace-ID` 生成缺陷单 `reports/defects/<id>.md`。
   - **D 类（需求歧义）**：**硬阻断改测试**，暂停并向用户确认预期行为。
2. **`aitest_heal(action="attempt")`**（CLI：`heal attempt`）：每轮仅改定位器后自动校验治理锁 + AST 语义 Diff 守卫 + 重跑；一旦检测到断言弱化或用尽 3 轮即熔断升级。
3. **`aitest_heal(action="conclude")`**（CLI：`heal conclude`）：归档自愈轨迹，C 类缺陷自动写出工单。

---

## 4. 历史抖动率统计与自动隔离区 (`Flaky Quarantine`)

- 每次运行写入 `.aitest/runs/index.jsonl`，由 `src/flaky.mjs` 滑动统计近 20 次运行抖动率。
- 抖动率超标的非关键用例可记入受 T1 MAC 保护的 `.aitest/quarantine.json`（最长 `7 天` TTL 到期自动失效；连续 `5 次` 干净通过自动解除隔离），禁止永久静默跳过。

---

## 5. 一键可信变更判决 (`npx ai-test-workbench@6.0.0 verify-change` / `aitest_verify_change`)

一次调用即可串联完整闭环：
`governance verify` → `Git merge-base` → `Import-Graph Impact v2` → `Playwright Run (Run Ledger)` → `4-Layer Gate Audit` → `Heal Conflict Check` → `Diagnose & Trace Matrix`，产出：
- 机器可验签证明书：`<repo>/qa/.aitest/runs/<runId>/attestation.json`（in-toto Statement v1）
- 人类可读判决书：`<repo>/qa/reports/verdict-summary.md`（显式区分 `local-workbench` 与 `business-e2e` 口径）
- SARIF 2.1.0 报告：`<repo>/qa/reports/verdict.sarif.json`

---

## 6. 信任分级（`T0 / T1 / T2`）与可复用 CI 证明工作流

| 信任分级 | 定义 | 是否为合入级绿灯 |
|---|---|---|
| **T0** | 未经验证的本地运行或降级覆盖 | 否 |
| **T1** | 本地 Run Ledger + HMAC（证明完整性，不证明来源） | 否 |
| **T2** | 在 GitHub 托管 runner 上从干净 checkout 重跑，由 Sigstore 免密钥签名并校验通过签发者身份 | **是（唯一合入级绿灯）** |

- 通过 [examples/workflows/use-aitest-verify.yml](../examples/workflows/use-aitest-verify.yml) 接入 `.github/workflows/aitest-verify.yml`。
- 离线验签统一执行：
  ```bash
  npx ai-test-workbench@6.0.0 attest verify --file <attestation.json> --bundle <attestation.sigstore.json> --expect-repo <owner/repo> --expect-workflow <workflow-path> --expect-ref <ref>
  ```
- 私有仓库须知：`signer: github-attest`（默认）依赖 GitHub Artifact Attestations（私有仓库需 GitHub Enterprise Cloud）；`signer: cosign` 使用公共 Sigstore 时会将仓库身份写入公开 Rekor 日志。
