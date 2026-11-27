import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runMapCommand } from '../../src/codemap.mjs';
import { detectMultiRepoRoots, walkSourceFiles } from '../../src/codemap/spec-indexer.mjs';
import { computeImpact, evaluateImpactForFiles, runImpactCommand } from '../../src/impact.mjs';
import {
  GLOBAL_INFRA_PATTERNS,
  buildReverseImportGraph,
  collectMultiRepoGitChangedFiles,
  remapMultiRepoFilePaths,
  stripPythonComments,
} from '../../src/impact/graph.mjs';
import { detectSiblingRepoRoots, resolveImpactRepos } from '../../src/impact/java-support.mjs';
import { buildRepoSourceIndex } from '../../src/impact/scanner.mjs';
import { detectHostTooling, detectProjectStack, inspectHostIsolation } from '../../src/init/planner.mjs';
import {
  detectSiblingRepoDirs,
  discoverMonorepoSubProjects,
  inferStackRuntimeDefaults,
} from '../../src/init/stack-registry.mjs';
import { runMcpCommand } from '../../src/mcp-hub.mjs';
import { inspectGlobalGraphEngineStatus, inspectGraphEngineStatus } from '../../src/mcp-hub/auditor.mjs';

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function git(cwd, args) {
  return execFileSync('git', ['-c', 'core.quotePath=off', ...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

async function captureJsonCommand(fn) {
  let stdout = '';
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...args) => {
    stdout += args.join(' ') + '\n';
  };
  console.error = () => {};
  try {
    const code = await fn();
    const lines = stdout.trim();
    return { code, payload: lines ? JSON.parse(lines) : null };
  } finally {
    console.log = origLog;
    console.error = origErr;
  }
}

test('v6.7.0 unified polyglot monorepo discovery preserves single-repo boundaries and discovers nested depth-1/depth-2 subprojects', () => {
  const root = makeTempDir('aitest-v670-monorepo-disc-');
  try {
    // 1. Single repo with root pom.xml must return [] even if nested packages exist
    const mavenRoot = path.join(root, 'single-maven');
    writeFile(path.join(mavenRoot, 'pom.xml'), '<project></project>\n');
    writeFile(path.join(mavenRoot, 'apps', 'a', 'package.json'), '{"name":"a"}\n');
    writeFile(path.join(mavenRoot, 'apps', 'b', 'package.json'), '{"name":"b"}\n');
    assert.deepEqual(discoverMonorepoSubProjects(mavenRoot), []);

    // 2. Single repo with root package.json WITHOUT workspaces must return []
    const plainJs = path.join(root, 'single-js');
    writeFile(path.join(plainJs, 'package.json'), '{"name":"plain-app"}\n');
    writeFile(path.join(plainJs, 'packages', 'a', 'package.json'), '{"name":"a"}\n');
    writeFile(path.join(plainJs, 'packages', 'b', 'package.json'), '{"name":"b"}\n');
    assert.deepEqual(discoverMonorepoSubProjects(plainJs), []);

    // 3. Explicit JS workspace with direct source files in src/ must stay single-repo []
    const hybridJs = path.join(root, 'hybrid-js');
    writeFile(path.join(hybridJs, 'package.json'), JSON.stringify({ name: 'hybrid', workspaces: ['packages/*'] }));
    writeFile(path.join(hybridJs, 'src', 'index.ts'), 'export const rootApp = true;\n');
    writeFile(path.join(hybridJs, 'packages', 'a', 'package.json'), '{"name":"a"}\n');
    writeFile(path.join(hybridJs, 'packages', 'b', 'package.json'), '{"name":"b"}\n');
    assert.deepEqual(discoverMonorepoSubProjects(hybridJs), []);

    // 4. Polyglot monorepo WITH .git at root, no root build manifest, nested under src/ (and ignored dirs excluded)
    const polyHub = path.join(root, 'polyglot-ops-hub');
    fs.mkdirSync(path.join(polyHub, '.git'), { recursive: true });
    writeFile(path.join(polyHub, 'src', 'ops-web', 'package.json'), '{"name":"ops-web","dependencies":{"vue":"^3.5.0"}}\n');
    writeFile(path.join(polyHub, 'src', 'ops-web', 'server.cjs'), 'module.exports = {};\n');
    writeFile(path.join(polyHub, 'src', 'ops-master', 'pyproject.toml'), '[project]\nname="ops-master"\ndependencies=["fastapi"]\n');
    writeFile(path.join(polyHub, 'src', 'ops-ai', 'requirements.txt'), 'aiohttp==3.9.5\n');
    writeFile(path.join(polyHub, 'src', 'ops-alarm', 'requirements.txt'), 'flask==3.0.0\n');
    writeFile(path.join(polyHub, 'src', 'ops-setup', 'Dockerfile'), 'FROM python:3.12\n');
    writeFile(path.join(polyHub, 'dist', 'stale-web', 'package.json'), '{"name":"stale"}\n');
    writeFile(path.join(polyHub, 'qa', 'package.json'), '{"name":"qa"}\n');

    const expected = [
      path.join(polyHub, 'src', 'ops-ai'),
      path.join(polyHub, 'src', 'ops-alarm'),
      path.join(polyHub, 'src', 'ops-master'),
      path.join(polyHub, 'src', 'ops-web'),
    ].sort((a, b) => a.localeCompare(b));

    assert.deepEqual(detectSiblingRepoDirs(polyHub), expected);
    assert.deepEqual(detectMultiRepoRoots(polyHub), expected);
    assert.deepEqual(detectSiblingRepoRoots(polyHub), expected);

    // spec-indexer includes .cjs files
    const walked = walkSourceFiles(path.join(polyHub, 'src', 'ops-web'));
    assert.ok(walked.files.some((f) => f.endsWith('server.cjs')), 'walkSourceFiles must index .cjs files');

    // 5. Explicit pnpm-workspace.yaml / package.json#workspaces without direct src/ code discovers apps/* & services/* + dedupes symlinks
    const wsMono = path.join(root, 'ws-mono');
    writeFile(path.join(wsMono, 'package.json'), JSON.stringify({ name: 'ws-mono', private: true, workspaces: ['apps/*', 'services/*'] }));
    writeFile(path.join(wsMono, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n  - services/*\n');
    writeFile(path.join(wsMono, 'apps', 'ops-portal', 'package.json'), '{"name":"ops-portal"}\n');
    writeFile(path.join(wsMono, 'services', 'ops-gateway', 'go.mod'), 'module example.com/ops-gateway\n');
    try {
      fs.symlinkSync(
        path.join(wsMono, 'apps', 'ops-portal'),
        path.join(wsMono, 'packages', 'ops-portal-link'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
    } catch {
      // Ignore symlink permission constraints if restricted
    }
    const wsDiscovered = discoverMonorepoSubProjects(wsMono);
    assert.equal(wsDiscovered.length, 2);
    assert.ok(wsDiscovered.includes(path.join(wsMono, 'apps', 'ops-portal')));
    assert.ok(wsDiscovered.includes(path.join(wsMono, 'services', 'ops-gateway')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v6.7.0 Python/polyglot stack descriptors, Pytest detection, and monorepo host tooling aggregation', () => {
  const root = makeTempDir('aitest-v670-stacks-');
  try {
    const fastapiDir = path.join(root, 'svc-fastapi');
    writeFile(path.join(fastapiDir, 'pyproject.toml'), '[project]\ndependencies=["fastapi","starlette","uvicorn","pytest"]\n');
    assert.deepEqual(detectProjectStack(fastapiDir), ['Python/FastAPI', 'Pytest']);
    assert.equal(inferStackRuntimeDefaults(fastapiDir).defaultPort, 8000);

    const uvicornOnlyDir = path.join(root, 'svc-uvicorn');
    writeFile(path.join(uvicornOnlyDir, 'requirements.txt'), 'uvicorn==0.30.0\n');
    assert.deepEqual(detectProjectStack(uvicornOnlyDir), ['Python/FastAPI']);

    const aiohttpDir = path.join(root, 'svc-aiohttp');
    writeFile(path.join(aiohttpDir, 'requirements.txt'), 'aiohttp==3.10.0\nuvicorn==0.30.0\n');
    writeFile(path.join(aiohttpDir, 'pytest.ini'), '[pytest]\n');
    assert.deepEqual(detectProjectStack(aiohttpDir), ['Python/aiohttp', 'Pytest']);
    assert.equal(inferStackRuntimeDefaults(aiohttpDir).defaultPort, 8080);
    assert.equal(inferStackRuntimeDefaults(aiohttpDir).command, null);

    const flaskDir = path.join(root, 'svc-flask');
    writeFile(path.join(flaskDir, 'requirements.txt'), 'Flask>=3.0\n');
    assert.deepEqual(detectProjectStack(flaskDir), ['Python/Flask']);
    assert.equal(inferStackRuntimeDefaults(flaskDir).defaultPort, 5000);
    assert.match(inferStackRuntimeDefaults(flaskDir).command || '', /^flask run/);

    const starletteDir = path.join(root, 'svc-starlette');
    writeFile(path.join(starletteDir, 'requirements.txt'), 'starlette==0.38.0\nuvicorn==0.30.0\n');
    assert.deepEqual(detectProjectStack(starletteDir), ['Python/Starlette']);
    assert.equal(inferStackRuntimeDefaults(starletteDir).defaultPort, 8000);

    const djangoDir = path.join(root, 'svc-django');
    writeFile(path.join(djangoDir, 'manage.py'), '#!/usr/bin/env python\n');
    writeFile(path.join(djangoDir, 'requirements.txt'), 'Django==5.1\n');
    assert.deepEqual(detectProjectStack(djangoDir), ['Python/Django']);
    assert.match(inferStackRuntimeDefaults(djangoDir).command || '', /manage\.py runserver/);

    const barePyDir = path.join(root, 'svc-bare-py');
    writeFile(path.join(barePyDir, 'requirements.txt'), 'requests==2.32.0\n');
    writeFile(path.join(barePyDir, 'conftest.py'), 'import pytest\n');
    assert.deepEqual(detectProjectStack(barePyDir), ['Python', 'Pytest']);

    // Monorepo host tooling aggregation across src/ops-web + src/ops-master
    const mono = path.join(root, 'polyglot-ops-hub');
    fs.mkdirSync(path.join(mono, '.git'), { recursive: true });
    writeFile(
      path.join(mono, 'src', 'ops-web', 'package.json'),
      JSON.stringify({ name: 'ops-web', dependencies: { vue: '^3.5.0', 'element-plus': '^2.8.0' } })
    );
    writeFile(path.join(mono, 'src', 'ops-web', 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    writeFile(path.join(mono, 'src', 'ops-master', 'pyproject.toml'), '[project]\ndependencies=["fastapi","pytest"]\n');
    fs.mkdirSync(path.join(mono, 'src', 'ops-master', 'tests'), { recursive: true });

    const monoStacks = detectProjectStack(mono);
    assert.ok(monoStacks.includes('Vue 3'));
    assert.ok(monoStacks.includes('Element Plus'));
    assert.ok(monoStacks.includes('Python/FastAPI'));
    assert.ok(monoStacks.includes('Multi-Repo Workspace'));
    assert.ok(monoStacks.includes('Pytest'));

    const tooling = detectHostTooling(mono);
    assert.equal(tooling.packageManager, 'pnpm');
    assert.equal(tooling.lockfile, 'pnpm-lock.yaml');
    assert.equal(tooling.vueVersion, 'vue3');
    assert.equal(tooling.uiLibrary, 'element-plus');
    assert.equal(tooling.hasExistingTestsDir, true);
    assert.deepEqual(tooling.siblingRepos, ['ops-master', 'ops-web']);

    const advisories = inspectHostIsolation(mono, 'qa');
    assert.ok(advisories.some((a) => a.includes('pnpm (pnpm-lock.yaml)')));
    assert.ok(advisories.some((a) => a.includes('tests/')));
    assert.ok(advisories.some((a) => a.includes('ops-master, ops-web')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('v6.7.0 shared-.git monorepo diff remapping, .txt/.md fixture filtering, Python reverse-import graph & end-to-end computeImpact', async () => {
  const mono = makeTempDir('aitest-v670-mono-impact-');
  const opsWeb = path.join(mono, 'src', 'ops-web');
  const opsMaster = path.join(mono, 'src', 'ops-master');
  const qaDir = path.join(mono, 'qa');

  try {
    // Setup polyglot monorepo under ONE shared .git root
    writeFile(path.join(opsWeb, 'package.json'), JSON.stringify({ name: 'ops-web', dependencies: { vue: '^3.5.0' } }));
    writeFile(path.join(opsWeb, 'src', 'views', 'Dashboard.vue'), '<template><div>Dash</div></template>\n');
    writeFile(path.join(opsWeb, 'src', 'views', 'Alerts.vue'), '<template><div>Alerts</div></template>\n');

    writeFile(path.join(opsMaster, 'pyproject.toml'), '[project]\nname="ops-master"\ndependencies=["fastapi"]\n');
    writeFile(
      path.join(opsMaster, 'libs', 'ops_tools', '__init__.py'),
      'from .formatter import format_alert\n'
    );
    writeFile(
      path.join(opsMaster, 'libs', 'ops_tools', 'formatter.py'),
      'def format_alert(msg: str) -> str:\n    return msg.strip()\n'
    );
    writeFile(
      path.join(opsMaster, 'app', 'helpers', 'normalizer.py'),
      'def normalize_key(k: str) -> str:\n    return k.lower()\n'
    );
    writeFile(
      path.join(opsMaster, 'service.py'),
      'def get_service_status() -> str:\n    return "ok"\n'
    );
    writeFile(
      path.join(opsMaster, 'app', 'routes', 'alerts.py'),
      [
        '# from ops_tools.dead import ignored_fn',
        '"""',
        'from ops_tools.fake_docstring import ghost',
        '"""',
        'from ops_tools.formatter import format_alert',
        'from service import get_service_status',
        'from ..helpers.normalizer import normalize_key',
        '',
        'def get_alerts():',
        '    return format_alert(normalize_key(get_service_status()))',
        '',
      ].join('\n')
    );
    writeFile(
      path.join(opsMaster, 'tests', 'test_formatter.py'),
      'from ops_tools.formatter import format_alert\ndef test_fmt():\n    assert format_alert(" a ") == "a"\n'
    );
    writeFile(path.join(opsMaster, 'tests', 'fixtures', 'ast', 'case1.txt'), 'sample fixture v1\n');
    writeFile(path.join(opsMaster, 'tests', 'fixtures', 'helper.py'), 'FIXTURE = 1\n');
    writeFile(path.join(mono, 'README.md'), '# Polyglot Ops Hub\n');

    // Setup QA directory with code-map.json and Playwright specs
    writeFile(path.join(qaDir, 'package.json'), JSON.stringify({ name: 'ops-qa', devDependencies: { '@playwright/test': '^1.50.0' } }));
    writeFile(path.join(qaDir, 'tests', 'e2e', 'alerts.spec.ts'), 'test("alerts", () => {});\n');
    writeFile(path.join(qaDir, 'tests', 'e2e', 'dashboard.spec.ts'), 'test("dashboard", () => {});\n');
    writeFile(
      path.join(qaDir, 'knowledge', 'code-map.json'),
      JSON.stringify(
        {
          schemaVersion: 5,
          meta: { sourceRepos: [mono] },
          routes: {
            '/alerts': {
              route: '/alerts',
              frontendFile: 'ops-web/src/views/Alerts.vue',
              linkedBackendFiles: ['ops-master/app/routes/alerts.py'],
              coveringSpecs: ['tests/e2e/alerts.spec.ts'],
            },
            '/dashboard': {
              route: '/dashboard',
              frontendFile: 'ops-web/src/views/Dashboard.vue',
              coveringSpecs: ['tests/e2e/dashboard.spec.ts'],
            },
          },
        },
        null,
        2
      )
    );

    // 1. resolveImpactRepos expands single monorepo root from code-map.meta.sourceRepos
    const resolvedRepos = resolveImpactRepos(mono, qaDir);
    assert.deepEqual(resolvedRepos, [opsMaster, opsWeb]);

    // 2. Python comment stripping & reverse-import graph skips ops-master/tests/ and resolves relative + subpath imports
    const stripped = stripPythonComments('x = "http://a#b"\n# import dead\n"""\nfrom fake import y\n"""\nfrom ops_tools.formatter import format_alert\n');
    assert.match(stripped, /x = "http:\/\/a#b"/);
    assert.doesNotMatch(stripped, /import dead|fake/);

    const pyIdx = buildRepoSourceIndex(opsMaster, { includeQa: false });
    assert.equal(pyIdx.relSet.has('tests/test_formatter.py'), false, 'Product scanner must skip root tests/ when includeQa=false');
    assert.equal(pyIdx.relSet.has('libs/ops_tools/formatter.py'), true);

    const revGraph = buildReverseImportGraph(mono, { includeQa: false, repos: [opsMaster, opsWeb] });
    assert.ok(
      revGraph.get('ops-master/libs/ops_tools/formatter.py')?.has('ops-master/app/routes/alerts.py'),
      'Subpath Python package ops_tools.formatter must resolve to alerts.py'
    );
    assert.ok(
      revGraph.get('ops-master/app/helpers/normalizer.py')?.has('ops-master/app/routes/alerts.py'),
      'Relative ..helpers.normalizer import must resolve to alerts.py'
    );
    assert.equal(
      revGraph.get('ops-master/libs/ops_tools/formatter.py')?.has('ops-master/tests/test_formatter.py') || false,
      false,
      'Unit test importer must not pollute runtime reverse graph'
    );

    // 3. GLOBAL_INFRA_PATTERNS allows backend tests/fixtures/* while blocking qa/tests/fixtures/* and Python/Go/Rust manifests
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('ops-master/tests/fixtures/ast/case1.txt')), false);
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('ops-master/tests/fixtures/helper.py')), false);
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('qa/tests/fixtures/base.ts')), true);
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('ops-master/pyproject.toml')), true);
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('ops-ai/requirements.txt')), true);
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('svc/go.mod')), true);
    assert.equal(GLOBAL_INFRA_PATTERNS.some((re) => re.test('svc/Cargo.lock')), true);

    // 4. Shared .git monorepo diff remapping + computeImpact end-to-end
    git(mono, ['init', '-b', 'main']);
    git(mono, ['config', 'user.email', 'dev@example.com']);
    git(mono, ['config', 'user.name', 'Dev']);
    git(mono, ['add', '-A']);
    git(mono, ['commit', '-m', 'chore: baseline']);

    // Edit Python utility + backend txt fixture + README + dirty qa/reports artifact
    writeFile(path.join(opsMaster, 'libs', 'ops_tools', 'formatter.py'), 'def format_alert(msg: str) -> str:\n    return msg.strip().upper()\n');
    writeFile(path.join(opsMaster, 'tests', 'fixtures', 'ast', 'case1.txt'), 'sample fixture v2\n');
    writeFile(path.join(mono, 'README.md'), '# Updated docs\n');
    writeFile(path.join(qaDir, 'reports', 'results.json'), '{"suites":[]}\n');

    const diffRes = await collectMultiRepoGitChangedFiles([opsMaster, opsWeb], 'HEAD', { qaRelPrefix: 'qa' });
    assert.equal(diffRes.ok, true);
    assert.deepEqual(diffRes.files, [
      'README.md',
      'ops-master/libs/ops_tools/formatter.py',
      'ops-master/tests/fixtures/ast/case1.txt',
    ]);

    const pyImpact = await computeImpact(mono, { base: 'HEAD' });
    assert.equal(pyImpact.mode, 'targeted', `Expected targeted impact for Python utility + txt fixture, got ${pyImpact.reason}`);
    assert.deepEqual(pyImpact.specs, ['tests/e2e/alerts.spec.ts']);

    // Also verify editing files across ops-web + qa/tests/e2e/dashboard.spec.ts remaps cleanly in shared .git monorepo
    writeFile(path.join(opsWeb, 'src', 'views', 'Dashboard.vue'), '<template><div>Dash v2</div></template>\n');
    writeFile(path.join(qaDir, 'tests', 'e2e', 'dashboard.spec.ts'), 'test("dashboard v2", () => {});\n');
    const multiImpact = await computeImpact(mono, { base: 'HEAD' });
    assert.equal(multiImpact.mode, 'targeted');
    assert.deepEqual(multiImpact.specs, ['tests/e2e/alerts.spec.ts', 'tests/e2e/dashboard.spec.ts']);

    // Explicit evaluateImpactForFiles check with backend .txt fixture
    const txtPlusCode = evaluateImpactForFiles(
      ['ops-master/tests/fixtures/ast/case1.txt', 'ops-web/src/views/Dashboard.vue'],
      qaDir,
      mono
    );
    assert.equal(txtPlusCode.mode, 'targeted');
    assert.deepEqual(txtPlusCode.specs, ['tests/e2e/dashboard.spec.ts']);

    // Regression: computeImpact --files remaps shared-.git monorepo paths ('src/ops-master/service.py' & abs paths)
    const byLabelImpact = await computeImpact(mono, { files: ['ops-master/service.py'] });
    const byMonoRelImpact = await computeImpact(mono, { files: ['src/ops-master/service.py'] });
    const byAbsImpact = await computeImpact(mono, { files: [path.join(opsMaster, 'service.py')] });
    assert.equal(byLabelImpact.mode, 'targeted');
    assert.deepEqual(byLabelImpact.specs, ['tests/e2e/alerts.spec.ts']);
    assert.deepEqual(byMonoRelImpact, byLabelImpact);
    assert.deepEqual(byAbsImpact, byLabelImpact);

    assert.deepEqual(remapMultiRepoFilePaths(['src/ops-master/service.py'], [opsMaster], mono), ['src/ops-master/service.py']);
    assert.deepEqual(
      remapMultiRepoFilePaths(
        ['ops-master/service.py', 'src/ops-master/service.py', 'src\\ops-web\\src\\views\\Alerts.vue', 'qa/tests/e2e/alerts.spec.ts'],
        [opsMaster, opsWeb],
        mono
      ),
      ['ops-master/service.py', 'ops-master/service.py', 'ops-web/src/views/Alerts.vue', 'qa/tests/e2e/alerts.spec.ts']
    );
  } finally {
    fs.rmSync(mono, { recursive: true, force: true });
  }
});

test('v6.7.0 global mcp engine-status (no --target / uninitialized --target) and structured USAGE_ERROR / WORKSPACE_NOT_INITIALIZED recovery envelopes', async () => {
  const root = makeTempDir('aitest-v670-ergo-');
  const uninitRepo = path.join(root, 'uninit-repo');
  const binBaseDir = path.join(root, 'isolated-bin');
  fs.mkdirSync(uninitRepo, { recursive: true });

  try {
    // 1. Global inspectGlobalGraphEngineStatus() without and with synthetic binary
    const emptyGlobal = inspectGlobalGraphEngineStatus({ target: uninitRepo, binBaseDir, env: {} });
    assert.equal(emptyGlobal.installPolicy, 'human-cli-only');
    assert.equal(emptyGlobal.qaInitialized, false);
    assert.equal(emptyGlobal.globalBinaryInstalled, false);
    assert.equal(emptyGlobal.globalBinarySha256, null);
    assert.equal(emptyGlobal.globalChecksumVerified, null);
    assert.ok(emptyGlobal.globalBinaryPath.includes('0.12.1'));

    const binName = process.platform === 'win32' ? 'codebase-memory-mcp.exe' : 'codebase-memory-mcp';
    const installedBin = path.join(binBaseDir, '0.12.1', binName);
    writeFile(installedBin, 'synthetic-cbm-binary-v0.12.1');
    const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(installedBin)).digest('hex');

    const presentGlobal = inspectGlobalGraphEngineStatus({
      binBaseDir,
      env: {},
      expectedBinarySha256: expectedSha,
    });
    assert.equal(presentGlobal.globalBinaryInstalled, true);
    assert.equal(presentGlobal.globalBinaryPath, installedBin);
    assert.equal(presentGlobal.globalBinarySha256, expectedSha);
    assert.equal(presentGlobal.globalChecksumVerified, true);

    const mismatchGlobal = inspectGlobalGraphEngineStatus({
      binBaseDir,
      env: {},
      expectedBinarySha256: 'f'.repeat(64),
    });
    assert.equal(mismatchGlobal.globalChecksumVerified, false);

    // 2. runMcpCommand('engine-status') without --target AND with uninitialized --target both pass (exitCode 0)
    const noTargetStatus = await captureJsonCommand(() => runMcpCommand({ action: 'engine-status', json: true }));
    assert.equal(noTargetStatus.code, 0);
    assert.equal(noTargetStatus.payload.outcome, 'pass');
    assert.equal(noTargetStatus.payload.data.installPolicy, 'human-cli-only');
    assert.equal(noTargetStatus.payload.data.qaInitialized, false);
    assert.ok(Array.isArray(noTargetStatus.payload.nextRecommendedActions) && noTargetStatus.payload.nextRecommendedActions.length >= 1);

    const uninitTargetStatus = await captureJsonCommand(() =>
      runMcpCommand({ action: 'engine-status', target: uninitRepo, json: true })
    );
    assert.equal(uninitTargetStatus.code, 0);
    assert.equal(uninitTargetStatus.payload.outcome, 'pass');
    assert.equal(uninitTargetStatus.payload.data.qaInitialized, false);
    assert.equal(uninitTargetStatus.payload.data.target, path.resolve(uninitRepo));

    // Initialized repo still uses inspectGraphEngineStatus(qaDir) with qaInitialized=true
    const initRepo = path.join(root, 'init-repo');
    writeFile(path.join(initRepo, 'qa', 'playwright.config.ts'), 'export default {};\n');
    const initStatus = inspectGraphEngineStatus(path.join(initRepo, 'qa'));
    assert.equal(initStatus.qaInitialized, true);
    const initCmdStatus = await captureJsonCommand(() =>
      runMcpCommand({ action: 'engine-status', target: initRepo, json: true })
    );
    assert.equal(initCmdStatus.code, 0);
    assert.equal(initCmdStatus.payload.data.qaInitialized, true);

    // 3. Structured blockerKind & recoverySteps on mcp, map, and impact (preserving exit codes)
    const mcpMissingTarget = await captureJsonCommand(() => runMcpCommand({ action: 'doctor', json: true }));
    assert.equal(mcpMissingTarget.code, 64);
    assert.equal(mcpMissingTarget.payload.blockerKind, 'USAGE_ERROR');
    assert.equal(mcpMissingTarget.payload.recoverable, true);
    assert.ok(mcpMissingTarget.payload.recoverySteps.length >= 1);

    const mcpUninit = await captureJsonCommand(() =>
      runMcpCommand({ action: 'doctor', target: uninitRepo, json: true })
    );
    assert.equal(mcpUninit.code, 1);
    assert.equal(mcpUninit.payload.blockerKind, 'WORKSPACE_NOT_INITIALIZED');
    assert.equal(mcpUninit.payload.recoverable, true);
    assert.ok(mcpUninit.payload.recoverySteps.some((s) => s.includes('init')));

    const mapMissingTarget = await captureJsonCommand(() => runMapCommand({ json: true }));
    assert.equal(mapMissingTarget.code, 1);
    assert.equal(mapMissingTarget.payload.blockerKind, 'USAGE_ERROR');
    assert.equal(mapMissingTarget.payload.recoverable, true);

    const mapUninit = await captureJsonCommand(() => runMapCommand({ target: uninitRepo, json: true }));
    assert.equal(mapUninit.code, 1);
    assert.equal(mapUninit.payload.blockerKind, 'WORKSPACE_NOT_INITIALIZED');
    assert.equal(mapUninit.payload.recoverable, true);

    const impactMissingTarget = await captureJsonCommand(() => runImpactCommand({ json: true }));
    assert.equal(impactMissingTarget.code, 1);
    assert.equal(impactMissingTarget.payload.blockerKind, 'USAGE_ERROR');
    assert.equal(impactMissingTarget.payload.recoverable, true);

    const impactUninit = await captureJsonCommand(() => runImpactCommand({ target: uninitRepo, json: true }));
    assert.equal(impactUninit.code, 1);
    assert.equal(impactUninit.payload.blockerKind, 'WORKSPACE_NOT_INITIALIZED');
    assert.equal(impactUninit.payload.recoverable, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
