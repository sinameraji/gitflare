// Parses + validates `.gitflare/ci.yml` into a typed CI workflow (v0.3).
// Reuses the YAML-subset parser and the cloudflare/deploy step validation
// from ../deploy/workflow so both formats behave identically.
//
//   on: push
//   branches: [main]
//   jobs:
//     test:
//       steps:                    # runtime: sandbox is the default (and only
//         - run: npm ci           # supported) runtime in v0.3 M8
//         - run: npm test
//     deploy:
//       needs: [test]
//       steps:
//         - cloudflare/deploy:
//             project: my-worker
//             kind: worker
//             entry: dist/worker.js
//
// A job is EITHER a run job (only `run:` steps, executed in a Cloudflare
// Sandbox) or a deploy job (only `cloudflare/deploy:` steps, delegated to the
// DeployDO) — mixing the two in one job is a parse error, matching the GitHub
// Actions mental model of jobs as isolated machines.

import { parseYaml, type YamlValue } from "../deploy/yaml";
import {
  asArray,
  asString,
  isObj,
  parseDeployStepConfig,
  parseTriggers,
  branchOf,
  type DeployStep,
} from "../deploy/workflow";

export interface CiRunStep {
  type: "run";
  command: string;
}

export interface CiDeployStep {
  type: "cloudflare/deploy";
  step: DeployStep;
}

export interface CiJob {
  name: string;
  kind: "run" | "deploy";
  needs: string[];
  steps: Array<CiRunStep | CiDeployStep>;
  env: Record<string, string>;
  /** Wall-clock budget for the whole job (all steps cumulative). */
  timeoutMinutes: number;
}

export interface CiWorkflow {
  on: string[];
  branches: string[]; // empty = every branch
  /** In topological order (needs before dependents), ties by declaration order. */
  jobs: CiJob[];
}

export interface CiParseResult {
  workflow?: CiWorkflow;
  error?: string;
}

export const CI_WORKFLOW_PATH = ".gitflare/ci.yml";

export const DEFAULT_JOB_TIMEOUT_MINUTES = 15;
export const MAX_JOB_TIMEOUT_MINUTES = 60;

function parseJob(name: string, cfg: { [k: string]: YamlValue }): { job?: CiJob; error?: string } {
  const runtime = asString(cfg.runtime);
  if (runtime === "worker") {
    return {
      error: `job "${name}": runtime "worker" (Dynamic Workers) isn't available yet — omit it or use "sandbox"`,
    };
  }
  if (runtime !== undefined && runtime !== "sandbox") {
    return { error: `job "${name}": unsupported runtime "${runtime}" (sandbox)` };
  }
  if (cfg.image !== undefined) {
    return {
      error:
        `job "${name}": per-job images aren't supported — jobs run on the gitflare ` +
        `sandbox base image (Node 20 + Python 3.11)`,
    };
  }

  const needs = asArray(cfg.needs)
    .map(asString)
    .filter((s): s is string => !!s);

  const env: Record<string, string> = {};
  if (isObj(cfg.env)) {
    for (const [k, v] of Object.entries(cfg.env)) {
      const s = asString(v);
      if (s !== undefined) env[k] = s;
    }
  }

  let timeoutMinutes = DEFAULT_JOB_TIMEOUT_MINUTES;
  if (cfg.timeout_minutes !== undefined) {
    const t = Number(cfg.timeout_minutes);
    if (!Number.isFinite(t) || t <= 0 || t > MAX_JOB_TIMEOUT_MINUTES) {
      return {
        error: `job "${name}": timeout_minutes must be 1–${MAX_JOB_TIMEOUT_MINUTES}`,
      };
    }
    timeoutMinutes = Math.ceil(t);
  }

  const steps: Array<CiRunStep | CiDeployStep> = [];
  for (const raw of asArray(cfg.steps)) {
    if (!isObj(raw)) return { error: `job "${name}": each step must be a mapping` };
    if (raw.run !== undefined) {
      const command = asString(raw.run)?.trim();
      if (!command) return { error: `job "${name}": empty run step` };
      steps.push({ type: "run", command });
      continue;
    }
    const dcfg = raw["cloudflare/deploy"];
    if (isObj(dcfg)) {
      const parsed = parseDeployStepConfig(dcfg);
      if (parsed.error || !parsed.step) {
        return { error: `job "${name}": ${parsed.error ?? "invalid cloudflare/deploy step"}` };
      }
      steps.push({ type: "cloudflare/deploy", step: parsed.step });
      continue;
    }
    const key = Object.keys(raw)[0] ?? "?";
    return { error: `job "${name}": unsupported step "${key}" (run | cloudflare/deploy)` };
  }
  if (steps.length === 0) return { error: `job "${name}": no steps` };

  const hasRun = steps.some((s) => s.type === "run");
  const hasDeploy = steps.some((s) => s.type === "cloudflare/deploy");
  if (hasRun && hasDeploy) {
    return {
      error:
        `job "${name}": mixes run and cloudflare/deploy steps — put deploys in ` +
        `their own job gated with needs:`,
    };
  }

  return {
    job: { name, kind: hasDeploy ? "deploy" : "run", needs, steps, env, timeoutMinutes },
  };
}

/** Kahn topological sort; declaration order breaks ties. */
function orderJobs(jobs: CiJob[]): { order?: CiJob[]; error?: string } {
  const byName = new Map(jobs.map((j) => [j.name, j]));
  for (const j of jobs) {
    for (const n of j.needs) {
      if (!byName.has(n)) return { error: `job "${j.name}": needs unknown job "${n}"` };
      if (n === j.name) return { error: `job "${j.name}": needs itself` };
    }
  }
  const remaining = new Map(jobs.map((j) => [j.name, new Set(j.needs)]));
  const order: CiJob[] = [];
  while (order.length < jobs.length) {
    const ready = jobs.find(
      (j) => remaining.has(j.name) && remaining.get(j.name)!.size === 0,
    );
    if (!ready) {
      const stuck = [...remaining.keys()].join(", ");
      return { error: `dependency cycle among jobs: ${stuck}` };
    }
    order.push(ready);
    remaining.delete(ready.name);
    for (const deps of remaining.values()) deps.delete(ready.name);
  }
  return { order };
}

export function parseCiWorkflow(src: string): CiParseResult {
  let root: YamlValue;
  try {
    root = parseYaml(src);
  } catch (e) {
    return { error: `YAML parse error: ${(e as Error).message}` };
  }
  if (!isObj(root)) return { error: "ci.yml must be a mapping" };

  const triggers = parseTriggers(root);
  if (triggers.error || !triggers.on) return { error: triggers.error ?? "missing `on:`" };

  if (!isObj(root.jobs)) return { error: "missing `jobs:`" };
  const jobs: CiJob[] = [];
  for (const [name, cfg] of Object.entries(root.jobs)) {
    if (!isObj(cfg)) return { error: `job "${name}" must be a mapping` };
    const parsed = parseJob(name, cfg);
    if (parsed.error || !parsed.job) return { error: parsed.error ?? `invalid job "${name}"` };
    jobs.push(parsed.job);
  }
  if (jobs.length === 0) return { error: "no jobs defined" };

  const ordered = orderJobs(jobs);
  if (ordered.error || !ordered.order) return { error: ordered.error ?? "invalid job graph" };

  return { workflow: { on: triggers.on, branches: triggers.branches ?? [], jobs: ordered.order } };
}

/** Does this workflow run for a push to `ref` (e.g. "refs/heads/main")? */
export function ciMatchesPush(wf: CiWorkflow, ref: string): boolean {
  if (!wf.on.includes("push")) return false;
  if (wf.branches.length === 0) return true;
  return wf.branches.includes(branchOf(ref));
}

/** Names of deploy jobs, used by DeployDO manual mode ("deploy now"). */
export function deployJobsOf(wf: CiWorkflow): CiJob[] {
  return wf.jobs.filter((j) => j.kind === "deploy");
}

/**
 * Run-job names in a job's transitive `needs` closure. These are the jobs that
 * may have written build artifacts into the shared workspace; a deploy job may
 * only ship those artifacts if all of these succeeded (an empty result means
 * the deploy job built nothing and must deploy the committed file).
 */
export function runJobsInNeedsClosure(wf: CiWorkflow, jobName: string): string[] {
  const byName = new Map(wf.jobs.map((j) => [j.name, j]));
  const start = byName.get(jobName);
  if (!start) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  const stack = [...start.needs];
  while (stack.length > 0) {
    const name = stack.pop()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const dep = byName.get(name);
    if (!dep) continue;
    if (dep.kind === "run") out.push(name);
    stack.push(...dep.needs);
  }
  return out;
}

/** All cloudflare/deploy steps of one job (or of all deploy jobs when job is undefined). */
export function deployStepsOf(wf: CiWorkflow, job?: string): { steps?: DeployStep[]; error?: string } {
  const jobs = job === undefined ? deployJobsOf(wf) : wf.jobs.filter((j) => j.name === job);
  if (job !== undefined && jobs.length === 0) return { error: `no job named "${job}" in ci.yml` };
  const steps = jobs.flatMap((j) =>
    j.steps.filter((s): s is CiDeployStep => s.type === "cloudflare/deploy").map((s) => s.step),
  );
  if (steps.length === 0) return { error: "no cloudflare/deploy steps" };
  return { steps };
}
