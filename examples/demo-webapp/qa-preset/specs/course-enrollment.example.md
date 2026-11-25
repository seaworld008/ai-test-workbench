# Smart Campus 选课、权限与并发竞态测试计划 (`course-enrollment.example.md`)

> [English Version](./course-enrollment.example.en.md)

- **项目**：`__PROJECT_NAME__`
- **目标**：Smart Campus 本地或测试服靶场（`TEST_BASE_URL`）
- **Seed 用例**：`tests/seed.spec.ts`（`--project=seed`）

## 测试场景

### 1. [REQ-CATALOG-001] 课程目录检索、售罄边界与自动化无障碍扫描 (`@critical @a11y`，只读)
- **角色**：已认证学生（复用 `auth.setup.ts` 生成的 `storageState`）
- **步骤**：
  1. 导航至 `/` 并校验 `GET /api/courses` JSON Schema 契约（含 `seatsLeft === 0` 售罄边界条目）。
  2. 调用 `expectAccessible(page)` 执行 WCAG 2.0/2.1/2.2 A/AA 机器可检规则扫描。
  3. 触发课程搜索过滤，验证售罄按钮保持禁用态（`toBeDisabled()`）。
- **预期结果**：
  - 匹配课程可见；售罄按钮严格禁用；零未捕获 `pageerror` 与同源 `5xx` 响应。

### 2. [REQ-RBAC-001] 学生角色权限边界隔离 (`@critical`，只读)
- **角色**：普通学生账号
- **步骤**：浏览器访问 `/admin` 页面，并使用学生 Token 调用 `GET /api/admin/audit`。
- **预期结果**：均严格返回 HTTP `403` 且响应体与 DOM 均不泄露特权管理数据。

### 3. [REQ-ENROLL-001] 重复选课幂等性与最后一席并发竞态 (`@mutation`，隔离靶场)
- **前置条件**：本地回环默认允许写验证，或测试服显式配置 `TEST_ALLOW_MUTATION=1`。
- **步骤**：调用 `/__test__/reset` 重置靶场状态，连续两次提交同一课程选课，并对仅剩 1 席的课程发起 `Promise.all` 并发请求。
- **预期结果**：重复选课严格返回 `409`；并发抢课严格返回 `[201, 409]`，零超卖。
