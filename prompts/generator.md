# Generator 确定性测试生成提示词 (`tests/e2e/*.spec.ts` & `tests/api/*.spec.ts`)

> [English Version](./generator.en.md)

请在 `<repo>/qa/` 目录内启动官方 Playwright **Generator** Agent，对照下列上下文生成强类型测试代码：

- **已评审测试计划**：`specs/<module>.md`
- **前置 Seed 用例**：`tests/seed.spec.ts`

## 硬性编码规范
1. 一律从 `../fixtures/base` 导入 `{ test, expect, expectAccessible, expectApiContract, expectPerformanceBudget }`。
2. 优先使用 `getByRole`、`getByLabel`、`getByTestId`、`toMatchAriaSnapshot()` 与 Web-First 断言；循环/多路由辅助逻辑封装在 `tests/fixtures/` 中。
3. **严禁**出现 `waitForTimeout()`、`.only()`、`test.skip()`、`test.fixme()`、`{ force: true }`、空断言或测试块内 `if/else`。
4. 修改服务端状态的用例必须打 `@mutation` 标签，并做好并发 worker 间测试数据隔离。
5. 写完立即运行 `npm run typecheck && npm run lint`，并通过 `aitest_run(suite="e2e", audit=true)` 或 `npx ai-test-workbench@5.1.1 run --target .. --suite e2e --audit` 验证。
