// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GATE_KERNEL_VERSION, WORKBENCH_VERSION } from '../../../src/app/index.mjs';
import { executeAgentAdapter, getAdapterKind, sanitizeTrajectoryText } from './agent-adapters.mjs';
import { evaluateTrial } from './evaluator.mjs';
import { createTrialSandbox, TEMPLATE_MODULES_DIR } from './sandbox.mjs';
import { buildAgenticSummary } from './stats.mjs';
import { createEphemeralFulcioCa } from './t2-ca.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_TASKS_PATH = path.join(__dirname, '..', 'tasks.json');

/**
 * Loads and filters the pre-registered FGER-agentic task corpus.
 * @param {{
 *   tasksPath?: string;
 *   taskIds?: string[] | null;
 *   attackClass?: string | null;
 *   promptTier?: string | null;
 *   threatTier?: string | null;
 * }} [filter]
 */
export function loadAgenticTasks(filter = {}) {
  const tasksPath = filter.tasksPath || DEFAULT_TASKS_PATH;
  const doc = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
  let tasks = Array.isArray(doc.tasks) ? doc.tasks : [];

  if (Array.isArray(filter.taskIds) && filter.taskIds.length > 0) {
    const wanted = new Set(filter.taskIds.map((s) => s.trim().toUpperCase()));
    tasks = tasks.filter((/** @type {any} */ t) => wanted.has(String(t.taskId).toUpperCase()));
  }
  if (filter.attackClass) {
    const cls = String(filter.attackClass).trim().toUpperCase();
    tasks = tasks.filter((/** @type {any} */ t) => String(t.attackClass).toUpperCase() === cls);
  }
  if (filter.promptTier) {
    const pt = String(filter.promptTier).trim().toLowerCase();
    tasks = tasks.filter((/** @type {any} */ t) => String(t.promptTier).toLowerCase() === pt);
  }
  if (filter.threatTier) {
    const tt = String(filter.threatTier).trim().toUpperCase();
    tasks = tasks.filter((/** @type {any} */ t) => String(t.threatTier).toUpperCase() === tt);
  }
  return tasks;
}

/**
 * Runs the FGER-agentic dual-tier benchmark across the selected tasks, adapter, and trial count.
 * @param {{
 *   adapter?: string;
 *   tasksPath?: string;
 *   taskIds?: string[] | null;
 *   attackClass?: string | null;
 *   promptTier?: string | null;
 *   threatTier?: string | null;
 *   trials?: number;
 *   fast?: boolean;
 *   agentCmd?: string;
 *   model?: string | null;
 *   timeoutMs?: number;
 *   onTrialComplete?: (trial: Record<string, any>, idx: number, total: number) => void;
 * }} [options]
 */
export async function runAgenticBenchmark(options = {}) {
  const adapter = String(options.adapter || 'scripted');
  const trialsPerTask = Math.max(1, Number(options.trials || 1));
  const hasPlaywrightPkg = fs.existsSync(path.join(TEMPLATE_MODULES_DIR, '@playwright', 'test', 'cli.js'));
  const fast = options.fast !== undefined ? Boolean(options.fast) : !hasPlaywrightPkg;

  const tasks = loadAgenticTasks({
    tasksPath: options.tasksPath,
    taskIds: options.taskIds,
    attackClass: options.attackClass,
    promptTier: options.promptTier,
    threatTier: options.threatTier,
  });

  if (tasks.length === 0) {
    throw new Error('No FGER-agentic tasks matched the specified filters.');
  }

  // Evaluator-held ephemeral Fulcio T2 Root CA (private key stays strictly in memory)
  const t2Ca = createEphemeralFulcioCa();
  /** @type {Array<Record<string, any>>} */
  const allTrials = [];
  const totalRuns = tasks.length * trialsPerTask;
  let completed = 0;

  for (const task of tasks) {
    for (let trialIdx = 1; trialIdx <= trialsPerTask; trialIdx += 1) {
      const startedAt = Date.now();
      const sandbox = await createTrialSandbox(task, { fast });
      try {
        const agentRes = await executeAgentAdapter(adapter, sandbox, task, {
          agentCmd: options.agentCmd,
          model: options.model || undefined,
          timeoutMs: options.timeoutMs,
        });
        const evaluated = await evaluateTrial(sandbox, task, agentRes, t2Ca);
        const sanitizedTrial = {
          trialIndex: trialIdx,
          durationMs: Date.now() - startedAt,
          ...evaluated,
          t1: {
            ...evaluated.t1,
            errors: (evaluated.t1.errors || []).map((/** @type {string} */ e) => sanitizeTrajectoryText(e, sandbox.trialRoot)),
          },
          t2: {
            ...evaluated.t2,
            errors: (evaluated.t2.errors || []).map((/** @type {string} */ e) => sanitizeTrajectoryText(e, sandbox.trialRoot)),
          },
        };
        allTrials.push(sanitizedTrial);
        completed += 1;
        if (typeof options.onTrialComplete === 'function') {
          options.onTrialComplete(sanitizedTrial, completed, totalRuns);
        }
      } finally {
        sandbox.cleanup();
      }
    }
  }

  return buildAgenticSummary({
    adapter,
    adapterKind: getAdapterKind(adapter),
    modelVersion: options.model || (adapter === 'scripted' ? `scripted-l1-l3-v${WORKBENCH_VERSION}` : null),
    executionMode: fast ? 'fast-simulated-oracle' : 'live-playwright',
    liveBrowserExecuted: !fast,
    gateKernelVersion: GATE_KERNEL_VERSION,
    workbenchVersion: WORKBENCH_VERSION,
    trials: allTrials,
  });
}
