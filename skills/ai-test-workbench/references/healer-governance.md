# Healer 自愈治理与零假绿协议 (`healer-governance.md`)

> [English Version](./healer-governance.en.md) · [SKILL.md](../SKILL.md)

> **关键覆盖条款**：Playwright 官方默认生成的 Healer 提示词中写有“若持续失败则改标 `test.fixme()`”。**在本工作台中，未经 `waivers.json` 有效期豁免而擅自添加 `test.fixme()` 或 `test.skip()` 将被 CI 严格阻断！**

## 1. 强制四分定责 (A / B / C / D)

修改任何 `tests/**` 文件之前，务必结合 `reports/ai-diagnostics.md`、`error-context.md`（ARIA 快照）与 Trace 证据逐条分类：

| 分类 | 根因性质 | 允许动作 | 禁止动作 |
|---|---|---|---|
| **A** | UI 合法调整导致的定位器漂移或等待同步问题 | 修复测试定位器/Web-First 断言后重跑 `aitest_run` 与 `aitest_audit(diffBase="HEAD")` | 删除 `expect()`、加 `{ force: true }` 或加 `waitForTimeout()` |
| **B** | 目标环境不可达、凭据失效、状态未初始化或域名未进白名单 | 保留红灯，明确输出环境/鉴权修复指令 | 把目标改为生产环境或绕过真实测试服 |
| **C** | 业务功能或后端回归缺陷（`5xx`、未捕获 `pageerror`、算错数、RBAC 失效、超卖） | 产出含复现步骤、Trace 路径与 Trace-ID 的缺陷报告交研发修业务代码 | 改写断言迎合错误结果，或标 `test.fixme()` / `test.skip()` |
| **D** | 需求或验收标准不明确 | 暂停修改，请人工澄清预期行为 | 凭空猜测业务规则 |

## 2. 单用例最多 3 轮自愈熔断与 Diff 守卫 (`--diff-base`)

- 单个失败用例最多修复 **3 轮**；超过 3 轮仍失败则回退猜测性改动并升级人工处理。
- 每次脚本修复必须通过 `npx ai-test-workbench audit --target <repo> --check-specs --diff-base HEAD`：拦截净断言减少、新增 `skip/fixme/only`、`{ force: true }`、空 `.catch(() => {})` 与 `>= 60000ms` 超时注水。
