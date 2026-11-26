// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { computeDiagnosticFingerprint } from './fingerprint.mjs';

/**
 * @typedef {{
 *   clusterId: string;
 *   fingerprintId: string;
 *   categoryCode: string;
 *   count: number;
 *   routePattern: string;
 *   summarySignature: string;
 *   minimalReproducerSpec: string;
 *   minimalTestId: string;
 *   minimalDurationMs: number;
 *   testIds: string[];
 *   unmaskedAfterFixOf: string | null;
 * }} DiagnosticCluster
 */

/**
 * Reads the previous diagnostic clusters snapshot from `<qaDir>/reports/diagnose-clusters.json` (if any).
 * @param {string | null | undefined} qaDir
 * @returns {DiagnosticCluster[]}
 */
export function loadPreviousDiagnoseClusters(qaDir) {
  if (!qaDir) return [];
  const snapPath = path.join(qaDir, 'reports', 'diagnose-clusters.json');
  if (!fs.existsSync(snapPath)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
    return Array.isArray(parsed?.clusters) ? parsed.clusters : [];
  } catch {
    return [];
  }
}

/**
 * Persists diagnostic clusters summary to `<qaDir>/reports/diagnose-clusters.json` for masking-cascade tracking.
 * @param {string} qaDir
 * @param {DiagnosticCluster[]} clusters
 * @returns {string}
 */
export function saveDiagnoseClustersSnapshot(qaDir, clusters) {
  const reportsDir = path.join(qaDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const outPath = path.join(reportsDir, 'diagnose-clusters.json');
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        clusterCount: clusters.length,
        clusters,
      },
      null,
      2
    ) + '\n',
    'utf8'
  );
  return outPath;
}

/**
 * Clusters diagnosed failures by deterministic root-cause fingerprint, selects the fastest/simplest
 * `minimalReproducerSpec` per cluster, and annotates cascading newly-unmasked clusters (`unmaskedAfterFixOf`).
 * @param {Array<Record<string, any>>} failures
 * @param {{ qaDir?: string | null, previousClusters?: DiagnosticCluster[] | null }} [options]
 * @returns {DiagnosticCluster[]}
 */
export function clusterDiagnosedFailures(failures, options = {}) {
  const list = Array.isArray(failures) ? failures : [];
  if (list.length === 0) return [];

  /** @type {Map<string, { fp: ReturnType<typeof computeDiagnosticFingerprint>, items: Array<Record<string, any>> }>} */
  const groups = new Map();
  for (const f of list) {
    const fp = f.fingerprint || computeDiagnosticFingerprint(f);
    const key = f.fingerprintId || fp.fingerprintId;
    if (!groups.has(key)) {
      groups.set(key, { fp: { ...fp, fingerprintId: key }, items: [] });
    }
    groups.get(key)?.items.push(f);
  }

  const prevList =
    Array.isArray(options.previousClusters)
      ? options.previousClusters
      : loadPreviousDiagnoseClusters(options.qaDir);

  const currentFpSet = new Set(groups.keys());
  const prevFpSet = new Set(prevList.map((c) => c.fingerprintId));

  /** @type {Map<string, DiagnosticCluster[]>} */
  const prevByRoute = new Map();
  for (const prev of prevList) {
    if (!prev?.routePattern || !prev?.fingerprintId) continue;
    const arr = prevByRoute.get(prev.routePattern) || [];
    arr.push(prev);
    prevByRoute.set(prev.routePattern, arr);
  }

  /** @type {DiagnosticCluster[]} */
  const clusters = [];
  for (const [fpId, { fp, items }] of groups.entries()) {
    const sorted = [...items].sort((a, b) => {
      const da = typeof a.durationMs === 'number' && Number.isFinite(a.durationMs) ? a.durationMs : Number.MAX_SAFE_INTEGER;
      const db = typeof b.durationMs === 'number' && Number.isFinite(b.durationMs) ? b.durationMs : Number.MAX_SAFE_INTEGER;
      if (da !== db) return da - db;
      const la = Number(a.line || 0);
      const lb = Number(b.line || 0);
      if (la !== lb) return la - lb;
      return String(a.testId || '').localeCompare(String(b.testId || ''));
    });

    const rep = sorted[0];
    const minDur = typeof rep.durationMs === 'number' && Number.isFinite(rep.durationMs) ? Math.round(rep.durationMs) : 0;

    // Masking cascade detection: if a previously dominant cluster on the same routePattern disappeared
    // and this fingerprint is newly appearing on that routePattern, link `unmaskedAfterFixOf`.
    /** @type {string | null} */
    let unmaskedAfterFixOf = null;
    if (!prevFpSet.has(fpId)) {
      const prevRouteClusters = (prevByRoute.get(fp.routePattern) || [])
        .filter((p) => !currentFpSet.has(p.fingerprintId))
        .sort((a, b) => (b.count || 0) - (a.count || 0));
      if (prevRouteClusters.length > 0) {
        unmaskedAfterFixOf = prevRouteClusters[0].fingerprintId;
      }
    }

    clusters.push({
      clusterId: `cls_${fpId.replace(/^fp_/, '')}`,
      fingerprintId: fpId,
      categoryCode: fp.categoryCode,
      count: items.length,
      routePattern: fp.routePattern,
      summarySignature: fp.summarySignature,
      minimalReproducerSpec: String(rep.file || 'unknown'),
      minimalTestId: String(rep.testId || ''),
      minimalDurationMs: minDur,
      testIds: sorted.map((item) => String(item.testId || '')),
      unmaskedAfterFixOf,
    });
  }

  clusters.sort((a, b) => b.count - a.count || a.fingerprintId.localeCompare(b.fingerprintId));
  return clusters;
}

/**
 * Formats root-cause clusters into a concise Markdown table for `ai-diagnostics.md`.
 * @param {DiagnosticCluster[]} clusters
 * @returns {string[]}
 */
export function formatClustersMarkdown(clusters) {
  if (!Array.isArray(clusters) || clusters.length === 0) return [];
  const lines = [
    '## Root-Cause Fingerprint Clusters (Deduplicated)',
    '',
    '| Cluster / Fingerprint | Class | Count | Route / Target | Minimal Reproducer (ms) | Unmasked After Fix Of | Signature |',
    '|---|---|---:|---|---:|---|---|',
  ];
  for (const c of clusters) {
    const sig = c.summarySignature.replace(/\|/g, '\\|').slice(0, 80);
    lines.push(
      `| \`${c.fingerprintId}\` | **${c.categoryCode}** | ${c.count} | \`${c.routePattern}\` | \`${c.minimalReproducerSpec}\` (${c.minimalDurationMs}ms) | ${c.unmaskedAfterFixOf ? `\`${c.unmaskedAfterFixOf}\`` : '-'} | ${sig} |`
    );
  }
  lines.push('');
  return lines;
}
