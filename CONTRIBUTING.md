# 参与贡献指南 (`CONTRIBUTING.md`)

> [English Version](./CONTRIBUTING.en.md) · [行为准则](./CODE_OF_CONDUCT.md) · [安全策略](./SECURITY.md)

感谢你共同建设 AI Agent 优先、确定性可信赖的自动化测试基础设施！

## 核心工程准则

1. **确定性底座优先，AI 负责加速**：绝不为了“让 AI 跑通”牺牲测试确定性。用例必须采用语义定位器（`getByRole`、`getByLabel`、`getByTestId`）、Web-First 断言与严格数据隔离。
2. **零假绿容忍**：
   - 严禁使用 `test.skip`、`test.fixme` 或削弱断言掩盖真实产品回归。
   - 所有用例必须包含真实断言，并通过 `npx ai-test-workbench@6.2.0 audit --check-specs` 与 `--diff-base` 门禁。
3. **跨平台零壳安全执行**：
   - CLI 与 MCP 服务端模块使用纯 Node.js ESM（`>=22.12`），主包保持零第三方运行时依赖。
   - 禁止在子进程中使用 `shell: true` 或拼接命令字符串；在 `stdio` MCP 模式下严禁向系统 FD 1 (`stdout`) 输出非 JSON-RPC 内容。
4. **文档双语同步与去敏**：
   - 本仓库默认文档为简体中文 `.md`，所有核心说明文档须同时维护对应的 `.en.md` 英文版，且严禁提交任何内网域名、凭据、手机号或本机绝对路径。

## 本地开发与自检命令

```bash
node tools/aitest.mjs doctor
npm run lint:docs
npm test
npm run smoke
npm run demo:verify
```

## Pull Request 检查清单

- [ ] `npm run lint:docs`、`npm test`、`npm run smoke` 全部零错误通过。
- [ ] 新增 CLI / MCP 参数同步更新 `--help`、`src/i18n.mjs`（`zh` 与 `en`）及对应中英文档。
- [ ] 不含任何硬编码本机路径、真实凭据、内网测试环境信息或 `.env` 文件。
