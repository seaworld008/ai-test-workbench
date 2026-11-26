// @ts-check
import { runCorpusCommand } from '../corpus.mjs';
import { runLearnCommand } from '../learn.mjs';
import { runParityCommand } from '../parity.mjs';
import { BOOL, STR, STR_MULTI, TARGET_OPTS, makeCommon } from './opts.mjs';

/**
 * CLI command definitions for `parity`, `corpus`, and `learn` (`WU-A`, `WU-B`, `WU-D`).
 * Split into a dedicated module to keep `src/cli/commands.mjs` well under the 435 LOC limit.
 */
export const PARITY_CLI_COMMANDS = {
  parity: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'baseline-url': STR,
      'candidate-url': STR,
      'baseline-api-url': STR,
      'candidate-api-url': STR,
      'auth-header': STR_MULTI,
      'no-auth': BOOL,
      corpus: STR,
      routes: STR,
      'privacy-mode': STR,
      'strict-byte-escape': BOOL,
      'check-aria': BOOL,
      'allow-mutation': BOOL,
      concurrency: STR,
      'max-latency-ratio': STR,
      'max-ttft-ratio': STR,
      'dry-run': BOOL,
    },
    /** @param {Record<string, any>} v @param {string[]} _pos @param {'zh' | 'en'} lang */
    run: (v, _pos, lang) =>
      runParityCommand({
        ...makeCommon(v, lang),
        baselineUrl: v['baseline-url'],
        candidateUrl: v['candidate-url'],
        baselineApiUrl: v['baseline-api-url'],
        candidateApiUrl: v['candidate-api-url'],
        authHeaders: v['auth-header'],
        noAuth: Boolean(v['no-auth']),
        corpus: v.corpus,
        routes: v.routes,
        privacyMode: v['privacy-mode'],
        strictByteEscape: Boolean(v['strict-byte-escape']),
        checkAria: Boolean(v['check-aria']),
        allowMutation: v['allow-mutation'] === true ? true : undefined,
        concurrency: v.concurrency !== undefined ? Number(v.concurrency) : undefined,
        maxLatencyRatio: v['max-latency-ratio'] !== undefined ? Number(v['max-latency-ratio']) : undefined,
        maxTtftRatio: v['max-ttft-ratio'] !== undefined ? Number(v['max-ttft-ratio']) : undefined,
      }),
  },
  corpus: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      action: STR,
      from: STR,
      format: STR,
      output: STR,
      'allow-mutation': BOOL,
      'dry-run': BOOL,
    },
    /** @param {Record<string, any>} v @param {string[]} pos @param {'zh' | 'en'} lang */
    run: (v, pos, lang) =>
      runCorpusCommand({
        ...makeCommon(v, lang),
        action: v.action || pos[0] || 'import',
        from: v.from,
        format: v.format,
        output: v.output,
        allowMutation: Boolean(v['allow-mutation']),
      }),
  },
  learn: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      action: STR,
      sweep: BOOL,
      repo: STR_MULTI,
      'max-files': STR,
      'from-reviews': STR,
      'dry-run': BOOL,
    },
    /** @param {Record<string, any>} v @param {string[]} pos @param {'zh' | 'en'} lang */
    run: (v, pos, lang) =>
      runLearnCommand({
        ...makeCommon(v, lang),
        action: v.action || pos[0] || 'distill',
        sweep: Boolean(v.sweep),
        repo: Array.isArray(v.repo) ? v.repo[0] : v.repo,
        repos: Array.isArray(v.repo) ? v.repo : v.repo ? [v.repo] : undefined,
        maxFiles: v['max-files'] !== undefined ? Number(v['max-files']) : undefined,
        fromReviews: v['from-reviews'],
      }),
  },
};
