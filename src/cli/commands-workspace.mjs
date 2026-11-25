// @ts-check
import { runUpdateAgents } from '../agents.mjs';
import { runAuthLoginCommand } from '../auth-login.mjs';
import { runBootstrapCommand } from '../bootstrap.mjs';
import { runMapCommand } from '../codemap.mjs';
import { runDoctor } from '../doctor.mjs';
import { runExploreCommand } from '../explore.mjs';
import { runInit } from '../init.mjs';
import { runMcpCommand } from '../mcp-hub.mjs';
import { runMcpServeCommand } from '../mcp-server.mjs';
import { runSkillInstallCommand } from '../skill-install.mjs';
import { runUpgradeCommand } from '../upgrade.mjs';

import { BOOL, STR, TARGET_OPTS, WORKSPACE_MUTATION_OPTS, makeCommon } from './opts.mjs';

/**
 * Workspace initialization, discovery, exploration, and setup CLI commands (`WU-04`).
 */
export const WORKSPACE_CLI_COMMANDS = {
  doctor: {
    options: { ...TARGET_OPTS },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runDoctor(makeCommon(v, lang)),
  },
  init: {
    requireTarget: true,
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      name: STR,
      preset: STR,
      loop: STR,
      'skip-install': BOOL,
      'skip-browser': BOOL,
      'bridge-root': BOOL,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runInit({
        ...makeCommon(v, lang),
        name: v.name,
        preset: v.preset,
        loop: v.loop,
        skipInstall: Boolean(v['skip-install']),
        skipBrowser: Boolean(v['skip-browser']),
        bridgeRoot: Boolean(v['bridge-root']),
      }),
  },
  bootstrap: {
    requireTarget: true,
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      'base-url': STR,
      'health-path': STR,
      port: STR,
      preset: STR,
      loop: STR,
      'skip-install': BOOL,
      'skip-browser': BOOL,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runBootstrapCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        healthPath: v['health-path'],
        port: v.port ? Number(v.port) : undefined,
        preset: v.preset,
        loop: v.loop,
        skipInstall: Boolean(v['skip-install']),
        skipBrowser: Boolean(v['skip-browser']),
      }),
  },
  upgrade: {
    requireTarget: true,
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      scope: STR,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runUpgradeCommand({
        ...makeCommon(v, lang),
        scope: typeof v.scope === 'string' ? v.scope : undefined,
      }),
  },
  'auth-login': {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'base-url': STR,
      account: STR,
      'login-path': STR,
      'cdp-url': STR,
      timeout: STR,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runAuthLoginCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        account: v.account,
        loginPath: v['login-path'],
        cdpUrl: v['cdp-url'],
        timeout: v.timeout ? Number(v.timeout) : undefined,
      }),
  },
  explore: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      'base-url': STR,
      'entry-path': STR,
      'max-pages': STR,
      'max-portals': STR,
      'max-tabs': STR,
      'max-dialogs': STR,
      'explore-tabs': BOOL,
      'explore-dialogs': BOOL,
      'explore-portals': BOOL,
      'no-explore-tabs': BOOL,
      'no-explore-dialogs': BOOL,
      'no-explore-portals': BOOL,
      'no-sync-impact': BOOL,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runExploreCommand({
        ...makeCommon(v, lang),
        baseUrl: v['base-url'],
        entryPath: v['entry-path'],
        maxPages: v['max-pages'] ? Number(v['max-pages']) : undefined,
        maxPortals: v['max-portals'] ? Number(v['max-portals']) : undefined,
        maxTabsPerPage: v['max-tabs'] !== undefined ? Number(v['max-tabs']) : undefined,
        maxDialogsPerPage: v['max-dialogs'] !== undefined ? Number(v['max-dialogs']) : undefined,
        exploreTabs: v['no-explore-tabs'] ? false : true,
        exploreDialogs: v['no-explore-dialogs'] ? false : true,
        explorePortals: v['no-explore-portals'] ? false : true,
        noSyncImpact: Boolean(v['no-sync-impact']),
      }),
  },
  map: {
    requireTarget: true,
    options: {
      ...TARGET_OPTS,
      force: BOOL,
      repo: STR,
      'no-sync-impact': BOOL,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runMapCommand({
        ...makeCommon(v, lang),
        repo: v.repo,
        noSyncImpact: Boolean(v['no-sync-impact']),
      }),
  },
  mcp: {
    options: {
      ...TARGET_OPTS,
      'dry-run': BOOL,
      action: STR,
      profile: STR,
      servers: STR,
      lock: BOOL,
      transport: STR,
      port: STR,
      host: STR,
      'auth-token': STR,
      'workspace-root': STR,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ pos, /** @type {'zh' | 'en'} */ lang) => {
      const action = String(v.action || pos[0] || 'presets').toLowerCase();
      if (action === 'serve') {
        return runMcpServeCommand({
          ...makeCommon(v, lang),
          transport: v.transport,
          port: v.port !== undefined ? Number(v.port) : undefined,
          host: v.host,
          authToken: v['auth-token'],
          workspaceRoots: v['workspace-root'],
        });
      }
      return runMcpCommand({
        ...makeCommon(v, lang),
        action,
        profile: v.profile,
        servers: v.servers,
        lock: Boolean(v.lock),
      });
    },
  },
  'mcp-serve': {
    options: {
      ...TARGET_OPTS,
      transport: STR,
      port: STR,
      host: STR,
      'auth-token': STR,
      'workspace-root': STR,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runMcpServeCommand({
        ...makeCommon(v, lang),
        transport: v.transport,
        port: v.port !== undefined ? Number(v.port) : undefined,
        host: v.host,
        authToken: v['auth-token'],
        workspaceRoots: v['workspace-root'],
      }),
  },
  'update-agents': {
    requireTarget: true,
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      loop: STR,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runUpdateAgents({
        ...makeCommon(v, lang),
        loop: v.loop,
      }),
  },
  'skill-install': {
    requireTarget: true,
    options: {
      ...WORKSPACE_MUTATION_OPTS,
      client: STR,
    },
    run: (/** @type {Record<string, any>} */ v, /** @type {string[]} */ _pos, /** @type {'zh' | 'en'} */ lang) =>
      runSkillInstallCommand({
        ...makeCommon(v, lang),
        client: v.client,
      }),
  },
};
