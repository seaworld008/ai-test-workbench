import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveQaDirectory } from './agents.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILL_SRC_DIR = path.resolve(__dirname, '..', 'skills', 'ai-test-workbench');

/**
 * Verified project-scoped skill paths per official documentation:
 * - Claude Code: `<repo>/.claude/skills/ai-test-workbench/`
 * - Codex CLI:   `<repo>/.codex/skills/ai-test-workbench/` (or cross-agent `<repo>/.agents/skills/ai-test-workbench/`)
 * - QA-isolated: `<repo>/qa/skills/ai-test-workbench/` (default zero-root-footprint mode)
 */
export function resolveSkillDestination(targetDir, client = 'qa', qaDirName = 'qa') {
  const root = path.resolve(targetDir);
  switch (String(client).toLowerCase()) {
    case 'claude':
      return path.join(root, '.claude', 'skills', 'ai-test-workbench');
    case 'codex':
      return path.join(root, '.codex', 'skills', 'ai-test-workbench');
    case 'agents':
      return path.join(root, '.agents', 'skills', 'ai-test-workbench');
    case 'qa': {
      const qaDir = resolveQaDirectory(root, qaDirName) || path.join(root, qaDirName);
      return path.join(qaDir, 'skills', 'ai-test-workbench');
    }
    default:
      throw new Error(`Unsupported --client "${client}". Allowed: qa, codex, claude, agents.`);
  }
}

export async function runSkillInstallCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  if (!options.target) {
    console.error(lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option');
    return 1;
  }
  if (!fs.existsSync(SKILL_SRC_DIR)) {
    console.error(`Bundled skill source missing: ${SKILL_SRC_DIR}`);
    return 1;
  }

  const client = options.client || 'qa';
  const destDir = resolveSkillDestination(options.target, client, options.qaDir);
  const dryRun = Boolean(options.dryRun);
  const force = Boolean(options.force);

  if (fs.existsSync(destDir) && !force) {
    console.log(
      lang === 'zh'
        ? `[PRESERVED] 技能目录已存在 (${destDir})。如需覆盖更新请传 --force。`
        : `[PRESERVED] Skill directory already exists (${destDir}). Pass --force to overwrite.`
    );
    return 0;
  }

  if (dryRun) {
    console.log(`[DRY-RUN] Would copy skill "${SKILL_SRC_DIR}" -> "${destDir}"`);
    return 0;
  }

  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(SKILL_SRC_DIR, destDir, { recursive: true, force: true });
  console.log(
    lang === 'zh'
      ? `[OK] 已安装 ai-test-workbench 技能到: ${destDir}`
      : `[OK] Installed ai-test-workbench skill to: ${destDir}`
  );
  return 0;
}
