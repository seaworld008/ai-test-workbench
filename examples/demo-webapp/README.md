# 本地自包含演示靶场 (`examples/demo-webapp`)

> [English Version](./README.en.md) · [简体中文主文档](../../README.md)

这是一个**零第三方依赖**的本地智能校园选课 Web 应用靶场，用于在无外网/无测试服条件下端到端验证 UI E2E、API 契约、`storageState` 鉴权、RBAC 越权拦截（`403`）、重复报名（`409`）与最后 1 个名额并发防超卖（`201 + 409`）。

## 本地启动

```bash
# 默认端口 5899（避开 Vite 4173/5173 默认端口）
node examples/demo-webapp/server.mjs

# 或自动绑定空闲随机端口（--port 0）
node examples/demo-webapp/server.mjs --port 0
```

## 接口与页面说明

| 方法与路径 | 用途 |
|---|---|
| `GET /` | 符合语义化与 WCAG 标准的课程检索页（含已售罄禁用按钮与搜索过滤） |
| `GET /login` | 语义化登录页 |
| `POST /api/login` | 为 `student_*` / `admin_qa` 签发 Bearer 会话凭证 |
| `GET /api/courses` | 返回课程列表 JSON（包含 `10` 名额、`1` 名额与 `0` 名额边界样本） |
| `POST /api/enroll` | 学生选课，严格阻断重复报名（`409`）与超卖（`409`） |
| `GET /admin`, `GET /api/admin/audit` | 对学生 Token 严格返回 `403 Forbidden` |
| `POST /__test__/reset` | 仅允许本机回环（`127.0.0.1`）重置内存测试夹具数据 |
