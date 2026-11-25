// @ts-check
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { REPO_ROOT, SCHEMA_VERSIONS, WORKBENCH_VERSION } from './core/version.mjs';
import { GATE_KERNEL_VERSION, isProtectedDiffPath } from './kernel/gate-kernel.mjs';

const TEMPLATE_DIR = path.join(REPO_ROOT, 'templates', 'playwright-qa');

/**
 * Default scope (`kernel`): upgrades vendored verification kernel & audit runner only.
 * Optional scope (`all`): also upgrades scaffolded configs & fixture template (`tests/fixtures/base.ts`)
 * while NEVER touching user `tests/**` specs, `specs/**`, `.env`, `waivers.json`, or `.aitest/governance.lock`.
 */
const KERNEL_SCOPE_RELS = (/** @type {string} */ rel) =>
  rel.startsWith('support/') || rel === 'scripts/audit-results.mjs';

const ALL_UPGRADEABLE_RELS = (/** @type {string} */ rel) =>
  KERNEL_SCOPE_RELS(rel) ||
  rel === 'eslint.config.mjs' ||
  rel === 'playwright.config.ts' ||
  rel === 'tsconfig.json' ||
  rel === 'tests/fixtures/base.ts';

/**
 * @param {string} content
 * @returns {string}
 */
function sha256Normalized(content) {
  return `sha256:${crypto.createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex')}`;
}

/**
 * @param {string} dir
 * @param {string} [base]
 * @param {string[]} [acc]
 * @returns {string[]}
 */
function walkTemplateFiles(dir, base = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', 'playwright-report', 'test-results', 'reports', '.aitest', '.env'].includes(entry.name)) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTemplateFiles(full, base, acc);
    } else if (entry.isFile()) {
      const rel = path.relative(base, full).replace(/\\/g, '/');
      acc.push(rel === 'gitignore' ? '.gitignore' : rel);
    }
  }
  return acc.sort();
}

/**
 * Writes `.aitest/template-manifest.json` recording per-file SHA-256 hashes of scaffolded template files.
 * Enables deterministic 3-way merge upgrades and accurate kernel drift detection in `doctor`.
 * @param {string} qaDir
 * @param {string[]} [managedRels]
 * @returns {{ manifestPath: string, manifest: { schemaVersion: number, workbenchVersion: string, gateKernelVersion: string, updatedAt: string, files: Record<string, string> } }}
 */
export function writeTemplateManifest(qaDir, managedRels) {
  const rels =
    Array.isArray(managedRels) && managedRels.length > 0
      ? [...managedRels].sort()
      : walkTemplateFiles(TEMPLATE_DIR).filter((rel) => KERNEL_SCOPE_RELS(rel) || ALL_UPGRADEABLE_RELS(rel));

  /** @type {Record<string, string>} */
  const files = {};
  for (const rel of rels) {
    const full = path.join(qaDir, ...rel.split('/'));
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      files[rel] = sha256Normalized(fs.readFileSync(full, 'utf8'));
    }
  }

  const manifest = {
    schemaVersion: SCHEMA_VERSIONS.templateManifest,
    workbenchVersion: WORKBENCH_VERSION,
    gateKernelVersion: GATE_KERNEL_VERSION,
    updatedAt: new Date().toISOString(),
    files,
  };

  const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { manifestPath, manifest };
}

/**
 * Reads an existing `.aitest/template-manifest.json` if present and valid.
 * @param {string} qaDir
 * @returns {{ schemaVersion?: number, workbenchVersion?: string, gateKernelVersion?: string, files?: Record<string, string> } | null}
 */
export function readTemplateManifest(qaDir) {
  const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const parsed = /** @type {Record<string, unknown>} */ (JSON.parse(fs.readFileSync(manifestPath, 'utf8')));
    if (!parsed || typeof parsed !== 'object') return null;
    return /** @type {{ schemaVersion?: number, workbenchVersion?: string, gateKernelVersion?: string, files?: Record<string, string> }} */ (
      parsed
    );
  } catch {
    return null;
  }
}

/**
 * Performs a 3-way hash-safe upgrade of vendored kernel/template files inside `<repo>/qa`.
 * - Unmodified files matching the recorded manifest hash are updated in place.
 * - Customized files differing from both manifest and incoming template are NEVER overwritten unless `force: true`;
 *   instead incoming contents are written to `<file>.aitest-new`.
 * - Never auto-approves `.aitest/governance.lock`: surfaces `requiresGovernanceApprove: true` when protected files change.
 * @param {string} qaDir
 * @param {{ dryRun?: boolean, force?: boolean, scope?: 'kernel' | 'all' }} [options]
 */
export function upgradeQaWorkspace(qaDir, options = {}) {
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);
  const scope = options.scope === 'all' ? 'all' : 'kernel';
  const scopeFilter = scope === 'all' ? ALL_UPGRADEABLE_RELS : KERNEL_SCOPE_RELS;

  const prevManifest = readTemplateManifest(qaDir);
  const prevFiles = prevManifest?.files || {};
  const templateRels = walkTemplateFiles(TEMPLATE_DIR).filter(scopeFilter);
  const templateRelSet = new Set(templateRels);

  /** @type {Array<{ action: 'CREATE' | 'UPDATE' | 'UP_TO_DATE' | 'CONFLICT' | 'REMOVE_STALE' | 'KEEP_STALE_CUSTOM', file: string, sidecar?: string }>} */
  const actions = [];
  /** @type {Record<string, string>} */
  const nextManifestFiles = { ...prevFiles };
  let protectedChanged = false;

  for (const rel of templateRels) {
    const srcPath = path.join(TEMPLATE_DIR, ...(rel === '.gitignore' ? ['gitignore'] : rel.split('/')));
    const dstPath = path.join(qaDir, ...rel.split('/'));
    const incomingContent = fs.readFileSync(srcPath, 'utf8');
    const incomingHash = sha256Normalized(incomingContent);

    if (!fs.existsSync(dstPath)) {
      actions.push({ action: 'CREATE', file: rel });
      if (isProtectedDiffPath(rel)) protectedChanged = true;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.writeFileSync(dstPath, incomingContent, 'utf8');
      }
      nextManifestFiles[rel] = incomingHash;
      continue;
    }

    const currentContent = fs.readFileSync(dstPath, 'utf8');
    const currentHash = sha256Normalized(currentContent);

    if (currentHash === incomingHash) {
      actions.push({ action: 'UP_TO_DATE', file: rel });
      nextManifestFiles[rel] = incomingHash;
      continue;
    }

    const prevHash = prevFiles[rel];
    const isAutoGeneratedVendor =
      rel.startsWith('support/') && currentContent.includes('@generated by scripts/sync-template-vendor.mjs');
    const unmodifiedSinceInstall = Boolean(prevHash && prevHash === currentHash);

    if (force || unmodifiedSinceInstall || (!prevManifest && isAutoGeneratedVendor)) {
      actions.push({ action: 'UPDATE', file: rel });
      if (isProtectedDiffPath(rel)) protectedChanged = true;
      if (!dryRun) {
        fs.mkdirSync(path.dirname(dstPath), { recursive: true });
        fs.writeFileSync(dstPath, incomingContent, 'utf8');
      }
      nextManifestFiles[rel] = incomingHash;
    } else {
      const sidecarRel = `${rel}.aitest-new`;
      actions.push({ action: 'CONFLICT', file: rel, sidecar: sidecarRel });
      if (!dryRun) {
        const sidecarPath = path.join(qaDir, ...sidecarRel.split('/'));
        fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
        fs.writeFileSync(sidecarPath, incomingContent, 'utf8');
      }
    }
  }

  // Clean up stale vendored support/* files that existed in previous manifest and were removed upstream
  for (const [oldRel, oldHash] of Object.entries(prevFiles)) {
    if (!oldRel.startsWith('support/') || templateRelSet.has(oldRel)) continue;
    const oldPath = path.join(qaDir, ...oldRel.split('/'));
    if (!fs.existsSync(oldPath)) {
      delete nextManifestFiles[oldRel];
      continue;
    }
    const curHash = sha256Normalized(fs.readFileSync(oldPath, 'utf8'));
    if (force || curHash === oldHash) {
      actions.push({ action: 'REMOVE_STALE', file: oldRel });
      if (isProtectedDiffPath(oldRel)) protectedChanged = true;
      if (!dryRun) {
        fs.rmSync(oldPath, { force: true });
      }
      delete nextManifestFiles[oldRel];
    } else {
      actions.push({ action: 'KEEP_STALE_CUSTOM', file: oldRel });
    }
  }

  const manifestPath = path.join(qaDir, '.aitest', 'template-manifest.json');
  const nextManifest = {
    schemaVersion: SCHEMA_VERSIONS.templateManifest,
    workbenchVersion: WORKBENCH_VERSION,
    gateKernelVersion: GATE_KERNEL_VERSION,
    updatedAt: new Date().toISOString(),
    files: Object.fromEntries(Object.entries(nextManifestFiles).sort(([a], [b]) => a.localeCompare(b))),
  };

  const conflicts = actions.filter((a) => a.action === 'CONFLICT');
  const changedCount = actions.filter((a) => ['CREATE', 'UPDATE', 'REMOVE_STALE'].includes(a.action)).length;

  const manifestUnchanged =
    prevManifest &&
    changedCount === 0 &&
    conflicts.length === 0 &&
    prevManifest.workbenchVersion === WORKBENCH_VERSION &&
    prevManifest.gateKernelVersion === GATE_KERNEL_VERSION &&
    JSON.stringify(prevFiles) === JSON.stringify(nextManifest.files);

  if (!dryRun && !manifestUnchanged) {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify(nextManifest, null, 2) + '\n', 'utf8');
  }

  return {
    ok: conflicts.length === 0,
    dryRun,
    scope,
    qaDir,
    fromVersion: prevManifest?.gateKernelVersion || prevManifest?.workbenchVersion || 'legacy',
    toVersion: WORKBENCH_VERSION,
    changedCount,
    conflictCount: conflicts.length,
    requiresGovernanceApprove: protectedChanged,
    manifestPath,
    actions,
  };
}

/**
 * CLI handler for `aitw upgrade`.
 * @param {{ lang?: 'zh' | 'en', target?: string, qaDir?: string, dryRun?: boolean, force?: boolean, scope?: string, json?: boolean }} [options]
 * @returns {Promise<number>}
 */
export async function runUpgradeCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const target = options.target ? path.resolve(options.target) : null;
  if (!target) {
    console.error(lang === 'zh' ? '缺少必填参数 --target <业务仓库或QA目录路径>' : 'Missing required --target <repo-or-qa-path>');
    return 1;
  }

  const qaDir = resolveQaDirectory(target, options.qaDir);
  if (!qaDir) {
    console.error(lang === 'zh' ? `未在 ${target} 找到 QA 目录` : `QA directory not found at ${target}`);
    return 1;
  }

  const scope = options.scope === 'all' ? 'all' : 'kernel';
  const res = upgradeQaWorkspace(qaDir, {
    dryRun: Boolean(options.dryRun),
    force: Boolean(options.force),
    scope,
  });

  const exitCode = res.ok ? 0 : 1;
  if (!options.json) {
    console.log(
      `\n=== ${lang === 'zh' ? 'AI Test Workbench 模板内核安全升级 (upgrade)' : 'AI Test Workbench Kernel Upgrade'}${res.dryRun ? ' [DRY-RUN]' : ''} ===`
    );
    console.log(`QA Dir: ${res.qaDir} · Scope: ${res.scope} · Version: ${res.fromVersion} -> ${res.toVersion}`);
    for (const act of res.actions) {
      console.log(`  [${act.action}] ${act.file}${act.sidecar ? ` -> ${act.sidecar}` : ''}`);
    }
    if (res.conflictCount > 0) {
      console.warn(
        lang === 'zh'
          ? `\n[CONFLICT] 检测到 ${res.conflictCount} 处本地自定义文件冲突，已写入 *.aitest-new 保留人工修改；确认后可手动合并或使用 --force 覆盖。`
          : `\n[CONFLICT] ${res.conflictCount} customized file(s) preserved; incoming copies written to *.aitest-new. Merge manually or pass --force.`
      );
    }
    if (res.requiresGovernanceApprove) {
      console.log(
        lang === 'zh'
          ? `\n[NEXT] 受保护的内核文件已变更；请在终端由人类审批更新治理锁：\n  npx ai-test-workbench@${WORKBENCH_VERSION} governance approve --target "${target}" --by <你的姓名> --reason "upgrade kernel to v${WORKBENCH_VERSION}"`
          : `\n[NEXT] Protected kernel files changed; a human must approve the governance lock in terminal:\n  npx ai-test-workbench@${WORKBENCH_VERSION} governance approve --target "${target}" --by <your-name> --reason "upgrade kernel to v${WORKBENCH_VERSION}"`
      );
    }
    console.log('');
  }
  return emitCommandResult(
    buildCommandResult({
      tool: 'upgrade',
      outcome: res.ok ? 'pass' : 'fail',
      ok: res.ok,
      exitCode,
      summary: res.ok
        ? `Upgraded QA workspace (${res.scope}: ${res.fromVersion} -> ${res.toVersion})`
        : `Upgrade had ${res.conflictCount} conflict(s); inspect *.aitest-new or pass --force`,
      data: res,
    }),
    { asJson: Boolean(options.json) }
  );
}
