# 测试计划示例：智慧校园选课系统 (`course-enrollment.example.md`)

> [English Version](./course-enrollment.example.en.md)

- **项目**：`__PROJECT_NAME__`
- **目标**：白名单本地或测试服环境（`TEST_BASE_URL`）
- **Seed 用例**：`tests/seed.spec.ts`（`--project=seed`）

## 测试场景

### 1. [REQ-CATALOG-001] 课程目录搜索与自动化无障碍扫描 (`@critical @a11y`，只读)
- **角色**：已认证学生（复用 `auth.setup.ts` 生成的 `storageState`）
- **步骤**：
  1. 导航至 `/`。
  2. 调用 `expectAccessible(page)` 执行 WCAG 2.0/2.1/2.2 A/AA 机器可检规则扫描。
  3. 在 `"Search courses"` 输入 `"Playwright"` 与 `"Sold Out"` 过滤课程。
- **预期结果**：
  - 匹配课程卡片可见；已售罄课程按钮呈现禁用态（`toBeDisabled()`）。
  - 零未捕获 `pageerror` 与同源 `5xx` 响应。

### 2. [REQ-RBAC-001] 学生 vs 管理员 RBAC 权限隔离 (`@critical`，只读)
- **角色**：学生
- **步骤**：浏览器访问 `/admin`，并用学生 Bearer Token 请求 `GET /api/admin/audit`。
- **预期结果**：均严格返回 HTTP `403`（`403 Forbidden`）且不泄露任何管理员数据。

### 3. [REQ-ENROLL-001] 重复选课与最后 1 名额并发竞态 (`@mutation`，仅限开启写权限的隔离测试服)
- **前置条件**：`TEST_ALLOW_MUTATION=1`。
- **步骤**：重置隔离夹具，同账号连续提交两次报名；并用 `Promise.all` 并发请求 1 名额课程 `course-last-seat`。
- **预期结果**：重复提交返回 `409`；并发竞态严格返回排序 `[201, 409]`，零超卖。
