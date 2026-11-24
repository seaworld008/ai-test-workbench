import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { syncTemplateVendor } from '../../scripts/sync-template-vendor.mjs';
import { REPO_ROOT } from '../../src/core/version.mjs';

const STATIC_FROM_RE = /^[ \t]*(?:import|export)\b[\s\S]*?\bfrom\s*['"]([^'"]+)['"]/gm;
const SIDE_EFFECT_IMPORT_RE = /^[ \t]*import\s*['"]([^'"]+)['"]/gm;
const DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

/**
 * @param {string} dir
 * @param {string[]} [acc]
 */
function walkMjs(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMjs(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.mjs')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Extracts all static and dynamic runtime import specifiers from a source file
 * (stripping block and line comments so JSDoc `@import` type references are ignored).
 * @param {string} filePath
 * @returns {string[]}
 */
function extractImports(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\])\/\/.*$/gm, '$1');
  const specs = [];
  for (const m of text.matchAll(STATIC_FROM_RE)) specs.push(m[1]);
  for (const m of text.matchAll(SIDE_EFFECT_IMPORT_RE)) specs.push(m[1]);
  for (const m of text.matchAll(DYNAMIC_IMPORT_RE)) specs.push(m[1]);
  return specs;
}

/**
 * Resolves a relative import specifier to a repo-relative POSIX path.
 * @param {string} fromFile
 * @param {string} spec
 */
function resolveRepoRel(fromFile, spec) {
  const resolved = path.resolve(path.dirname(fromFile), spec);
  return path.relative(REPO_ROOT, resolved).replace(/\\/g, '/');
}

/**
 * Finds directed cycles in an adjacency list using DFS.
 * @param {Map<string, string[]>} graph
 * @returns {string[][]}
 */
function findCycles(graph) {
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map();
  const stack = [];
  const cycles = [];

  const dfs = (u) => {
    color.set(u, GRAY);
    stack.push(u);
    for (const v of graph.get(u) || []) {
      if (!graph.has(v)) continue;
      const st = color.get(v) || WHITE;
      if (st === GRAY) {
        const idx = stack.indexOf(v);
        cycles.push([...stack.slice(idx), v]);
      } else if (st === WHITE) {
        dfs(v);
      }
    }
    stack.pop();
    color.set(u, BLACK);
  };

  for (const node of graph.keys()) {
    if ((color.get(node) || WHITE) === WHITE) dfs(node);
  }
  return cycles;
}

test('Architecture boundary: src/core/** only imports node:* or sibling src/core/* with zero cycles and <= 500 LOC', () => {
  const coreDir = path.join(REPO_ROOT, 'src', 'core');
  const coreFiles = walkMjs(coreDir);
  assert.ok(coreFiles.length >= 6, 'Expected core leaf modules under src/core/');

  const graph = new Map();
  for (const file of coreFiles) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 500, `Core leaf module ${rel} has ${lines} lines (> 500 ceiling)`);

    const deps = [];
    for (const spec of extractImports(file)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(
        spec.startsWith('./') || spec.startsWith('../core/'),
        `Forbidden import in ${rel}: "${spec}" — src/core/** may only import node:* or sibling src/core/*`
      );
      const target = resolveRepoRel(file, spec);
      assert.ok(
        target.startsWith('src/core/'),
        `Core boundary violation: ${rel} imports ${target} outside src/core/`
      );
      deps.push(target);
    }
    graph.set(rel, deps);
  }

  const cycles = findCycles(graph);
  assert.deepEqual(cycles, [], `Unexpected circular imports inside src/core/: ${JSON.stringify(cycles)}`);
});

test('Architecture boundary: src/kernel/** only imports node:*, src/core/*, or sibling src/kernel/** with zero cycles', () => {
  const kernelDir = path.join(REPO_ROOT, 'src', 'kernel');
  const kernelFiles = walkMjs(kernelDir);
  assert.ok(kernelFiles.length >= 9, 'Expected authoritative kernel modules under src/kernel/');

  const graph = new Map();
  for (const file of kernelFiles) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    if (rel.startsWith('src/kernel/gate/')) {
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
      assert.ok(lines <= 600, `Kernel gate module ${rel} has ${lines} lines (> 600 ceiling)`);
    }
    const deps = [];
    for (const spec of extractImports(file)) {
      if (spec.startsWith('node:')) continue;
      assert.ok(spec.startsWith('.'), `Forbidden bare package import in ${rel}: "${spec}" (root must be zero-dep)`);
      const target = resolveRepoRel(file, spec);
      const allowed = target.startsWith('src/kernel/') || target.startsWith('src/core/');
      assert.ok(
        allowed,
        `Kernel boundary violation: ${rel} imports ${target} (only node:*, src/core/*, src/kernel/* allowed)`
      );
      if (target.startsWith('src/kernel/')) deps.push(target);
    }
    graph.set(rel, deps);
  }

  const cycles = findCycles(graph);
  assert.deepEqual(cycles, [], `Unexpected circular imports inside src/kernel/: ${JSON.stringify(cycles)}`);
});

test('Architecture boundary: zero src/scripts -> templates inversions and vendor mirror is byte-identical', () => {
  const srcFiles = walkMjs(path.join(REPO_ROOT, 'src'));
  const scriptFiles = walkMjs(path.join(REPO_ROOT, 'scripts'));

  const templateInversions = [];
  for (const file of [...srcFiles, ...scriptFiles]) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    for (const spec of extractImports(file)) {
      if (spec.startsWith('node:')) continue;
      if (!spec.startsWith('.')) continue;
      const target = resolveRepoRel(file, spec);
      if (target.startsWith('templates/')) {
        templateInversions.push(`${rel} -> ${target}`);
      }
    }
  }

  assert.deepEqual(
    templateInversions,
    [],
    `Forbidden src/scripts -> templates dependency inversions found:\n${templateInversions.join('\n')}`
  );

  // Enforce byte-identical vendor mirror between src/kernel/ and templates/playwright-qa/support/
  const vendorCheck = syncTemplateVendor({ checkOnly: true });
  assert.equal(
    vendorCheck.ok,
    true,
    `Vendored template mirror drifted from src/kernel/: drifted=${JSON.stringify(vendorCheck.drifted)}, stale=${JSON.stringify(vendorCheck.stale)}. Run "npm run sync:vendor".`
  );

  // Enforce ZERO circular imports across the entire src/** module graph (WU-07).
  const srcGraph = new Map();
  for (const file of srcFiles) {
    const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
    const deps = [];
    for (const spec of extractImports(file)) {
      if (!spec.startsWith('.')) continue;
      const target = resolveRepoRel(file, spec);
      if (target.startsWith('src/')) deps.push(target);
    }
    srcGraph.set(rel, deps);
  }
  const srcCycles = findCycles(srcGraph);
  assert.deepEqual(
    srcCycles,
    [],
    `Circular imports inside src/** must be zero, found ${srcCycles.length}: ${JSON.stringify(srcCycles)}`
  );
});

test('Architecture boundary (WU-06 & WU-07): decomposed domains, MCP tools, and CLI stay <= 500 LOC with no auth-login temp codegen', () => {
  for (const domain of ['trust', 'explore', 'codemap', 'perf', 'mcp-hub', 'cli']) {
    const dir = path.join(REPO_ROOT, 'src', domain);
    const files = walkMjs(dir);
    assert.ok(files.length >= 1, `Expected decomposed modules under src/${domain}/`);
    for (const file of files) {
      const rel = path.relative(REPO_ROOT, file).replace(/\\/g, '/');
      const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).length;
      assert.ok(lines <= 500, `Decomposed module ${rel} has ${lines} lines (> 500 ceiling)`);
    }
  }
  for (const facade of ['trust', 'explore', 'codemap', 'perf', 'cli']) {
    const facadePath = path.join(REPO_ROOT, 'src', `${facade}.mjs`);
    const facadeLines = fs.readFileSync(facadePath, 'utf8').split(/\r?\n/).length;
    assert.ok(facadeLines <= 260, `Facade src/${facade}.mjs has ${facadeLines} lines (> 260 ceiling)`);
  }
  for (const mcpFile of walkMjs(path.join(REPO_ROOT, 'src', 'mcp'))) {
    const rel = path.relative(REPO_ROOT, mcpFile).replace(/\\/g, '/');
    const lines = fs.readFileSync(mcpFile, 'utf8').split(/\r?\n/).length;
    assert.ok(lines <= 500, `MCP module ${rel} has ${lines} lines (> 500 ceiling)`);
  }

  const authLoginText = fs.readFileSync(path.join(REPO_ROOT, 'src', 'auth-login.mjs'), 'utf8');
  assert.equal(authLoginText.includes('mkdtempSync'), false, 'src/auth-login.mjs must not generate temp .mjs scripts');
  assert.equal(authLoginText.includes('node:os'), false, 'src/auth-login.mjs must not write temp scripts into os.tmpdir()');
});
