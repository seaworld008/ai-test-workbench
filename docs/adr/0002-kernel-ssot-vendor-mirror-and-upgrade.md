# ADR-0002：验证内核单源归位（`src/kernel/`）、确定性镜像同步与 `upgrade` 迁移机制

> [English Version](./0002-kernel-ssot-vendor-mirror-and-upgrade.en.md) · [简体中文主文档](../../README.md) · [架构设计](../../ARCHITECTURE.md)

- **状态**：已采纳（Accepted，落地于 `v6.0.0`）
- **决策日期**：`2026-11-24`

---

## 1. 背景与问题陈述

在 `v5.x` 中，四层防假绿内核、目标安全守卫与 JSON Schema 校验器全部存放在脚手架目录 `templates/playwright-qa/support/` 下，根包 14 处 `src/` 与 `scripts/` 模块反向 `import '../templates/playwright-qa/support/...'`。这一依赖方向倒置导致：

1. 架构分层反转：主程序依赖会被复制到用户仓库的脚手架模板；
2. 宿主漂移与升级缺失：用户通过 `init` 复制出去的 `<repo>/qa/support/` 没有版本清单，也缺乏安全升级通道；同时 `doctor.mjs` 因仍按旧单文件扫描正则导致漂移探测失效。

---

## 2. 备选方案对比

| 方案 | 优点 | 缺点与取舍理由 |
|---|---|---|
| **方案 A（采纳）：`src/kernel/` 为唯一权威真源 + `package.json#exports` + 构建期确定性镜像同步 + `aitw upgrade`** | 消除全部 `src -> templates` 反向依赖；用户 `<repo>/qa/` 仍保持零网络独立运行且不破坏 `templates/playwright-qa/package-lock.json`；CI 强检字节一致；`init` 写 `.aitest/template-manifest.json` 支持三方安全升级 | 仓库内保留一份由脚本生成的只读镜像目录，但由 `npm run check:vendor` 在单测与 CI 强执字节一致 |
| **方案 B：用户 `qa/package.json` 直接依赖锁定版本的 `ai-test-workbench` 包** | 模板内无需 `support/` 目录 | 会引发「未发版新版本无法先写入模板 `package-lock.json`」的死锁，且迫使本地/离线 CI 在 `qa/` 内联网拉取工作台自身 |

---

## 3. 最终决策

1. **权威内核归位 `src/kernel/`**：将 `gate-kernel.mjs`、`target-guard.mjs`、`schema-validator.mjs` 及 `gate/**` 迁入 `src/kernel/`，并通过 `package.json#exports` 暴露 `.`、`./kernel`、`./target-guard`、`./schema-validator`。
2. **确定性单向镜像（`scripts/sync-template-vendor.mjs`）**：单向镜像 `src/kernel/**` 及共享 `src/core/{config,glob,outcome,playwright-results,version}.mjs` 至 `templates/playwright-qa/support/`，每份生成文件均加注 `@generated`、`@source-sha256`、`@workbench-version` 头；`test/unit/architecture-boundaries.test.mjs` 与 CI 强制校验 `0` 反向导入且镜像字节一致。
3. **模板清单与三方安全升级（`aitw upgrade`）**：`init` 生成 `<repo>/qa/.aitest/template-manifest.json` 记录各托管文件 SHA-256；新增 `npx ai-test-workbench@6.5.0 upgrade --target <repo>` 对比模板基线与当前文件哈希，未改动文件自动升级，人工改动文件输出 `.aitest-new` 而不静默覆盖，且**绝不自动重签 `governance.lock`**（须由人类执行 `governance approve`）。
4. **修复 `doctor` 漂移检测**：`detectHostGateKernelVersion()` 按优先级读取 `.aitest/template-manifest.json`、`support/core/version.mjs`、`support/gate/engine.mjs` 与旧版单文件，准确汇报版本漂移。

---

## 4. 影响与校验

- `src/` 与 `scripts/` 指向 `templates/` 的导入边从 `14` 降至 `0`；
- `npm run check:vendor` 与 `test/unit/kernel-and-upgrade.test.mjs` 持续守卫镜像同步与三方升级行为。
