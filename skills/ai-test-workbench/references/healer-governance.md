# 有状态 Healer 自愈治理与 `S0–S5` 零假绿协议 (`v6.0.0`)

> [English Version](./healer-governance.en.md) · [SKILL.md](../SKILL.md) · [四层门禁详情](../../../docs/governance.md)

> **工具强执覆盖条款**：Playwright 官方默认 Healer 提示词包含“若持续失败则改标 `test.fixme()`”。在 `ai-test-workbench v6.0.0` 中，不仅 `test.fixme()` / `test.skip()` 被阻断，**任何降低断言强度、篡改配置文件、添加 `test.fail()` / `expect.soft()` 或对 B/C/D 类故障修改测试的行为均由工具状态机直接拦截（`FGER = 0.0%`）**。

## 1. 有状态自愈会话强制工作流 (`npx ai-test-workbench@6.0.0 heal` / `aitest_heal`)

修改任何 `tests/**` 文件前，必须先启动受控自愈会话：

| 分类 | 根因性质 | `aitest_heal(action="begin")` 工具裁决 | 允许动作 | 禁止动作（工具直接阻断） |
|---|---|---|---|---|
| **A** | UI 合法调整引起的定位器或等待同步漂移 | `allowedToEditTests: true`（最多 **3 轮** `aitest_heal(action="attempt")`） | 更新语义定位器/Web-First 等待并通过 `S0–S5` 语义 Diff 守卫 | 降低断言强度格、删减 `expect()`、加 `{ force: true }`、`waitForTimeout()`、`expect.soft()` |
| **B** | 环境不可达、鉴权过期、域名或请求守卫阻断 | **硬阻断改测试**（退出码 `2`） | 保留红灯，输出基础设施修复指令或提示人工 `auth-login` | 指向生产环境、裸建 `request.newContext()` |
| **C** | 业务或后端回归缺陷（`5xx`、`pageerror`、Schema 漂移、RBAC 越权、超卖） | **硬阻断改测试**（退出码 `2`），自动生成 `reports/defects/<id>.md` 工单 | 提交含复现步骤与 W3C `Trace-ID` 的缺陷单交研发修业务代码 | 把 `200` 改成 `500`、标 `test.fixme()`/`test.fail()`、`.catch(() => null)` |
| **D** | 需求或验收口径不明确 | **硬阻断改测试**（退出码 `2`） | 暂停修改，向用户确认预期行为 | 凭空猜测业务规则 |

## 2. `S0–S5` 断言强度格与全工作区语义守卫 (`AITEST-G101..G115`)

每次 `aitest_heal(action="attempt")` 与 `aitest_audit(diffBase="HEAD")` 都会检查整个 `qa/`（含未跟踪新文件与受保护配置）：
- **`S5` 精确值断言**（`toHaveText('exact')`、`toEqual`、`toBe(200)`）不得降级为 **`S3` 模糊匹配**、**`S2` 仅可见（`toBeVisible()`）**、**`S1` 弱存在** 或 **`S0` 恒真断言（`expect(true).toBe(true)`）**。
- 严禁篡改 `.aitest/governance.lock` 锁定的 17 项受保护路径（`eslint.config.mjs`、`playwright.config.ts`、`aitest.config.json`、`waivers.json`、`support/**` 等），需经人类运行 `npx ai-test-workbench@6.0.0 governance approve --by <name> --reason "<原因>"`。
