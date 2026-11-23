# 定位器、断言、无障碍与契约编写规范 (`locator-and-assertion-rules.md`)

> [English Version](./locator-and-assertion-rules.en.md) · [SKILL.md](../SKILL.md)

## 1. 一律继承扩展基础 Fixture (`../fixtures/base`)

```ts
import { test, expect, expectAccessible, expectApiContract, expectPerformanceBudget } from '../fixtures/base';
```

继承后自动开启：同源 `>= 500` 接口阻断、未捕获 `pageerror` 阻断、`TEST_DENIED_ORIGINS` / `TEST_BLOCKED_ENDPOINTS` 双通道拦截，以及失败时分布式 Trace-ID 被动收集。

## 2. 高稳定性语义定位器优先级

1. `page.getByRole('button', { name: 'Enroll' })` —— 首选无障碍角色与可访问名称。
2. `page.getByLabel('Search courses')` —— 表单输入统一按关联 Label 定位。
3. `page.getByTestId('course-row-101')` —— 无语义或重复表格行使用稳定的 `data-testid`。
4. **避免**：深层 CSS 选择器链（`.app > div:nth-child(3) > button`）、随机 utility 类名或脆弱 XPath。

## 3. 结构化 ARIA 快照、自动化无障碍与自定义断言命名

- 优先用 `toMatchAriaSnapshot(...)` 校验组件可访问树结构，替代易碎像素截图。
- 关键业务页面调用 `await expectAccessible(page)` 扫描机器可检 WCAG 2.2 A/AA 问题（注：自动化扫描不等同于完整人工合规认证）。
- Page Object 中的断言封装函数以 `expect`、`assert` 或 `verify` 开头命名（或在 `qa/aitest.config.json` 登记），以通过 `eslint-plugin-playwright`（`playwright/expect-expect`）静态门禁。
