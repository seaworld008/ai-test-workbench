# 从 0 到 1 系统探索协议 (`zero-to-one-exploration.md`)

> [English Version](./zero-to-one-exploration.en.md) · [SKILL.md](../SKILL.md)

接入复杂或多租户 Web / SaaS 应用时，按以下 4 阶段标准闭环推进：

## 第一阶段：安全建态 (`auth-login` 或密码环境变量)
- **绝不绕过验证码或短信门禁**；交互式系统运行 `npx ai-test-workbench@6.7.0 auth-login --target <repo> --base-url <url>` 持久化 `user.json` + `session.json`。

## 第二阶段：严格只读 0→1 全站巡检 (`npx ai-test-workbench@6.7.0 explore` / `aitest_explore`)
- 阻断所有 `DELETE`/`PUT`/`PATCH` 与写操作 `POST`（`create/add/save/update/delete/import/pay/sms/approve/submit`）。
- 仅点击只读控件（`搜索`、`查询`、`重置`、`详情`、标签页切换、分页），绝不点击新增/编辑/删除/审核写入。
- **多端 / 多租户切换器检查**：主动探测导航栏、抽屉、Vuex/Redux 中的 `Tenant / Organization / Workspace` 切换器，深入日常业务子工作台而非仅停留在总览端。
- 输出 `reports/system-topology.json`、`specs/system-overview.md` 并同步 `knowledge/SYSTEM_MAP.md`。

## 第三阶段：全景评审 -> 深度功能计划 (`specs/*.md`)
- 重点覆盖：**空态 0-1 检索 + 重置还原**、**分页状态一致性**、**多 Tab 业务筛选**、**只读详情下钻返回**、**跨租户隔离与未登录重定向守卫**。

## 第四阶段：确定性生成、执行与四层防假绿门禁
- 在 `tests/fixtures/` 封装循环助手以满足 `no-conditional-in-test`；执行 `npx ai-test-workbench@6.7.0 run --suite all --audit` 与 `npx ai-test-workbench@6.7.0 audit --check-specs --require-e2e`。
