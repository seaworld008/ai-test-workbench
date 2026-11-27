# 从 0 到 1 只读探索与系统全景图提示词 (`specs/system-overview.md`)

> [English Version](./00-explore-and-atlas.en.md) · [AI Agent 快速上手](../docs/ai-agent-quickstart.md)

当你接手一个陌生或 AI 高速迭代生成的 Web/SaaS 系统时，在编写深度 E2E 用例前先执行以下 0→1 探索步骤：

## 执行步骤
1. 检查登录态或引导用户运行 `npx ai-test-workbench@6.7.0 auth-login` / 调用 `aitest_explore`（CLI：`npx ai-test-workbench@6.7.0 explore --target <repo> --base-url <TEST_BASE_URL>`）。
2. 检查系统是否存在 **多端视角 / 租户或组织切换器**（如顶栏/抽屉/Vuex/Redux 中的平台端与租户工作台切换器）。务必分别探索默认入口与至少一个核心业务子工作台！
3. 在严格只读护栏下（`TEST_ALLOW_MUTATION=0` —— 严禁新增/编辑/删除/支付/发短信/状态切换写入），完整记录所有发现路由：
   - 路由路径与面包屑
   - 页面原型（`auth-portal`、`dashboard`、`crud-table`、`form-config`）
   - 筛选条件、表格列头、标签页与分页总数
   - 已有控制台报错、重复并发慢接口、脱敏后 URL 异常参数与 WCAG/Landmark 缺失
4. 产出与融合：
   - `reports/system-topology.json`（已脱敏 PII 的结构化 JSON）
   - `specs/system-overview.md`（系统全景画像与测试蓝图）
   - 调用 `aitest_map_sync` 同步至 `knowledge/SYSTEM_MAP.md`
5. 若切换端或租户导致凭证失效则立即暂停报告；**如实报告已有系统缺陷，绝不把坏现象写成正确预期。**
