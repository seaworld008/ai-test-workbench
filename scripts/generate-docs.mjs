#!/usr/bin/env node
// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOOL_REGISTRY } from '../src/mcp/registry.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, '..');

const BEGIN_RE = /<!--\s*BEGIN:GENERATED_MCP_TOOLS(?:\s+lang="(zh|en)")?\s*-->/;
const END_MARKER = '<!-- END:GENERATED_MCP_TOOLS -->';

/**
 * Target documents carrying auto-generated MCP tool matrices sourced from `TOOL_REGISTRY`.
 */
export const GENERATED_DOC_TARGETS = [
  'README.md',
  'README.en.md',
  'AGENTS.md',
  'AGENTS.en.md',
  'skills/ai-test-workbench/SKILL.md',
  'skills/ai-test-workbench/SKILL.zh-CN.md',
  'skills/ai-test-workbench/references/mcp-server-protocol.md',
  'skills/ai-test-workbench/references/mcp-server-protocol.en.md',
];

const CATEGORY_LABELS = {
  zh: {
    discovery: '发现与初始化',
    verification: '执行与门禁验证',
    stateful: '有状态治理与作业',
  },
  en: {
    discovery: 'Discovery & Setup',
    verification: 'Verification & Gates',
    stateful: 'Stateful Control',
  },
};

/**
 * Renders the canonical MCP tool matrix directly from live `TOOL_REGISTRY`.
 * @param {'zh' | 'en'} lang
 * @returns {string}
 */
export function renderMcpToolsTable(lang = 'en') {
  const isZh = lang === 'zh';
  const header = isZh
    ? '| 工具名称 | 类别 | 只读提示 | 职责摘要 |'
    : '| Tool Name | Category | Read-Only Hint | Responsibility |';
  const sep = '|---|---|---|---|';
  const catMap = CATEGORY_LABELS[isZh ? 'zh' : 'en'];

  const rows = TOOL_REGISTRY.map((entry) => {
    const cat = catMap[entry.category] || entry.category;
    const ro = entry.annotations.readOnlyHint ? (isZh ? '是' : 'Yes') : (isZh ? '否' : 'No');
    const summary = entry.title.replace(/\|/g, '\\|');
    return `| \`${entry.name}\` | ${cat} | ${ro} | ${summary} |`;
  });

  const footnote = isZh
    ? `\n> 自动生成自 \`src/mcp/registry.mjs\`（共 \`${TOOL_REGISTRY.length}\` 个权威工具；\`governance approve\` 仅限人类本地 CLI，永不注册为 MCP 工具；6 个 v5 旧名 \`aitest_heal_*\` / \`aitest_job_*\` 在 v6.x 中作为弃用转发别名保留）。`
    : `\n> Auto-generated from \`src/mcp/registry.mjs\` (\`${TOOL_REGISTRY.length}\` canonical tools; \`governance approve\` is human-CLI-only and never registered; 6 v5 names \`aitest_heal_*\` / \`aitest_job_*\` remain as deprecated forwarding aliases in v6.x).`;

  return [header, sep, ...rows].join('\n') + '\n' + footnote;
}

/**
 * Synchronizes or verifies all auto-generated MCP tool tables across active docs.
 * @param {{ rootDir?: string, checkOnly?: boolean }} [options]
 */
export function syncGeneratedDocs(options = {}) {
  const rootDir = options.rootDir || REPO_ROOT;
  const checkOnly = Boolean(options.checkOnly);
  /** @type {string[]} */
  const updated = [];
  /** @type {string[]} */
  const drifted = [];
  /** @type {string[]} */
  const missingMarkers = [];

  for (const rel of GENERATED_DOC_TARGETS) {
    const full = path.join(rootDir, rel);
    if (!fs.existsSync(full)) {
      missingMarkers.push(`${rel} (file missing)`);
      continue;
    }
    const raw = fs.readFileSync(full, 'utf8');
    const beginMatch = BEGIN_RE.exec(raw);
    const endIdx = raw.indexOf(END_MARKER);
    if (!beginMatch || endIdx === -1 || endIdx < beginMatch.index) {
      missingMarkers.push(`${rel} (missing BEGIN/END:GENERATED_MCP_TOOLS markers)`);
      continue;
    }

    const lang = beginMatch[1] === 'zh' ? 'zh' : beginMatch[1] === 'en' ? 'en' : rel.endsWith('.en.md') || rel.endsWith('SKILL.md') ? 'en' : 'zh';
    const openTag = beginMatch[0];
    const generatedBlock = `${openTag}\n${renderMcpToolsTable(lang)}\n${END_MARKER}`;
    const next = raw.slice(0, beginMatch.index) + generatedBlock + raw.slice(endIdx + END_MARKER.length);

    if (next !== raw) {
      if (checkOnly) {
        drifted.push(rel);
      } else {
        fs.writeFileSync(full, next, 'utf8');
        updated.push(rel);
      }
    }
  }

  return {
    ok: drifted.length === 0 && missingMarkers.length === 0,
    updated,
    drifted,
    missingMarkers,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const checkOnly = process.argv.includes('--check');
  const res = syncGeneratedDocs({ checkOnly });
  if (!res.ok) {
    if (res.missingMarkers.length > 0) {
      console.error(`[Docs Generate FAILED] Missing markers: ${res.missingMarkers.join(', ')}`);
    }
    if (res.drifted.length > 0) {
      console.error(`[Docs Generate DRIFT] Out-of-date generated MCP tables in: ${res.drifted.join(', ')}. Run "npm run docs:sync".`);
    }
    process.exit(1);
  }
  console.log(
    checkOnly
      ? `[Docs Generate OK] All ${GENERATED_DOC_TARGETS.length} generated MCP tool tables match src/mcp/registry.mjs (${TOOL_REGISTRY.length} tools).`
      : `[Docs Generate] Synced ${res.updated.length}/${GENERATED_DOC_TARGETS.length} file(s) (${TOOL_REGISTRY.length} canonical tools).`
  );
}
