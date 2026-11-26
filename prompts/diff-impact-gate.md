# Diff-Impact 变更快速反馈提示词 (`diff-impact-gate.md`)

> [English Version](./diff-impact-gate.en.md)

在 `<repo>` 完成功能代码修改后，运行精准受影响范围回归以加速本地/PR 反馈：

```bash
npx ai-test-workbench@6.4.0 impact --target "<repo>" --base origin/main
npx ai-test-workbench@6.4.0 run --target "<repo>" --suite impact --base origin/main --audit
```

（如通过 MCP 连接，直接依次调用 `aitest_impact` 与 `aitest_run(suite="impact", base="origin/main", audit=true)`。）

注意原则：
- 当修改文件能清晰匹配 `qa/impact-map.json`（含 `npx ai-test-workbench@6.4.0 map` 自动生成规则）或用例依赖图（`--only-changed`）时，`impact` 仅跑受影响 Spec 与基础 Smoke。
- 一旦涉及共享基础设施、认证/路由公共文件或未映射源码文件，`impact` 会刻意安全回退到全量套件。
- 合并主干、Nightly 与正式发布门禁必须执行全量 `--suite all --audit`。
