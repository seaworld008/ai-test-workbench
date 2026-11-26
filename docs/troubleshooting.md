# 常见故障与排障速查表 (`troubleshooting.md`)

> [English Version](./troubleshooting.en.md) · [简体中文主文档](../README.md)

| 故障现象 | 首先检查 | 解决原则 |
|---|---|---|
| 浏览器缺失或启动失败 | `cd qa && npx playwright --version`、`npx playwright install chromium` | 保持锁定版本与浏览器缓存一致，禁止关闭 TLS 校验 |
| Windows PowerShell 报 `.cmd` `EINVAL` 或执行策略错误 | `node -v`、`npx ai-test-workbench@6.5.0 doctor` | CLI 直接通过 `process.execPath` 调度 `cli.js`，全程 `shell: false` |
| WSL 已安装但 Windows 提示找不到浏览器 | `which node` vs `where.exe node` | Windows 原生与 WSL 拥有独立的 Node 与 `ms-playwright` 缓存，须分别安装 |
| `init` 报 `qa/` 冲突阻断（退出码 `2`） | `<repo>/qa` 下存在非 Playwright 文件 | 传 `--qa-dir e2e-qa` 在独立目录初始化，绝不强覆原有文件 |
| `update-agents` 退出码 `2` 并提示 `CONFLICT` | `*.aitest-new` 与 `qa/.aitest/agents-manifest.json` | 保留你的手改定义，人工对比合并 `*.aitest-new` 或明确加 `--force` |
| `e2e`/`api` 启动即报 Config Error | `qa/.env` 中 `TEST_BASE_URL` 与 `TEST_ALLOWED_HOSTS` | 在线套件禁止未配 URL 静默 skip；配置测试服或改跑 `--suite smoke` |
| `stdio` MCP 客户端解析 JSON 失败 | 确认版本号为 v4.0+、不要在 `mcp-serve` 前打印调试内容 | v4.0 通过 `AITEST_MCP_CAPTURED_STDIO=1` 自动隔离控制台与子进程 stdout |
| MCP HTTP 模式返回 `403` 或 `401` | 请求头 `Origin` 与 `Authorization: Bearer ...` | 将前端 Origin 加入 `AITEST_MCP_ALLOWED_ORIGINS` 或传匹配 `--auth-token` |
| 自定义断言函数被 ESLint `expect-expect` 误报 | `qa/aitest.config.json` -> `assertFunctionNames` | 用 `expect*`/`assert*`/`verify*` 命名辅助函数或在配置白名单登记 |
| Jenkins Docker 提示浏览器版本不匹配 | `Jenkinsfile` 镜像标签 vs `qa/package-lock.json` | 严格对齐 `mcr.microsoft.com/playwright:v1.65.1-noble` |
