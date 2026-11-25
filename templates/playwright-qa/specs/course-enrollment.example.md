# 测试计划示例：通用业务工作流、权限隔离与并发幂等 (`course-enrollment.example.md`)

> [English Version](./course-enrollment.example.en.md)

- **项目**：`__PROJECT_NAME__`
- **目标**：白名单本地或测试服环境（`TEST_BASE_URL`）
- **Seed 用例**：`tests/seed.spec.ts`（`--project=seed`）
- **说明**：通用项目请根据实际业务域替换下方 `REQ-*` ID、路由与断言。

## 测试场景

### 1. [REQ-CORE-001] 核心列表检索、状态约束与自动化无障碍扫描 (`@critical @a11y`，只读)
- **角色**：已认证标准用户（复用 `auth.setup.ts` 生成的 `storageState`）
- **步骤**：
  1. 导航至目标业务首页或核心工作区路由。
  2. 调用 `expectAccessible(page)` 执行 WCAG 2.0/2.1/2.2 A/AA 机器可检规则扫描。
  3. 触发过滤检索，验证不可用/受限操作控件状态。
- **预期结果**：
  - 匹配条目可见；不可执行操作控件保持禁用态（`toBeDisabled()`）。
  - 零未捕获 `pageerror` 与同源 `5xx` 响应。

### 2. [REQ-RBAC-001] 角色权限边界隔离 (`@critical`，只读)
- **角色**：低权限标准用户
- **步骤**：浏览器访问受限管理页面（如 `/admin`），并使用标准用户凭据请求受保护管理接口。
- **预期结果**：均严格返回 HTTP `403` 且响应体与 DOM 均不泄露特权数据。

### 3. [REQ-MUTATE-001] 重复提交幂等性与并发竞态守卫 (`@mutation`，仅限开启写权限的隔离环境)
- **前置条件**：本地回环默认允许写验证，或测试服显式配置 `TEST_ALLOW_MUTATION=1`。
- **步骤**：重置隔离测试数据，连续提交两次相同业务写请求，并使用 `Promise.all` 并发抢占有限配额资源。
- **预期结果**：重复提交返回 `409` 或预期业务冲突码；并发竞态严格最多 1 次成功，零超额/脏写。
