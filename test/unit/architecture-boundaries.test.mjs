import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { REPO_ROOT } from '../../src/core/version.mjs';

const STATIC_IMPORT_RE = /(?:import|export)\s+(?:[^'"]*\s+from\s+)?['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

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
  for (const m of text.matchAll(STATIC_IMPORT_RE)) specs.push(m[1]);
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

test('Architecture ratchet: no new src/scripts -> templates inversions or extra src/** circular imports', () => {
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

  // Ratchet cap: 14 in WU-01 (12 src + 2 scripts), tightened to 0 in WU-02 when src/kernel/ lands.
  const MAX_ALLOWED_TEMPLATE_INVERSIONS = 14;
  assert.ok(
    templateInversions.length <= MAX_ALLOWED_TEMPLATE_INVERSIONS,
    `Template dependency inversions increased (${templateInversions.length} > ${MAX_ALLOWED_TEMPLATE_INVERSIONS}):\n${templateInversions.join('\n')}`
  );

  // Build src/** import graph for cycle ratchet (4 in WU-01 MCP hub/server, tightened to 0 in WU-07).
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
  const MAX_ALLOWED_SRC_CYCLES = 4;
  assert.ok(
    srcCycles.length <= MAX_ALLOWED_SRC_CYCLES,
    `Circular imports inside src/** increased (${srcCycles.length} > ${MAX_ALLOWED_SRC_CYCLES}): ${JSON.stringify(srcCycles)}`
  );
});
