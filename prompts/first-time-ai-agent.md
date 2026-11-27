# 首次接入 AI Agent 复制即用提示词 (`first-time-ai-agent.md`)

> [English Version](./first-time-ai-agent.en.md) · [AI Agent 快速上手](../docs/ai-agent-quickstart.md)

当你第一次把 `ai-test-workbench` 接入一个新项目（或首次向 AI 对话框下达测试任务）时，直接复制下面这段话给你的 AI Agent（Claude Code / Codex CLI / Cursor / Copilot / Gemini CLI / Antigravity）：

---

## 模板一：新/老项目首次一键接入并建立自动化测试底座

```text
请优先使用 `ai-test-workbench` MCP 工具（如未连上 MCP，则通过 `npx ai-test-workbench@6.6.0 <cmd> --json`）帮我为当前项目完成首次自动化测试工作台接入：
1. 调用 `aitest_doctor` 核验 Node >= 22.12 与 Chromium 浏览器缓存状态；
2. 陌生本地回环项目可直接调用 `aitest_bootstrap` 一键探测服务并初始化隔离 `qa/`（或先传 `dryRun: true` 调用 `aitest_init` 预览宿主 tsconfig/eslint 冲突提示）；
3. 调用 `aitest_verify_change`（或 `aitest_run(suite="smoke", audit=true)`）验证离线 Smoke 与四层防假绿门禁是否全部通过；
4. 调用 `aitest_map_sync` 扫描项目代码路由、接口与数据库模型，生成初版活体代码知识地图 `qa/knowledge/SYSTEM_MAP.md`；
5. 最后严格区分「本机工作台验收」与「真实业务 E2E 验收」，向我汇报当前已就绪能力与下一步需要提供的测试环境参数。
```

---

## 模板二：面对陌生多端 SaaS 系统（先探索再测试）

```text
请先对测试环境（`<TEST_BASE_URL>`）执行从 0 到 1 的只读探索后再编写深度测试用例：
1. 如果系统存在短信验证码、企业 SSO 或扫码登录，请提醒我在终端运行 `npx ai-test-workbench@6.6.0 auth-login --target . --base-url <TEST_BASE_URL>` 由我手工登录并保存会话（绝不绕过验证码）；
2. 登录就绪后调用 `aitest_explore(target=".", baseUrl="<TEST_BASE_URL>", maxPages=30)` 严格只读巡检所有端/租户工作台切换器、页面原型、筛选列与异常接口；
3. 调用 `aitest_map_sync` 融合源代码与运行态输出 `SYSTEM_MAP.md`，并按 P0/P1 分层编写 `qa/specs/` 测试计划，涵盖空态边界、分页状态、多租户隔离与已发现问题（绝不把旧 Bug 写成正常预期）。
```
