// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { resolveQaDirectory } from './agents.mjs';
import { buildCommandResult, emitCommandResult } from './core/outcome.mjs';
import { loadVerifiedProjectGateRules, openTrustContext } from './kernel/gate-kernel.mjs';
import { annotateDiagnosedWithKnownBlockers, loadKnownBlockers, matchKnownBlocker } from './memory/blockers.mjs';
import { buildLearnProposalsMarkdown, distillMemoryProposals, parseReviewCommentsFile } from './memory/distiller.mjs';
import { buildSweepMarkdown, runRetroactiveSweep } from './memory/sweeper.mjs';

export {
  annotateDiagnosedWithKnownBlockers,
  buildLearnProposalsMarkdown,
  buildSweepMarkdown,
  distillMemoryProposals,
  loadKnownBlockers,
  matchKnownBlocker,
  parseReviewCommentsFile,
  runRetroactiveSweep,
};

/**
 * Pure read-only lessons & project memory summary (used by `aitest_report(view="lessons")`).
 * Never writes files or modifies workspace state.
 * @param {string} qaDir
 */
export function collectLessonsReport(qaDir) {
  const proposalsPath = path.join(qaDir, 'reports', 'learn-proposals.json');
  const sweepPath = path.join(qaDir, 'reports', 'learn-sweep.json');
  const blockersRes = loadKnownBlockers(qaDir);
  const trustContext = openTrustContext({ qaDir, repoDir: path.dirname(qaDir), createKeyIfMissing: false });
  const projRulesRes = loadVerifiedProjectGateRules(qaDir, { trustContext });

  /** @type {Record<string, any> | null} */
  let proposals = null;
  if (fs.existsSync(proposalsPath)) {
    try {
      proposals = JSON.parse(fs.readFileSync(proposalsPath, 'utf8'));
    } catch {
      proposals = null;
    }
  }
  if (!proposals) {
    proposals = distillMemoryProposals(qaDir, { dryRun: true });
  }

  /** @type {Record<string, any> | null} */
  let lastSweep = null;
  if (fs.existsSync(sweepPath)) {
    try {
      lastSweep = JSON.parse(fs.readFileSync(sweepPath, 'utf8'));
    } catch {
      lastSweep = null;
    }
  }

  return {
    view: 'lessons',
    qaDir,
    proposalOnly: true,
    proposalsJson: fs.existsSync(proposalsPath) ? proposalsPath : null,
    sweepJson: fs.existsSync(sweepPath) ? sweepPath : null,
    knownBlockers: blockersRes.blockers,
    openBlockerCount: blockersRes.openBlockers.length,
    sealedProjectRules: projRulesRes.ok
      ? projRulesRes.specs.map((s) => ({ id: s.id, code: s.code, title: s.title, scope: s.scope }))
      : [],
    projectRulesLocked: projRulesRes.ok,
    clusters: proposals?.clusters || [],
    candidateRuleSpecs: proposals?.candidateRuleSpecs || [],
    regressionSpecSkeletons: proposals?.regressionSpecSkeletons || [],
    managedAgentsMarkdownBlock: proposals?.managedAgentsMarkdownBlock || '',
    sources: proposals?.sources || {},
    lastSweepSummary: lastSweep
      ? {
          generatedAt: lastSweep.generatedAt,
          activeRuleCount: lastSweep.activeRuleCount,
          scannedFiles: lastSweep.scannedFiles,
          findingCount: lastSweep.findingCount,
        }
      : null,
  };
}

/**
 * CLI handler for `learn` (`--action distill | sweep`, `--sweep`, `--from-reviews <path>`, `--dry-run`, `--json`).
 * Strictly writes staging proposals or sweep reports ONLY; never auto-mutates protected governance files.
 * @param {{
 *   lang?: string;
 *   target?: string;
 *   qaDir?: string;
 *   action?: string;
 *   sweep?: boolean;
 *   fromReviews?: string;
 *   repos?: string | string[];
 *   repo?: string;
 *   maxFiles?: number | string;
 *   dryRun?: boolean;
 *   json?: boolean;
 * }} [options]
 * @returns {Promise<number>}
 */
export async function runLearnCommand(options = {}) {
  const lang = options.lang === 'zh' ? 'zh' : 'en';
  const asJson = Boolean(options.json);
  /** @param {number} exitCode @param {string} msg @param {'fail' | 'blocked' | 'usage'} [outcome] @param {string | null} [blockerKind] */
  const failLearn = (exitCode, msg, outcome = exitCode === 64 ? 'usage' : exitCode === 2 ? 'blocked' : 'fail', blockerKind = null) => {
    if (!asJson) console.error(msg);
    return emitCommandResult(
      buildCommandResult({
        tool: 'learn',
        outcome,
        ok: false,
        exitCode,
        summary: msg,
        blockerKind: blockerKind || (exitCode === 64 ? 'USAGE_ERROR' : null),
        data: { error: msg },
      }),
      { asJson, compatSpreadData: false }
    );
  };

  if (!options.target) {
    return failLearn(64, lang === 'zh' ? '缺少 --target 参数' : 'Missing --target option', 'usage');
  }
  const targetAbs = path.resolve(options.target);
  const qaDir = resolveQaDirectory(targetAbs, options.qaDir);
  if (!qaDir) {
    return failLearn(1, lang === 'zh' ? `未在 ${options.target} 找到 QA 目录` : `QA directory not found under ${options.target}`, 'fail');
  }

  const action = options.sweep ? 'sweep' : String(options.action || 'distill').toLowerCase();
  if (action !== 'distill' && action !== 'sweep') {
    return failLearn(64, `Invalid learn action "${action}". Use: distill | sweep`, 'usage');
  }

  if (action === 'sweep') {
    const repoDir = targetAbs === qaDir ? path.dirname(qaDir) : targetAbs;
    const rawRepos = [
      ...(Array.isArray(options.repos)
        ? options.repos
        : typeof options.repos === 'string'
          ? options.repos.split(',')
          : []),
      ...(typeof options.repo === 'string' ? [options.repo] : []),
    ]
      .map((s) => String(s).trim())
      .filter(Boolean);
    const maxFiles = options.maxFiles !== undefined ? Number(options.maxFiles) : undefined;
    const res = runRetroactiveSweep(qaDir, {
      repoDir,
      ...(rawRepos.length > 0 ? { repos: rawRepos } : {}),
      ...(maxFiles !== undefined && Number.isFinite(maxFiles) && maxFiles > 0 ? { maxFiles } : {}),
      dryRun: Boolean(options.dryRun),
      lang,
    });
    if (!res.ok) {
      return failLearn(
        res.exitCode,
        'error' in res && res.error ? res.error : 'Sweep blocked',
        res.outcome === 'blocked' ? 'blocked' : 'fail',
        'blockerKind' in res && res.blockerKind ? res.blockerKind : null
      );
    }
    const findingCount = 'findingCount' in res ? res.findingCount : res.sweepFindings.length;
    const sweepMdPath = 'sweepMdPath' in res ? res.sweepMdPath : null;
    const summary = `Memory sweep scanned ${res.scannedFiles} file(s) with ${res.activeRuleCount} sealed rule(s): ${findingCount} finding(s)`;
    if (!asJson) {
      console.log(`[Learn Sweep] ${summary}`);
      if (sweepMdPath) console.log(`  Sweep Report : ${sweepMdPath}`);
    }
    return emitCommandResult(
      buildCommandResult({ tool: 'learn', outcome: 'pass', ok: true, exitCode: 0, summary, data: { action: 'sweep', ...res } }),
      { asJson }
    );
  }

  let res;
  try {
    res = distillMemoryProposals(qaDir, {
      fromReviews: options.fromReviews ? path.resolve(options.fromReviews) : undefined,
      dryRun: Boolean(options.dryRun),
      lang,
    });
  } catch (err) {
    return failLearn(1, err instanceof Error ? err.message : String(err), 'fail');
  }

  const summary = `Distilled ${res.clusters.length} lesson cluster(s), ${res.candidateRuleSpecs.length} candidate rule(s), and ${res.regressionSpecSkeletons.length} regression skeleton(s) (staging proposal only)`;
  if (!asJson) {
    console.log(`[Learn Distill] ${summary}`);
    if (res.proposalsMdPath) console.log(`  Proposals MD   : ${res.proposalsMdPath}`);
    if (res.proposalsJsonPath) console.log(`  Proposals JSON : ${res.proposalsJsonPath}`);
  }
  return emitCommandResult(
    buildCommandResult({ tool: 'learn', outcome: 'pass', ok: true, exitCode: 0, summary, data: { action: 'distill', ...res } }),
    { asJson }
  );
}
