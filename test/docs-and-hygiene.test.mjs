import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULT_REPO_ROOT, checkDocsAndHygiene } from '../scripts/check-docs-and-hygiene.mjs';

test('repository passes bilingual docs pairing, relative links, and desensitization hygiene', () => {
  const res = checkDocsAndHygiene(DEFAULT_REPO_ROOT);
  assert.equal(res.ok, true, res.errors.join('\n'));
  assert.ok(res.checkedMarkdownCount >= 40);
});

test('checkDocsAndHygiene detects missing English pair, English-only default doc, broken link, and sensitive leak', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-doccheck-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'GUIDE.md'), '# Guide\nSee [Missing](./missing.md)\nEnglish only.\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'leak.txt'), ['jin', 'ling', 'test'].join('') + '\n', 'utf8');

    const res = checkDocsAndHygiene(tmpDir);
    assert.equal(res.ok, false);
    assert.ok(res.errors.some((e) => e.includes('[Broken Link]')));
    assert.ok(res.errors.some((e) => e.includes('[Chinese Default Missing]')));
    assert.ok(res.errors.some((e) => e.includes('[Missing English Pair]')));
    assert.ok(res.errors.some((e) => e.includes('[Hygiene Violation:')));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
