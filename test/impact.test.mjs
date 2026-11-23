import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { evaluateImpactForFiles } from '../src/impact.mjs';

function createTempRepoWithQa() {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aitest-impact-'));
  const qaDir = path.join(repoDir, 'qa');
  fs.mkdirSync(path.join(qaDir, 'tests', 'e2e'), { recursive: true });
  fs.mkdirSync(path.join(qaDir, 'tests', 'api'), { recursive: true });
  fs.mkdirSync(path.join(qaDir, 'tests', 'smoke'), { recursive: true });

  fs.writeFileSync(path.join(qaDir, 'tests', 'smoke', 'workbench.spec.ts'), 'test()', 'utf8');
  fs.writeFileSync(path.join(qaDir, 'tests', 'e2e', 'home.spec.ts'), 'test()', 'utf8');
  fs.writeFileSync(path.join(qaDir, 'tests', 'api', 'courses.spec.ts'), 'test()', 'utf8');
  fs.writeFileSync(
    path.join(qaDir, 'impact-map.json'),
    JSON.stringify({
      rules: [
        {
          match: ['src/views/courses/**'],
          specs: ['tests/e2e/home.spec.ts', 'tests/api/courses.spec.ts'],
        },
      ],
    }),
    'utf8'
  );
  return { repoDir, qaDir };
}

test('evaluateImpactForFiles selects targeted specs for mapped files', () => {
  const { repoDir, qaDir } = createTempRepoWithQa();
  try {
    const res = evaluateImpactForFiles(['src/views/courses/CourseCard.vue'], qaDir, repoDir);
    assert.equal(res.mode, 'targeted');
    assert.deepEqual(res.specs, ['tests/api/courses.spec.ts', 'tests/e2e/home.spec.ts']);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('evaluateImpactForFiles falls back to full suite on infra, router, or unmapped source changes', () => {
  const { repoDir, qaDir } = createTempRepoWithQa();
  try {
    const pkgRes = evaluateImpactForFiles(['package.json'], qaDir, repoDir);
    assert.equal(pkgRes.mode, 'full');

    const routerRes = evaluateImpactForFiles(['src/router/index.ts'], qaDir, repoDir);
    assert.equal(routerRes.mode, 'full');

    const unmappedRes = evaluateImpactForFiles(['src/payments/settlement.ts'], qaDir, repoDir);
    assert.equal(unmappedRes.mode, 'full');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('evaluateImpactForFiles uses --only-changed for internal QA helper edits when baseRef is valid', () => {
  const { repoDir, qaDir } = createTempRepoWithQa();
  try {
    const res = evaluateImpactForFiles(['qa/tests/helpers/loginHelper.ts'], qaDir, repoDir, {
      canUseOnlyChanged: true,
    });
    assert.equal(res.mode, 'only-changed');
    assert.equal(res.useOnlyChanged, true);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
