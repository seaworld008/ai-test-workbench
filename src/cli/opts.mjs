// @ts-check

export const STR = /** @type {const} */ ({ type: 'string' });
export const BOOL = /** @type {const} */ ({ type: 'boolean' });

export const BASE_OPTS = {
  help: { type: /** @type {'boolean'} */ ('boolean'), short: 'h' },
  lang: STR,
  json: BOOL,
};

export const TARGET_OPTS = {
  ...BASE_OPTS,
  target: STR,
  'qa-dir': STR,
};

export const WORKSPACE_MUTATION_OPTS = {
  ...TARGET_OPTS,
  'dry-run': BOOL,
  force: BOOL,
};

/** @param {Record<string, any>} v @param {'zh' | 'en'} lang */
export function makeCommon(v, lang) {
  return {
    lang,
    target: typeof v.target === 'string' ? v.target : undefined,
    qaDir: typeof v['qa-dir'] === 'string' ? v['qa-dir'] : undefined,
    dryRun: Boolean(v['dry-run']),
    force: Boolean(v.force),
    json: Boolean(v.json),
  };
}
