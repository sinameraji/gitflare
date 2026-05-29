// Parses + validates `.gitflare/deploy.yml` into a typed workflow. Uses the
// tiny YAML-subset parser in ./yaml.ts so nested bindings/migrations work
// without a heavyweight dependency.
//
//   on: push
//   branches: [main]
//   steps:
//     - cloudflare/deploy:
//         project: my-worker
//         kind: worker            # or "pages"
//         entry: dist/worker.js   # worker: a file; pages: a directory
//         compatibility_date: "2026-05-01"
//         production_branch: main # pages: pushes to other branches → previews
//         vars:
//           API_BASE: https://example.com
//         kv:
//           - { binding: CACHE, id: "abc123" }
//         r2:
//           - { binding: BUCKET, bucket_name: my-bucket }
//         d1:
//           - { binding: DB, database_id: "xyz" }
//         migrations:
//           dir: migrations
//           database_id: "xyz"
//           apply: true           # opt-in gate; without it migrations are listed, not run

import { parseYaml, type YamlValue } from "./yaml";

export interface WorkerBindings {
  vars: Record<string, string>;
  kv: Array<{ binding: string; id: string }>;
  r2: Array<{ binding: string; bucket_name: string }>;
  d1: Array<{ binding: string; database_id: string }>;
  durable_objects: Array<{ name: string; class_name: string; script_name?: string }>;
  services: Array<{ binding: string; service: string; environment?: string }>;
}

export interface MigrationsConfig {
  dir: string;
  database_id: string;
  apply: boolean;
}

export interface DeployStep {
  type: "cloudflare/deploy";
  project: string;
  kind: "worker" | "pages";
  entry: string;
  compatibility_date?: string;
  production_branch?: string;
  bindings: WorkerBindings;
  migrations?: MigrationsConfig;
}

export interface DeployWorkflow {
  on: string[];
  branches: string[]; // empty = every branch
  steps: DeployStep[];
}

export interface ParseResult {
  workflow?: DeployWorkflow;
  error?: string;
}

function asArray(v: YamlValue | undefined): YamlValue[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: YamlValue | undefined): string | undefined {
  if (v == null) return undefined;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
}

function isObj(v: YamlValue | undefined): v is { [k: string]: YamlValue } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function emptyBindings(): WorkerBindings {
  return { vars: {}, kv: [], r2: [], d1: [], durable_objects: [], services: [] };
}

function parseBindings(step: { [k: string]: YamlValue }): WorkerBindings {
  const b = emptyBindings();
  if (isObj(step.vars)) {
    for (const [k, v] of Object.entries(step.vars)) {
      const s = asString(v);
      if (s !== undefined) b.vars[k] = s;
    }
  }
  for (const e of asArray(step.kv)) {
    if (isObj(e) && asString(e.binding) && asString(e.id))
      b.kv.push({ binding: asString(e.binding)!, id: asString(e.id)! });
  }
  for (const e of asArray(step.r2)) {
    if (isObj(e) && asString(e.binding) && asString(e.bucket_name))
      b.r2.push({ binding: asString(e.binding)!, bucket_name: asString(e.bucket_name)! });
  }
  for (const e of asArray(step.d1)) {
    if (isObj(e) && asString(e.binding) && asString(e.database_id))
      b.d1.push({ binding: asString(e.binding)!, database_id: asString(e.database_id)! });
  }
  for (const e of asArray(step.durable_objects)) {
    if (isObj(e) && asString(e.name) && asString(e.class_name)) {
      const dobj: WorkerBindings["durable_objects"][number] = {
        name: asString(e.name)!,
        class_name: asString(e.class_name)!,
      };
      const script = asString(e.script_name);
      if (script) dobj.script_name = script;
      b.durable_objects.push(dobj);
    }
  }
  for (const e of asArray(step.services)) {
    if (isObj(e) && asString(e.binding) && asString(e.service)) {
      const svc: WorkerBindings["services"][number] = {
        binding: asString(e.binding)!,
        service: asString(e.service)!,
      };
      const env = asString(e.environment);
      if (env) svc.environment = env;
      b.services.push(svc);
    }
  }
  return b;
}

export function parseDeployWorkflow(src: string): ParseResult {
  let root: YamlValue;
  try {
    root = parseYaml(src);
  } catch (e) {
    return { error: `YAML parse error: ${(e as Error).message}` };
  }
  if (!isObj(root)) return { error: "deploy.yml must be a mapping" };

  const on = asArray(root.on).map(asString).filter((s): s is string => !!s);
  if (on.length === 0) return { error: "missing `on:`" };

  const branches = asArray(root.branches).map(asString).filter((s): s is string => !!s);

  const steps: DeployStep[] = [];
  for (const raw of asArray(root.steps)) {
    if (!isObj(raw)) return { error: "each step must be a mapping" };
    const cfg = raw["cloudflare/deploy"];
    if (!isObj(cfg)) {
      const key = Object.keys(raw)[0] ?? "?";
      return { error: `unsupported step "${key}" (only cloudflare/deploy in v0.2)` };
    }
    const project = asString(cfg.project);
    const entry = asString(cfg.entry);
    const kind = (asString(cfg.kind) ?? "worker") as DeployStep["kind"];
    if (!project) return { error: "step missing `project`" };
    if (!entry) return { error: "step missing `entry`" };
    if (kind !== "worker" && kind !== "pages") {
      return { error: `unsupported kind "${kind}" (worker | pages)` };
    }

    const step: DeployStep = {
      type: "cloudflare/deploy",
      project,
      kind,
      entry,
      bindings: parseBindings(cfg),
    };
    const compat = asString(cfg.compatibility_date);
    if (compat) step.compatibility_date = compat;
    const prodBranch = asString(cfg.production_branch);
    if (prodBranch) step.production_branch = prodBranch;

    if (isObj(cfg.migrations)) {
      const dir = asString(cfg.migrations.dir);
      const databaseId = asString(cfg.migrations.database_id);
      if (dir && databaseId) {
        step.migrations = {
          dir,
          database_id: databaseId,
          apply: cfg.migrations.apply === true,
        };
      }
    }
    steps.push(step);
  }

  if (steps.length === 0) return { error: "no steps defined" };
  return { workflow: { on, branches, steps } };
}

/** Does this workflow run for a push to `ref` (e.g. "refs/heads/main")? */
export function matchesPush(wf: DeployWorkflow, ref: string): boolean {
  if (!wf.on.includes("push")) return false;
  if (wf.branches.length === 0) return true;
  return wf.branches.includes(branchOf(ref));
}

export function branchOf(ref: string): string {
  return ref.replace(/^refs\/heads\//, "");
}
