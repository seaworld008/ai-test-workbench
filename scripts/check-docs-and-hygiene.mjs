import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

// Dynamically assembled forbidden tokens so this script never triggers itself
const FORBIDDEN_PATTERNS = [
  ['internal_brand_a', new RegExp(['jin', 'ling'].join(''), 'i')],
  ['internal_domain_a', new RegExp(['scm', 'ssaas'].join(''), 'i')],
  ['internal_gw_a', new RegExp(['jw', 'xt'].join(''), 'i')],
  ['internal_brand_cn', /\u91d1\u9f84/],
  ['internal_tenant_cn', /\u8001\u5e74\u5927\u5b66/],
  ['internal_person_cn', /\u5f90\u6d77\u6d0b/],
  ['internal_phone', new RegExp(['136', '6720', '2199'].join(''))],
  ['internal_proj_b', new RegExp(['sky', 'aiapp'].join(''), 'i')],
  ['win_user_path', new RegExp(['C:', 'Use' + 'rs', ''].join('\\\\'), 'i')],
  ['win_workspace_path', new RegExp(['E:', ['AI', 'codex'].join('-')].join('\\\\'), 'i')],
  ['mac_admin_path', new RegExp(['/Use' + 'rs', 'admin'].join('/'), 'i')],
];

const SPECIAL_EN_PAIRS = {
  'Playwright Test Agents + Codex 可复用本机 AI 自动化测试工作台——架构设计与实施提示词.md':
    'docs/architecture-and-prompts-blueprint.en.md',
};

const CHINESE_CHAR_RE = /[\u4e00-\u9fff]/;

function listRepoFiles(rootDir) {
  try {
    const out = execFileSync(
      'git',
      ['-c', 'core.quotePath=false', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: rootDir, encoding: 'utf8' }
    );
    const list = out.split('\0').filter(Boolean);
    if (list.length > 0) return list;
  } catch {
    // Fallback walk if not inside a git repo (e.g. unit tests in temp dirs)
  }

  const collected = [];
  const walk = (dir, rel = '') => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (['.git', '.sandbox', 'node_modules', 'playwright-report', 'reports', 'test-results'].includes(entry.name)) {
        continue;
      }
      const nextRel = rel ? `${rel}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, nextRel);
      else collected.push(nextRel);
    }
  };
  walk(rootDir);
  return collected;
}

function stripMarkdownFences(mdText) {
  return String(mdText || '').replace(/```[\s\S]*?```/g, '');
}

function shouldEnforceBilingualPair(relPath) {
  const norm = relPath.replace(/\\/g, '/');
  if (!norm.endsWith('.md') || norm.endsWith('.en.md')) return false;
  if (norm === 'CLAUDE.md') return false;
  if (norm.startsWith('.github/')) return false;
  if (norm === 'skills/ai-test-workbench/SKILL.md' || norm === 'skills/ai-test-workbench/SKILL.zh-CN.md') {
    return false;
  }
  return true;
}

function validateRelativeLinks(rootDir, relPath, mdText, errors) {
  const cleaned = stripMarkdownFences(mdText);
  const linkRe = /(?<!!)\[[^\]]+\]\(([^)]+)\)/g;
  const baseDir = path.dirname(path.join(rootDir, relPath));

  for (const m of cleaned.matchAll(linkRe)) {
    const rawHref = m[1].trim().split(/\s+/)[0];
    if (
      !rawHref ||
      rawHref.startsWith('#') ||
      /^(https?:|mailto:|aitest:\/\/|vscode:|cursor:)/i.test(rawHref)
    ) {
      continue;
    }
    const noHash = rawHref.split('#')[0];
    if (!noHash) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(noHash);
    } catch {
      decoded = noHash;
    }
    const targetPath = path.resolve(baseDir, decoded);
    if (!fs.existsSync(targetPath)) {
      errors.push(`[Broken Link] ${relPath} -> (${rawHref}) does not exist on disk.`);
    }
  }
}

export function checkDocsAndHygiene(rootDir = DEFAULT_REPO_ROOT) {
  const files = listRepoFiles(rootDir);
  const errors = [];
  const checkedMd = [];
  let hygieneScanned = 0;

  for (const rawRel of files) {
    const rel = rawRel.replace(/\\/g, '/');
    const fullPath = path.join(rootDir, rel);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;

    if (/\.(md|mjs|ts|js|json|yml|yaml|txt|example)$/i.test(rel) || rel === 'templates/playwright-qa/gitignore') {
      const content = fs.readFileSync(fullPath, 'utf8');
      hygieneScanned += 1;

      for (const [label, pat] of FORBIDDEN_PATTERNS) {
        if (pat.test(content)) {
          errors.push(`[Hygiene Violation:${label}] Found restricted pattern in ${rel}`);
        }
      }

      if (rel.endsWith('.md')) {
        checkedMd.push(rel);
        validateRelativeLinks(rootDir, rel, content, errors);

        if (shouldEnforceBilingualPair(rel)) {
          if (!CHINESE_CHAR_RE.test(content)) {
            errors.push(`[Chinese Default Missing] ${rel} must default to Simplified Chinese.`);
          }
          const expectedEn =
            SPECIAL_EN_PAIRS[rel] || `${rel.slice(0, -3)}.en.md`;
          if (!fs.existsSync(path.join(rootDir, expectedEn))) {
            errors.push(`[Missing English Pair] ${rel} requires paired English file: ${expectedEn}`);
          }
        }
      }
    }
  }

  return {
    ok: errors.length === 0,
    checkedMarkdownCount: checkedMd.length,
    hygieneScannedCount: hygieneScanned,
    errors,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const res = checkDocsAndHygiene(DEFAULT_REPO_ROOT);
  if (!res.ok) {
    console.error(`[Docs & Hygiene FAILED] ${res.errors.length} issue(s) found:`);
    for (const err of res.errors) console.error(`  - ${err}`);
    process.exit(1);
  }
  console.log(
    `[Docs & Hygiene OK] Verified ${res.checkedMarkdownCount} Markdown doc(s) (Chinese-default + paired .en.md + valid links) and scanned ${res.hygieneScannedCount} file(s) with 0 hygiene issues.`
  );
}
