import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TOOL_REGISTRY } from '../src/mcp/registry.mjs';
import { WORKBENCH_VERSION } from '../src/version.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_REPO_ROOT = path.resolve(__dirname, '..');

/**
 * Privacy-preserving desensitization hygiene checker (`S-04`):
 * - Uses generic structural regexes for local host path leaks (`C:\Users\<name>\`, `/Users/<name>/`).
 * - Uses ONE-WAY SHA-256 token digests (never cleartext or reconstructible unicode literals!)
 *   for internal project/PII blocklist screening, plus optional `AITEST_HYGIENE_BLOCKLIST_FILE`.
 */
const GENERIC_PATH_PATTERNS = [
  ['win_user_path', /\b[A-Z]:\\Users\\[A-Za-z0-9._-]+\\/i],
  ['win_workspace_path', /\bE:\\AI-codex\\/i],
  ['mac_user_path', /\/Users\/[A-Za-z0-9._-]+\//],
];

// Salted SHA-256 digests of forbidden internal identifiers (non-reversible in source / npm tarball)
const HASH_SALT = 'aitest-hygiene-v2:';
const FORBIDDEN_TOKEN_HASHES = new Set([
  'e43b2472285402d8c78d1c7c025d36d819594b3b7198967c9d2b5748a8858b25',
  '2f3b0c46c50f7f4f4b1dc065f30067cc39e6d887e8eb4792ec8975d24a943661',
  '3376a35e28d18a9b2390b1093fd861f77f62c0606b89116d64e97c31146d4029',
  '4c74c2b21c5686b58f742ccaa1854f7a380d9804eb21f5437c6d75914393b025',
]);

function sha256Token(tok) {
  return crypto.createHash('sha256').update(`${HASH_SALT}${String(tok).toLowerCase()}`).digest('hex');
}

function loadOptionalExternalBlocklist() {
  const filePath = process.env.AITEST_HYGIENE_BLOCKLIST_FILE;
  if (!filePath || !fs.existsSync(filePath)) return [];
  try {
    return fs
      .readFileSync(filePath, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  } catch {
    return [];
  }
}

const SPECIAL_EN_PAIRS = {
  'Playwright Test Agents + Codex 可复用本机 AI 自动化测试工作台——架构设计与实施提示词.md':
    'docs/architecture-and-prompts-blueprint.en.md',
};

const ACTIVE_MCP_TOOL_DOCS = new Set([
  'AGENTS.md',
  'AGENTS.en.md',
  'README.md',
  'README.en.md',
  'skills/ai-test-workbench/SKILL.md',
  'skills/ai-test-workbench/SKILL.zh-CN.md',
  'skills/ai-test-workbench/references/mcp-server-protocol.md',
  'skills/ai-test-workbench/references/mcp-server-protocol.en.md',
]);

const REGISTERED_MCP_TOOLS = new Set(TOOL_REGISTRY.map((t) => t.name));

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

/**
 * Validates that every backticked `aitest_<tool>` identifier in active Agent/MCP docs exists
 * in the live MCP `TOOL_REGISTRY` (`Q-04`).
 */
function validateDocumentedMcpToolNames(relPath, mdText, errors) {
  const toolMentionRe = /`(aitest_[a-z][a-z0-9_]+)`/g;
  const seenUnknown = new Set();
  for (const m of mdText.matchAll(toolMentionRe)) {
    const name = m[1];
    // Ignore wildcard documentation patterns like `aitest_heal_*` (won't match `[a-z0-9_]+` anyway)
    if (!REGISTERED_MCP_TOOLS.has(name) && !seenUnknown.has(name)) {
      seenUnknown.add(name);
      errors.push(
        `[Unknown MCP Tool in Docs] ${relPath} references \`${name}\`, which is NOT registered in TOOL_REGISTRY.`
      );
    }
  }
}

/**
 * Validates backticked `test/*.mjs` / `src/*.mjs` paths in scorecards exist on disk (`Q-05`).
 */
function validateScorecardFileRefs(rootDir, relPath, mdText, errors) {
  const refRe = /`((?:src|test|scripts)\/[a-zA-Z0-9._/-]+\.mjs)`/g;
  for (const m of mdText.matchAll(refRe)) {
    const refPath = m[1];
    if (refPath.includes('*')) continue;
    const full = path.join(rootDir, refPath);
    if (!fs.existsSync(full)) {
      errors.push(`[Broken Code Ref] ${relPath} references \`${refPath}\`, which does not exist on disk.`);
    }
  }
}

const CLI_SUBCOMMANDS_RE =
  /(?:^|[\s`"'(\[])aitest\s+(?:doctor|init|auth-login|explore|map|mcp|mcp-serve|perf|run|impact|audit|diagnose|verify-change|heal|flaky|trace-matrix|governance|report|update-agents|skill-install|attest|--help|--version|<cmd>|<command>)(?=[\s`"'.,;:)\]]|$)/m;
const UNPINNED_NPX_RE = /\bnpx\s+(?:-y|--yes)\s+ai-test-workbench(?![@\d])/i;
const PINNED_PKG_VER_RE = /ai-test-workbench@(\d+\.\d+\.\d+)/g;

function readExpectedPackageVersion(rootDir) {
  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (parsed.version) return String(parsed.version);
    } catch {
      // fall back
    }
  }
  return WORKBENCH_VERSION;
}

/**
 * Enforces Stage 1 release hygiene across active docs:
 * 1. Bans unpinned `npx -y ai-test-workbench` (must pin `@<version>`).
 * 2. Bans removed `aitest <cmd>` CLI binary in examples (use `npx ai-test-workbench@<ver>`, `aitw`, or `node tools/aitest.mjs`).
 * 3. Ensures every `ai-test-workbench@<x.y.z>` version pin matches `package.json` `version`.
 */
function validateCliCommandAndVersionConsistency(relPath, mdText, expectedVersion, errors) {
  const norm = relPath.replace(/\\/g, '/');
  if (
    norm.startsWith('docs/review/') ||
    norm.startsWith('bench/real-world/') ||
    norm === 'CHANGELOG.md' ||
    norm === 'CHANGELOG.en.md'
  ) {
    return;
  }
  if (UNPINNED_NPX_RE.test(mdText)) {
    errors.push(
      `[Unpinned npx in Docs] ${relPath} uses bare \`npx -y ai-test-workbench\`; pin an exact version (\`npx ai-test-workbench@${expectedVersion}\`).`
    );
  }
  const removedBin = CLI_SUBCOMMANDS_RE.exec(mdText);
  if (removedBin) {
    errors.push(
      `[Removed CLI Bin in Docs] ${relPath} references removed \`aitest\` CLI command ("${removedBin[0].trim()}"); use \`npx ai-test-workbench@${expectedVersion}\`, \`aitw\`, or \`node tools/aitest.mjs\`.`
    );
  }
  const seenMismatch = new Set();
  for (const m of mdText.matchAll(PINNED_PKG_VER_RE)) {
    const foundVer = m[1];
    if (foundVer !== expectedVersion && !seenMismatch.has(foundVer)) {
      seenMismatch.add(foundVer);
      errors.push(
        `[Doc Version Mismatch] ${relPath} pins \`ai-test-workbench@${foundVer}\`, which does not match package.json version \`${expectedVersion}\`.`
      );
    }
  }
}

export function checkDocsAndHygiene(rootDir = DEFAULT_REPO_ROOT) {
  const files = listRepoFiles(rootDir);
  const errors = [];
  const checkedMd = [];
  let hygieneScanned = 0;
  const externalBlocklist = loadOptionalExternalBlocklist();
  const expectedPkgVersion = readExpectedPackageVersion(rootDir);

  for (const rawRel of files) {
    const rel = rawRel.replace(/\\/g, '/');
    const fullPath = path.join(rootDir, rel);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;

    if (/\.(md|mjs|ts|js|json|yml|yaml|txt|example)$/i.test(rel) || rel === 'templates/playwright-qa/gitignore') {
      const content = fs.readFileSync(fullPath, 'utf8');
      hygieneScanned += 1;

      // 1. Generic host-path leak detection (skip self-regex file)
      if (rel !== 'scripts/check-docs-and-hygiene.mjs') {
        for (const [label, pat] of GENERIC_PATH_PATTERNS) {
          if (pat.test(content)) {
            errors.push(`[Hygiene Violation:${label}] Found restricted host path pattern in ${rel}`);
          }
        }
      }

      // 2. Non-reversible SHA-256 token screening (zero PII stored in source!)
      const tokens = content.match(/[A-Za-z0-9]{4,32}|[\u4e00-\u9fff]{2,8}/g) || [];
      for (const tok of tokens) {
        if (FORBIDDEN_TOKEN_HASHES.has(sha256Token(tok))) {
          errors.push(`[Hygiene Violation:blocked_token_hash] Found blocked internal token in ${rel}`);
          break;
        }
      }

      // 3. Optional external blocklist file (kept untracked or in CI Secret)
      for (const word of externalBlocklist) {
        if (content.toLowerCase().includes(word.toLowerCase())) {
          errors.push(`[Hygiene Violation:external_blocklist] Found restricted token in ${rel}`);
          break;
        }
      }

      if (rel.endsWith('.md')) {
        checkedMd.push(rel);
        validateRelativeLinks(rootDir, rel, content, errors);
        validateCliCommandAndVersionConsistency(rel, content, expectedPkgVersion, errors);

        if (ACTIVE_MCP_TOOL_DOCS.has(rel)) {
          validateDocumentedMcpToolNames(rel, content, errors);
        }

        if (rel === 'docs/review/v5-verification-scorecard.md' || rel === 'docs/review/v5-verification-scorecard.en.md') {
          validateScorecardFileRefs(rootDir, rel, content, errors);
        }

        if (shouldEnforceBilingualPair(rel)) {
          if (!CHINESE_CHAR_RE.test(content)) {
            errors.push(`[Chinese Default Missing] ${rel} must default to Simplified Chinese.`);
          }
          const expectedEn = SPECIAL_EN_PAIRS[rel] || `${rel.slice(0, -3)}.en.md`;
          if (!fs.existsSync(path.join(rootDir, expectedEn))) {
            errors.push(`[Missing English Pair] ${rel} requires paired English file: ${expectedEn}`);
          }
        }
      }
    }
  }

  // Verify docs/claims.json -> test traceability when present at root
  const claimsPath = path.join(rootDir, 'docs', 'claims.json');
  if (fs.existsSync(claimsPath)) {
    try {
      const claimsDoc = JSON.parse(fs.readFileSync(claimsPath, 'utf8'));
      for (const item of claimsDoc.claims || []) {
        const tf = path.join(rootDir, String(item.testFile || ''));
        if (!fs.existsSync(tf)) {
          errors.push(`[Unverified Claim:${item.id}] Referenced testFile "${item.testFile}" does not exist.`);
        } else {
          const tfText = fs.readFileSync(tf, 'utf8');
          if (!tfText.includes(String(item.testTitleSubstring || ''))) {
            errors.push(
              `[Unverified Claim:${item.id}] Test title "${item.testTitleSubstring}" not found in "${item.testFile}".`
            );
          }
        }
      }
    } catch (err) {
      errors.push(`[Claims JSON Error] Failed to parse docs/claims.json: ${err.message}`);
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
    `[Docs & Hygiene OK] Verified ${res.checkedMarkdownCount} Markdown doc(s) (Chinese-default + paired .en.md + valid links + MCP tool registry parity) and scanned ${res.hygieneScannedCount} file(s) with 0 hygiene issues.`
  );
}
