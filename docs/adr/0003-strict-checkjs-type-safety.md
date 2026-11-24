# ADR-0003：类型安全策略——零构建严格 `JSDoc + checkJs + .d.ts`

> [English Version](./0003-strict-checkjs-type-safety.en.md) · [简体中文主文档](../../README.md) · [架构设计](../../ARCHITECTURE.md)

- **状态**：已采纳（Accepted，落地于 `v6.0.0`）
- **决策日期**：`2026-11-24`

---

## 1. 背景与问题陈述

在 `v5.1.1` 中，`tsconfig.check.json` 关闭了 `strict`、`noImplicitAny` 与 `useUnknownInCatchVariables`，且 `typeRoots` 与 `scripts/run-typecheck.mjs` 反向依赖 `templates/playwright-qa/node_modules/`；同时本机缺少 `tsc` 时静默退出码 `0`。全量开启严格模式暴露出超过 1,000 处未收窄的隐式 `any` 与 `unknown` 异常访问。

---

## 2. 二选一决策对比

| 维度 | 方案 A（采纳）：严格 `JSDoc + checkJs + src/types/*.d.ts`（零构建） | 方案 B（放弃）：迁移 `src/` 至 `.ts` 源码并编译输出 `dist/` |
|---|---|---|
| **构建流水线与源码直跑** | **零构建步骤**，`git clone` 后直接运行 `node tools/aitest.mjs`，所有测试与脚本无需先构建 | 引入编译产物 `dist/`、sourcemap 与构建前后路径维护 |
| **与 `templates/playwright-qa/support/` 镜像关系** | 保持 1:1 可读 ESM 源码镜像，零转译噪音 | 需要转译管线同步生成模板文件 |
| **根包运行时依赖** | `dependencies` 仍为 `{}`，仅 `devDependencies` 锁定 `typescript@6.0.3` 与 `@types/node@26.6.6` | 同等需要开发期 TS 依赖，但改动面扩及 1.4 万行机械迁移 |
| **静态类型保障强度** | `strict: true` + `noImplicitAny: true` + `useUnknownInCatchVariables: true` 全量 0 错误，且单测禁止 `src/**` 出现 `@ts-nocheck`/`@ts-ignore`/`@ts-expect-error` | 与严格 `checkJs` 编译期检查一致 |

---

## 3. 最终决策

1. **选择零构建严格 `checkJs`**：根包 `devDependencies` 精确锁定 `typescript@6.0.3` 与 `@types/node@26.6.6`（`dependencies` 保持为空），解除对模板 `node_modules` 的反向依赖。
2. **全仓开启严格模式**：`tsconfig.check.json` 启用 `strict: true`、`noImplicitAny: true`、`useUnknownInCatchVariables: true`，`typeRoots` 仅指向 `./node_modules/@types`。
3. **全环境 Fail-Closed 门禁**：`scripts/run-typecheck.mjs` 在任何环境下缺失根 `node_modules/typescript/bin/tsc` 均退出码 `2`；`test/unit/architecture-boundaries.test.mjs` 强制禁止 `src/**` 内出现任何 `@ts-nocheck` / `@ts-ignore` / `@ts-expect-error` 抑制指令。

---

## 4. 影响与校验

- 全仓 `58` 个非零错误模块累计 `1,151` 处严格诊断已全部清零至 `0` 错误；
- `npm run typecheck` 在本地与 CI 均严格执行。
