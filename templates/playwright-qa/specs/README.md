# 测试计划目录 (`specs/`) — `__PROJECT_NAME__`

> [English Version](./README.en.md)

本目录用于存放 Playwright **Planner** Agent 生成（或由 `npx ai-test-workbench@6.4.0 explore` 巡检汇总 `system-overview.md`）的人类可评审 Markdown 测试计划；评审通过后再交给 **Generator** 编写可执行 TypeScript 用例。

## 每份测试计划必备章节

1. **范围与需求关联**：Issue/PRD 链接与目标环境。
2. **测试角色与前置条件**：专用 QA 账号角色与 Seed 状态（`tests/seed.spec.ts`）。
3. **测试场景清单**：
   - 优先级标记（`@critical`、`@smoke`、常规）
   - 写接口标记（改动服务端数据时务必标 `@mutation`）
   - 确定性操作步骤与 **用户可见断言 / API 契约断言**
   - 负向用例、RBAC 权限隔离与 `0/1` 边界用例
   - 数据清理 / 重置策略
4. **待确认问题 (Open Questions)**：需求歧义必须显式单列，严禁猜想或把已有 Bug 当作正常预期。
