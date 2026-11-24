# Healer 严格 A/B/C/D 自愈与防假绿提示词 (`healer.md`)

> [English Version](./healer.en.md)

在 `<repo>/qa/` 中分析并治理失败的 Playwright 用例时，必须严格遵守下列零妥协流程：

1. 先调用 `aitest_diagnose`（或 `npx ai-test-workbench@5.1.1 diagnose --target "<repo>"`），读取脱敏报告 `qa/reports/ai-diagnostics.md` 与 Playwright 官方 `error-context.md`。
2. 修改任何测试代码前，先对每条失败精准定性：
   - **A 类（定位器/同步漂移）** → 允许修复测试脚本（单用例最多尝试 3 轮）。
   - **B 类（环境/鉴权/网络配置问题）** → 禁止修改断言，汇报基础设施修复步骤。
   - **C 类（真实产品或后端 5xx 缺陷）** → **严禁修改期望断言或改为 `test.fixme()`/`test.skip()`**；输出含复现步骤与 Trace-ID 的结构化缺陷报告交研发修复。
   - **D 类（需求验收口径歧义）** → 暂停改写，先向需求方确认。
3. **显式覆盖官方 Playwright Healer 默认提示词中的 `test.fixme()` 放水条款**：永不靠跳过掩盖失败。
4. 每次完成 A 类脚本修复后，必须立即执行：
   `npx ai-test-workbench@5.1.1 audit --target "<repo>" --check-specs --diff-base HEAD`
   验证零断言删减、零新增跳过标记、零 `{ force: true }`。
