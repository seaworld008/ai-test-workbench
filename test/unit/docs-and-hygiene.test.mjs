import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO_ROOT, checkDocsAndHygiene } from '../../scripts/check-docs-and-hygiene.mjs';

test('repository passes bilingual docs pairing, H2 parity, generated MCP tables, CLI flags, relative links, and desensitization hygiene', () => {
  const res = checkDocsAndHygiene(DEFAULT_REPO_ROOT);
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.ok(res.checkedMarkdownCount >= 40);
});

test('checkDocsAndHygiene detects missing English pair, H2 drift, deprecated/unknown MCP tool, invalid CLI flag, and sensitive leak', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-doccheck-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'GUIDE.md'), '# Guide\nSee [Missing](./missing.md)\nEnglish only.\n', 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'AGENTS.md'),
      [
        '# 指南',
        '## 第一节',
        '调用 `aitest_nonexistent_tool` 和旧别名 `aitest_heal_begin`。',
        '运行 `npx -y ai-test-workbench mcp-serve` 或 `aitest run` 或 `npx ai-test-workbench@0.0.1 doctor`。',
        '运行 `aitw governance approve --approver alice` 和 `aitw doctor --bogus-flag`。',
        '## 第二节',
        '补充说明。',
      ].join('\n'),
      'utf8'
    );
    fs.writeFileSync(
      path.join(tmpDir, 'AGENTS.en.md'),
      '# Guide\n## Section 1\nCall `aitest_doctor`.\n',
      'utf8'
    );
    fs.writeFileSync(path.join(tmpDir, 'leak.txt'), 'Leaked local path: C:\\Users\\alice\\private-repo\\qa\n', 'utf8');

    const res = checkDocsAndHygiene(tmpDir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('[Broken Link]')));
    assert.ok(res.errors.some((e) => e.includes('[Chinese Default Missing]')));
    assert.ok(res.errors.some((e) => e.includes('[Missing English Pair]')));
    assert.ok(res.errors.some((e) => e.includes('[Unknown MCP Tool in Docs]') && e.includes('aitest_nonexistent_tool')));
    assert.ok(res.errors.some((e) => e.includes('[Unknown MCP Tool in Docs]') && e.includes('aitest_heal_begin')));
    assert.ok(res.errors.some((e) => e.includes('[Invalid CLI Flag in Docs]') && e.includes('--approver')));
    assert.ok(res.errors.some((e) => e.includes('[Invalid CLI Flag in Docs]') && e.includes('--bogus-flag')));
    assert.ok(res.errors.some((e) => e.includes('[Bilingual Structure Drift]') && e.includes('AGENTS.md')));
    assert.ok(res.errors.some((e) => e.includes('[Unpinned npx in Docs]')));
    assert.ok(res.errors.some((e) => e.includes('[Removed CLI Bin in Docs]')));
    assert.ok(res.errors.some((e) => e.includes('[Doc Version Mismatch]')));
    assert.ok(res.errors.some((e) => e.includes('[Hygiene Violation:')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
