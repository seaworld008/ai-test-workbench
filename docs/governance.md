# 四层可信防假绿门禁、治理锁与自愈状态机指南 (`v6.6`)

> [English Version](./governance.en.md) · [简体中文主文档](../README.md) · [架构设计](../ARCHITECTURE.md) · [ADR-0007 外部图谱侧车](./adr/0007-external-code-graph-engine.md) · [升级指南](./upgrade.md)

`ai-test-workbench v6.6` 是面向 AI 编码 Agent 的**独立可信验证内核（Trustworthy Verification Kernel）**。防假绿、外部代码图谱供应链校验与安全边界由**工具强执（Tool-Enforced & Fail-Closed）**落地，并在单次入口打开不可变 `TrustContext`，贯穿全部门禁与账本校验。

---

## 1. 四层可信防假绿门禁内核 (`src/kernel/gate/`)

每次执行 `npx ai-test-workbench@6.6.0 audit`、`npx ai-test-workbench@6.6.0 run --audit` 或一键判决 `npx ai-test-workbench@6.6.0 verify-change` 时，均依次经过以下四层 fail-closed 门禁（任何缺失、不可用或未绑定结果均返回三态 `blocked`，退出码 `2`）：

| 层级 | 门禁名称 | 核心校验内容 | 阻断典型作弊手段 |
|---|---|---|---|
| **Layer 0** | **治理防篡改锁、粘性 T1、供应链锁与配置校验** | 校验 `eslint.config.mjs`、`playwright.config.ts`、`aitest.config.json`、`waivers.json`、`known-blockers.json`、`impact-map.json`、`corpus/**`、`fixtures/upstream-cassettes/**`、`support/**`（含 `project-rules.json`）、`tests/fixtures/base.ts` 及 **`.aitest/mcp.lock`**、**`.aitest/engine-manifest.json`**（`src/core/config-schema.mjs` + `src/kernel/gate/policy.mjs`）的 SHA-256 指纹、多机 `macs` 与粘性 T1，并按 JSON Schema 校验 `aitest.config.json`（含 `codeMap` / `externalEngine`）；`src/mcp-hub/auditor.mjs` 同步强制校验原生侧车 `--ui=false`、禁止自更新参数、精确版本号与本地二进制 SHA-256（含 `strictChecksum`），并对外部图谱索引的代码符号/路径/注解执行 `sanitizeUntrustedCodeMetadata` 防提示词投毒 | Agent 重签或删 `governance.lock` 后调 `aitest_init` 洗白、私自替换侧车二进制或篡改 `.aitest/mcp.lock` / `.aitest/engine-manifest.json`、私造上游回放磁带、未审注入 `project-rules.json`、剥离 `mac` 退回 T0、通过恶意代码注释注入提示词 |
| **Layer 1** | **静态类型与 Playwright 规则门禁** | `tsc --noEmit` + `eslint-plugin-playwright`（含禁止 `request.newContext()` 与 `test.fail()`）+ AST 静态断言检查（统一 `static-runner`）；CI 或存在 `governance.lock && node_modules` 时缺失编译器默认 `blocked` | 零断言空壳测试、`.only`、`waitForTimeout()`、`{ force: true }`、绕过安全 Fixture 裸发请求 |
| **Layer 2** | **运行账本绑定与豁免审计 (`Run Ledger`)** | 校验 `.aitest/runs/<runId>/manifest.json`、源码输入指纹（含被 `.gitignore` 忽略目录的确定性文件系统树回退）与 `results.json` SHA-256 绑定（自定义 `--results` 未传 `--expected-run-id` 或 `partialScope: true` 账本默认阻断）；严拆 `passed / failed / flaky / quarantined / skipped / policyExcludedMutation`（默认 `maxSkipped=0`）；强制 `waivers.json` 人类审批、单号、`<= 5` 条与 `<= 14 天` TTL | 复用陈旧 `results.json` 蒙混过关、用局部 `heal attempt` 结果充当全量绿灯、Bot 自签豁免、删账本退回 T0 |
| **Layer 3** | **AST 符号表、强度格、Dieselgate 与锁步门禁 (`S0–S5`)** | 基于 TypeScript 编译器 AST、词法作用域栈与跨作用域 `SymbolTable` 运行 **`AITEST-G101..G118`** 共 **18 条**规则（含 `G116` 状态字面量等价替换、`G117` 产品侧测试流量特判、`G118` 跨目录/跨栈锁步同步门禁、`git mv` 移出测试目录阻断、`.aitest/baseline-ref` 分支新增草稿豁免，以及经治理锁校验的声明式 `qa/support/project-rules.json`） | 删减断言、const/DOM 语义降级、`S0` 恒真断言、`test.fail()`、`200→201` 迎合、产品侧按 User-Agent/Header 特判放水、仅改一侧漏同步配对目录、复制粘贴硬编码静态 fallback 捷径 |

---

## 2. 人类专属治理审批协议 (`npx ai-test-workbench@6.6.0 governance`)

受保护治理文件（含 `.aitest/mcp.lock` 与 `.aitest/engine-manifest.json`）锁定于 `<repo>/qa/.aitest/governance.lock`，并附只追加审计日志 `.aitest/governance-audit.jsonl`：

```bash
# 查看受保护治理文件哈希状态（Agent 与人工均可只读执行）
npx ai-test-workbench@6.6.0 governance status --target "/path/to/repo"

# 人工修改受保护配置、安装/升级图谱侧车或更新 mcp.lock / known-blockers.json / project-rules.json 后，由人类重签治理锁
npx ai-test-workbench@6.6.0 governance approve --target "/path/to/repo" --by "alice@team" --reason "更新 staging 性能预算基线与侧车引擎清单"
```

> [!IMPORTANT]
> **特权物理隔离**：`governance approve` 与 `mcp install-engine` **永不注册为 MCP 工具**，检测到 `AITEST_MCP_CHILD=1` 时立即硬阻断，同时拒绝 `codex`、`claude`、`ai-agent`、`healer` 等机器人审批标识；`upgrade --scope engines` 与 `aitw learn` 均**绝不自动下载二进制、修改受锁文件或自签锁**。

---

## 3. 有状态自愈会话状态机 (`npx ai-test-workbench@6.6.0 heal` / `aitest_heal`)

所有失败修复均通过带 T1 MAC 保护的状态机推进（若失败项已命中 `qa/known-blockers.json` 中 `open` 状态的已知阻塞单，`begin` 直接硬阻断并返回 `blockerLinked: true`，退出码 `2`）：

1. **`aitest_heal(action="begin")`**（CLI：`heal begin`）：读取最新 `Run Ledger` 与结构化诊断信号（`A / B / C / D`），创建 `.aitest/heals/<sessionId>.json`：
   - **A 类（定位器/等待同步漂移）**：允许进入修复态（`repairPermitted: true`），跨会话累计最多 **3 轮尝试**。
   - **B 类（环境/网络/门禁阻断）**：**硬阻断改测试**（退出码 `2`），提示修复环境或重新运行 `auth-login`。
   - **C 类（后端 `5xx`、未捕获异常、契约/业务缺陷）**：**硬阻断改测试**（退出码 `2`），自动附带 32 位 W3C/`sw8` `Trace-ID`、`serviceChains` 与 `tenantAuthHints` 生成缺陷单 `reports/defects/<id>.md`。
   - **D 类（需求歧义）**：**硬阻断改测试**，暂停并向用户确认预期行为。
2. **`aitest_heal(action="attempt")`**（CLI：`heal attempt`）：每轮仅改定位器后自动校验治理锁 + AST 语义 Diff 守卫 + 隔离局部重跑（写入 `.aitest/heals/<sessionId>/attempt-<n>-results.json`，不污染全局 `reports/results.json`）；一旦检测到断言弱化或用尽 3 轮即熔断升级。
3. **`aitest_heal(action="conclude")`**（CLI：`heal conclude`）：归档自愈轨迹，C 类缺陷自动写出工单；`discard` 永久锁死会话防止复活。

---

## 4. 历史抖动率统计与自动隔离区 (`Flaky Quarantine`)

- 每次运行写入 `.aitest/runs/index.jsonl`，由 `src/flaky.mjs` 滑动统计近 20 次运行抖动率（自动排除已 `concluded(verified)` 自愈修复前的历史失败轮次）。
- 抖动率超标的非关键用例可记入受 T1 MAC 保护的 `.aitest/quarantine.json`（最长 `7 天` TTL 到期自动失效；连续 `5 次` 干净通过自动解除隔离），禁止永久静默跳过。

---

## 5. 一键可信变更判决与 Additive-Only Diff-Impact v3 (`npx ai-test-workbench@6.6.0 verify-change` / `aitest_verify_change`)

一次调用即可串联完整 fail-closed 闭环：
`governance verify` → `Git merge-base` → `Additive-Only Fail-Closed Diff-Impact v3 (Global Infra Guard + pipe-sharded-v1)` → `Playwright Run (Run Ledger)` → `4-Layer Gate Audit` → `Optional Dual-Target Parity (--mode parity)` → `Heal Conflict Check` → `Diagnose & Trace Matrix`。

- **Additive-Only Fail-Closed Diff-Impact v3（`src/impact/global-infra-guard.mjs` + `src/impact/graph-index.mjs` + `src/impact/graph-index-codec.mjs`）**：
  - 变更命中 Spring 全局基础设施（`spring.factories`、`AutoConfiguration.imports`、`WebFilter`、`Interceptor`、`ControllerAdvice`、`WebProperties` 等）或 Vue 全局守卫/未映射全局组件时，无条件回退 `mode: "full"`；
  - 仅在覆盖率达标、hunk 命中明确最内层可调用符号且未触及 `> 65` 调用者 `*HIGH_FAN_IN*` 哨兵时允许符号级收敛，否则一律 Fail-Closed 回退全量；
- **机器可验签证明书（`src/verdict.mjs`）**：`<repo>/qa/.aitest/runs/<runId>/attestation.json`（in-toto Statement v1），自动绑定 **`scope.graphEngine`**（`{ provider, version, binarySha256, mode, usedForNarrowing }`），完整记录选测收敛来源；
- **人类可读判决书与 SARIF**：`<repo>/qa/reports/verdict-summary.md`（显式区分 `local-workbench` 与 `business-e2e` 口径，并附 **内外环交界人工必审焦点卡 `Human Seam Gatekeeper Card`**）与 `<repo>/qa/reports/verdict.sarif.json`。

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
  npx ai-test-workbench@6.6.0 attest verify --file <attestation.json> --bundle <attestation.sigstore.json> --expect-repo <owner/repo> --expect-workflow <workflow-path> --expect-ref <ref>
  ```
- 私有仓库须知：`signer: github-attest`（默认）依赖 GitHub Artifact Attestations（私有仓库需 GitHub Enterprise Cloud）；`signer: cosign` 使用公共 Sigstore 时会将仓库身份写入公开 Rekor 日志。
