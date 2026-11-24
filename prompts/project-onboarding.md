# 新项目隔离接入提示词 (`project-onboarding.md`)

> [English Version](./project-onboarding.en.md)

请将以下业务仓库安全接入 `ai-test-workbench`：

- **目标仓库路径**：`<repo-path>`
- **技术栈**：`<Next.js | Vue/H5 | React | Java/Spring | PHP/ThinkPHP>`
- **白名单测试服/本机 URL**：`<url 或留空先仅跑离线 Smoke>`

## 必须步骤
1. 只读检查 `<repo-path>` Git 状态与现有 QA 目录，绝不篡改业务构建脚本。
2. 预览初始化计划：
   `npx ai-test-workbench@5.1.0 init --name <slug> --target "<repo-path>" --loop codex --dry-run`
3. 正式初始化隔离 `qa/`、安装依赖与 Chromium，并调用 `aitest_map_sync` 生成初版 `SYSTEM_MAP.md` 与 `impact-map.json`。
4. 执行离线 Smoke 与三层门禁：
   `npx ai-test-workbench@5.1.0 run --target "<repo-path>" --suite smoke --audit`
5. 严格分别汇报 **「本机工作台验收结果」** 与 **「业务 E2E 就绪度」**。
