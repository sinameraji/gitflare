// GitHub Actions → .gitflare/ci.yml translator (PLAN §4 Stage 3: "translate
// the easy 80 %, with a clear 'couldn't translate, here's why' report").
// Pure: takes workflow file texts, returns the ci.yml text + a report.
// Deliberately conservative — anything it isn't sure about is reported, not
// guessed. The emitted YAML stays inside the subset the Worker's parser
// accepts (nested maps, block lists, inline lists, quoted scalars, `|`).

import { parse as parseYaml } from "yaml";

export interface WorkflowFile {
  name: string; // e.g. "ci.yml"
  text: string;
}

export interface ImportReport {
  /** jobs that made it into ci.yml, per source workflow */
  translated: Array<{ workflow: string; job: string; steps: number; kind: "run" | "deploy" }>;
  /** whole workflows/jobs left out, with the reason */
  dropped: Array<{ workflow: string; job?: string | undefined; reason: string }>;
  /** things translated with a caveat, or steps removed inside a kept job */
  warnings: Array<{ workflow: string; job?: string | undefined; step?: string | undefined; note: string }>;
}

export interface ImportResult {
  ciYml: string;
  report: ImportReport;
  jobCount: number;
}

interface OutRunStep {
  run: string;
}
interface OutDeployStep {
  deploy: { project: string; kind: "worker" | "pages"; entry: string; extra?: Record<string, string> | undefined };
}
interface OutJob {
  name: string;
  needs: string[];
  env: Record<string, string>;
  timeoutMinutes?: number | undefined;
  steps: Array<OutRunStep | OutDeployStep>;
}

type Any = Record<string, unknown>;

const KNOWN_DROP_ACTIONS: Array<{ re: RegExp; note?: string }> = [
  { re: /^actions\/checkout(@|$)/ }, // implicit — the sandbox clones the pushed sha
  { re: /^actions\/setup-node(@|$)/, note: "Node is preinstalled in the GitFlare sandbox (Node 20/22 image); a different `node-version` is not honoured" },
  { re: /^actions\/setup-python(@|$)/, note: "Python 3.11 is preinstalled in the GitFlare sandbox; a different `python-version` is not honoured" },
  { re: /^actions\/cache(@|$)/, note: "no build cache yet (M10: R2 cache keyed on lockfile hash) — installs run cold" },
  { re: /^actions\/upload-artifact(@|$)/, note: "jobs in one GitFlare run share a workspace, so artifacts need no upload" },
  { re: /^actions\/download-artifact(@|$)/, note: "jobs in one GitFlare run share a workspace, so artifacts need no download" },
];

const EXPR_MAP: Array<[RegExp, string]> = [
  [/\$\{\{\s*github\.sha\s*\}\}/g, "$GITFLARE_SHA"],
  [/\$\{\{\s*github\.ref_name\s*\}\}/g, "$GITFLARE_BRANCH"],
  [/\$\{\{\s*github\.repository\s*\}\}/g, "$GITFLARE_REPO"],
  [/\$\{\{\s*github\.workspace\s*\}\}/g, "$PWD"],
];

export function importActionsWorkflows(files: WorkflowFile[]): ImportResult {
  const report: ImportReport = { translated: [], dropped: [], warnings: [] };
  const jobs: OutJob[] = [];
  let branches: string[] | null = null;
  const jobOwner = new Map<string, string>(); // job name → workflow (for collisions)

  for (const file of files) {
    let doc: unknown;
    try {
      doc = parseYaml(file.text);
    } catch (e) {
      report.dropped.push({ workflow: file.name, reason: `could not parse YAML: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    if (!doc || typeof doc !== "object") {
      report.dropped.push({ workflow: file.name, reason: "empty or not a workflow" });
      continue;
    }
    const wf = doc as Any;
    const on = wf.on ?? (wf as Any)[true as unknown as string]; // `on:` parses as boolean true in YAML 1.1 — the `yaml` package keeps "on", but be safe
    const trig = triggerInfo(on);
    if (!trig.push) {
      report.dropped.push({ workflow: file.name, reason: `no \`push\` trigger (has: ${trig.others.join(", ") || "none"}) — GitFlare CI runs on push only` });
      continue;
    }
    if (trig.others.length) {
      report.warnings.push({ workflow: file.name, note: `other triggers ignored: ${trig.others.join(", ")} (GitFlare runs on push; \`gitflare ci run\` covers manual runs)` });
    }
    if (trig.paths.length || trig.pathsIgnore.length) {
      report.warnings.push({ workflow: file.name, note: "`paths` / `paths-ignore` filters aren't supported — the jobs run on every matching push" });
    }
    if (trig.tags.length) {
      report.warnings.push({ workflow: file.name, note: "tag triggers aren't supported (branch pushes only)" });
    }
    if (trig.branches.length) {
      if (branches === null) branches = [...trig.branches];
      else if (branches.join(",") !== trig.branches.join(",")) {
        report.warnings.push({
          workflow: file.name,
          note: `branch filter [${trig.branches.join(", ")}] differs from the first workflow's [${branches.join(", ")}]; ci.yml has ONE branch list — using the union`,
        });
        for (const b of trig.branches) if (!branches.includes(b)) branches.push(b);
      }
    }

    const wfJobs = (wf.jobs ?? {}) as Record<string, Any>;
    if (!wfJobs || typeof wfJobs !== "object" || Object.keys(wfJobs).length === 0) {
      report.dropped.push({ workflow: file.name, reason: "no jobs" });
      continue;
    }
    for (const [rawName, job] of Object.entries(wfJobs)) {
      for (const out of translateJob(file.name, rawName, job ?? {}, report)) {
        let name = out.name;
        if (jobOwner.has(name) && jobOwner.get(name) !== file.name) {
          const prefix = file.name.replace(/\.ya?ml$/, "").replace(/[^A-Za-z0-9_-]+/g, "-");
          name = `${prefix}-${name}`;
          report.warnings.push({ workflow: file.name, job: rawName, note: `job name collides with one in ${jobOwner.get(out.name)}; renamed to \`${name}\`` });
          out.name = name;
        }
        jobOwner.set(name, file.name);
        jobs.push(out);
      }
    }
  }

  // needs: must reference kept jobs (renamed ones keep their old name only inside the same file — best effort).
  const names = new Set(jobs.map((j) => j.name));
  for (const j of jobs) {
    const missing = j.needs.filter((n) => !names.has(n));
    if (missing.length) {
      report.warnings.push({ workflow: jobOwner.get(j.name) ?? "", job: j.name, note: `\`needs\` references dropped/unknown job(s) ${missing.join(", ")} — removed from needs` });
      j.needs = j.needs.filter((n) => names.has(n));
    }
  }

  return { ciYml: emitCiYml(branches ?? [], jobs), report, jobCount: jobs.length };
}

function triggerInfo(on: unknown): { push: boolean; branches: string[]; tags: string[]; paths: string[]; pathsIgnore: string[]; others: string[] } {
  const res = { push: false, branches: [] as string[], tags: [] as string[], paths: [] as string[], pathsIgnore: [] as string[], others: [] as string[] };
  if (typeof on === "string") {
    if (on === "push") res.push = true;
    else res.others.push(on);
    return res;
  }
  if (Array.isArray(on)) {
    for (const t of on) {
      if (t === "push") res.push = true;
      else res.others.push(String(t));
    }
    return res;
  }
  if (on && typeof on === "object") {
    for (const [k, v] of Object.entries(on as Any)) {
      if (k === "push") {
        res.push = true;
        const p = (v ?? {}) as Any;
        res.branches = strList(p.branches);
        res.tags = strList(p.tags);
        res.paths = strList(p.paths);
        res.pathsIgnore = strList(p["paths-ignore"]);
      } else res.others.push(k);
    }
  }
  return res;
}

function strList(v: unknown): string[] {
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.map(String);
  return [];
}

function translateJob(workflow: string, rawName: string, job: Any, report: ImportReport): OutJob[] {
  const name = rawName.replace(/[^A-Za-z0-9_-]+/g, "-");
  const runsOn = String(Array.isArray(job["runs-on"]) ? (job["runs-on"] as unknown[])[0] : job["runs-on"] ?? "");
  if (runsOn && !/ubuntu|linux/i.test(runsOn) && !runsOn.includes("${{")) {
    report.dropped.push({ workflow, job: rawName, reason: `runs-on: ${runsOn} — GitFlare sandboxes are Linux only` });
    return [];
  }
  if (job.uses) {
    report.dropped.push({ workflow, job: rawName, reason: `reusable workflow (\`uses: ${String(job.uses)}\`) — not supported; inline its jobs` });
    return [];
  }
  if (job.strategy && (job.strategy as Any).matrix) {
    report.warnings.push({ workflow, job: rawName, note: "`strategy.matrix` isn't supported — translated ONCE without matrix variables (fix any ${{ matrix.* }} left in the script)" });
  }
  if (job.if) report.warnings.push({ workflow, job: rawName, note: `job \`if:\` condition dropped (${String(job.if).slice(0, 60)}) — the job always runs` });
  if (job.services) report.warnings.push({ workflow, job: rawName, note: "`services:` containers aren't available — start what you need with `run:` steps" });
  if (job.container) report.warnings.push({ workflow, job: rawName, note: "`container:` isn't supported — jobs run in the GitFlare sandbox image" });

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries((job.env ?? {}) as Any)) {
    const val = envValue(String(v), workflow, rawName, undefined, report);
    if (val !== null) env[k] = val;
  }
  const needs = strList(job.needs).map((n) => n.replace(/[^A-Za-z0-9_-]+/g, "-"));
  const timeout = typeof job["timeout-minutes"] === "number" ? Math.min(60, Math.max(1, Math.round(job["timeout-minutes"] as number))) : undefined;
  if (typeof job["timeout-minutes"] === "number" && (job["timeout-minutes"] as number) > 60) {
    report.warnings.push({ workflow, job: rawName, note: "timeout-minutes capped at 60 (GitFlare's maximum)" });
  }

  const steps: Array<OutRunStep | OutDeployStep> = [];
  const rawSteps = Array.isArray(job.steps) ? (job.steps as Any[]) : [];
  for (const st of rawSteps) {
    const label = String(st.name ?? st.uses ?? (typeof st.run === "string" ? st.run.split("\n")[0] : "step")).slice(0, 60);
    if (st.if) report.warnings.push({ workflow, job: rawName, step: label, note: `step \`if:\` dropped (${String(st.if).slice(0, 50)}) — the step always runs` });
    if (typeof st.uses === "string") {
      const uses = st.uses;
      const known = KNOWN_DROP_ACTIONS.find((k) => k.re.test(uses));
      if (known) {
        if (known.note) report.warnings.push({ workflow, job: rawName, step: label, note: `\`uses: ${uses}\` dropped — ${known.note}` });
        continue;
      }
      if (/^pnpm\/action-setup(@|$)/.test(uses)) {
        const ver = (st.with as Any | undefined)?.version;
        steps.push({ run: `npm i -g pnpm${ver ? `@${String(ver)}` : ""}` });
        continue;
      }
      if (/^oven-sh\/setup-bun(@|$)/.test(uses)) {
        steps.push({ run: "npm i -g bun" });
        continue;
      }
      if (/^cloudflare\/wrangler-action(@|$)/.test(uses)) {
        const w = (st.with ?? {}) as Any;
        const dep = deployFromWranglerCommand(String(w.command ?? "deploy"), typeof w.workingDirectory === "string" ? w.workingDirectory : undefined);
        if (dep) {
          steps.push({ deploy: dep.step });
          if (dep.note) report.warnings.push({ workflow, job: rawName, step: label, note: dep.note });
          continue;
        }
        report.warnings.push({ workflow, job: rawName, step: label, note: `\`cloudflare/wrangler-action\` with command \`${String(w.command)}\` isn't a deploy — dropped` });
        continue;
      }
      report.warnings.push({ workflow, job: rawName, step: label, note: `\`uses: ${uses}\` has no GitFlare equivalent — dropped; replace with \`run:\` steps` });
      continue;
    }
    if (typeof st.run === "string") {
      // `wrangler deploy` / `wrangler pages deploy` as a run step → cloudflare/deploy
      const dep = deployFromWranglerCommand(st.run.trim(), typeof st["working-directory"] === "string" ? st["working-directory"] : undefined);
      if (dep && /^(npx\s+)?wrangler\s/.test(st.run.trim())) {
        steps.push({ deploy: dep.step });
        if (dep.note) report.warnings.push({ workflow, job: rawName, step: label, note: dep.note });
        continue;
      }
      let script = st.run;
      for (const [re, rep] of EXPR_MAP) script = script.replace(re, rep);
      const stepEnv: string[] = [];
      for (const [k, v] of Object.entries((st.env ?? {}) as Any)) {
        const val = envValue(String(v), workflow, rawName, label, report);
        if (val !== null) stepEnv.push(`export ${k}=${shellQuote(val)}`);
      }
      if (/\$\{\{/.test(script)) {
        report.warnings.push({ workflow, job: rawName, step: label, note: "contains `${{ … }}` expressions GitFlare can't evaluate — left in place; edit by hand" });
      }
      if (/\$GITHUB_OUTPUT|\$GITHUB_ENV|\$GITHUB_STEP_SUMMARY/.test(script)) {
        report.warnings.push({ workflow, job: rawName, step: label, note: "uses $GITHUB_OUTPUT / $GITHUB_ENV — no step-output mechanism in GitFlare; use plain shell variables within one step" });
      }
      if (st.shell && !/^(bash|sh)\b/.test(String(st.shell))) {
        report.warnings.push({ workflow, job: rawName, step: label, note: `shell: ${String(st.shell)} — GitFlare runs steps with sh/bash` });
      }
      const wd = typeof st["working-directory"] === "string" ? st["working-directory"] : undefined;
      const lines = [...(wd ? [`cd ${shellQuote(wd)}`] : []), ...stepEnv, script.replace(/\s+$/, "")];
      steps.push({ run: lines.join("\n") });
      continue;
    }
    report.warnings.push({ workflow, job: rawName, step: label, note: "step has neither `run` nor `uses` — dropped" });
  }

  if (steps.length === 0) {
    report.dropped.push({ workflow, job: rawName, reason: "no translatable steps" });
    return [];
  }
  const hasDeploy = steps.some((s) => "deploy" in s);
  if (hasDeploy) {
    // A wrangler install only existed to run wrangler; the deploy step replaces it.
    const before = steps.length;
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i]!;
      if ("run" in st && /^(npm|pnpm|yarn)\s+(install|i|add)\s+(-g|--global)\s+wrangler(@\S+)?\s*$/.test(st.run.trim())) steps.splice(i, 1);
    }
    if (steps.length !== before) report.warnings.push({ workflow, job: rawName, note: "`npm install -g wrangler` dropped — the cloudflare/deploy step doesn't need it" });
  }
  const hasRun = steps.some((s) => "run" in s);
  if (hasRun && hasDeploy) {
    // GitFlare: a job is either run steps or deploy steps. Split: run job + deploy job that needs it.
    const depName = /deploy/i.test(name) ? `${name}-ship` : `${name}-deploy`;
    const runJob: OutJob = { name, needs, env, timeoutMinutes: timeout, steps: steps.filter((s) => "run" in s) };
    const depJob: OutJob = { name: depName, needs: [name], env: {}, steps: steps.filter((s) => "deploy" in s) };
    report.warnings.push({ workflow, job: rawName, note: `mixed run + deploy steps split into \`${name}\` (run) and \`${depName}\` (deploy, needs ${name})` });
    report.translated.push({ workflow, job: rawName, steps: runJob.steps.length, kind: "run" });
    report.translated.push({ workflow, job: `${rawName} (deploy)`, steps: depJob.steps.length, kind: "deploy" });
    return [runJob, depJob];
  }
  report.translated.push({ workflow, job: rawName, steps: steps.length, kind: hasDeploy ? "deploy" : "run" });
  return [{ name, needs, env, timeoutMinutes: timeout, steps }];
}

function envValue(v: string, workflow: string, job: string, step: string | undefined, report: ImportReport): string | null {
  if (/\$\{\{\s*secrets\./.test(v)) {
    report.warnings.push({ workflow, job, step, note: `env uses \`${v.trim()}\` — GitFlare CI has no secrets store yet; the variable was left OUT (M10)` });
    return null;
  }
  let out = v;
  for (const [re, rep] of EXPR_MAP) out = out.replace(re, rep);
  if (/\$\{\{/.test(out)) report.warnings.push({ workflow, job, step, note: `env value \`${v.trim()}\` contains an expression GitFlare can't evaluate — kept verbatim` });
  return out;
}

/** `wrangler deploy [--name X]` / `wrangler pages deploy <dir> --project-name=X` → cloudflare/deploy skeleton. */
export function deployFromWranglerCommand(
  command: string,
  workingDirectory?: string,
): { step: OutDeployStep["deploy"]; note?: string | undefined } | null {
  const c = command.replace(/^npx\s+/, "").replace(/^wrangler\s+/, "").trim();
  const pages = /^pages\s+deploy\s+(\S+)(.*)$/.exec(c);
  if (pages) {
    const dir = pages[1]!;
    const rest = pages[2] ?? "";
    const proj = /--project-name[= ]+(\S+)/.exec(rest)?.[1] ?? "<pages-project>";
    const branch = /--branch[= ]+(\S+)/.exec(rest)?.[1];
    return {
      step: { project: proj, kind: "pages", entry: workingDirectory ? `${workingDirectory.replace(/\/$/, "")}/${dir}` : dir, extra: branch ? { production_branch: branch } : undefined },
      note: proj === "<pages-project>" ? "`wrangler pages deploy` had no --project-name; fill `project:` in ci.yml" : undefined,
    };
  }
  if (/^deploy(\s|$)/.test(c) || c === "publish") {
    const nameFlag = /--name[= ]+(\S+)/.exec(c)?.[1];
    return {
      step: { project: nameFlag ?? "<worker-name>", kind: "worker", entry: "<path/to/built/worker.js>" },
      note: "`wrangler deploy` reads wrangler.toml; GitFlare's `cloudflare/deploy` needs `project:` (the Worker name) and `entry:` (the BUILT single-file module — add a build step before it). Fill both in ci.yml",
    };
  }
  return null;
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_./:=@%+,-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ---- emitter (stays inside the Worker's YAML subset) -----------------------

function yStr(s: string): string {
  // Quote when the parser could misread it; keep simple scalars bare.
  if (/^[A-Za-z0-9_./:@+-][A-Za-z0-9_./:@+ -]*$/.test(s) && !/^(true|false|null|yes|no|on|off)$/i.test(s) && !/^\d/.test(s)) return s;
  return JSON.stringify(s);
}

export function emitCiYml(branches: string[], jobs: OutJob[]): string {
  const L: string[] = [];
  L.push("# Generated by `gitflare ci import` from .github/workflows — review before committing.");
  L.push("on: push");
  if (branches.length) L.push(`branches: [${branches.map(yStr).join(", ")}]`);
  L.push("jobs:");
  for (const j of jobs) {
    L.push(`  ${j.name}:`);
    if (j.needs.length) L.push(`    needs: [${j.needs.map(yStr).join(", ")}]`);
    if (j.timeoutMinutes) L.push(`    timeout_minutes: ${j.timeoutMinutes}`);
    const envKeys = Object.keys(j.env);
    if (envKeys.length) {
      L.push("    env:");
      for (const k of envKeys) L.push(`      ${k}: ${yStr(j.env[k]!)}`);
    }
    L.push("    steps:");
    for (const s of j.steps) {
      if ("run" in s) {
        if (s.run.includes("\n")) {
          L.push("      - run: |");
          for (const line of s.run.split("\n")) L.push(line.length ? `          ${line}` : "");
        } else {
          L.push(`      - run: ${yStr(s.run)}`);
        }
      } else {
        L.push("      - cloudflare/deploy:");
        L.push(`          project: ${yStr(s.deploy.project)}`);
        L.push(`          kind: ${s.deploy.kind}`);
        L.push(`          entry: ${yStr(s.deploy.entry)}`);
        for (const [k, v] of Object.entries(s.deploy.extra ?? {})) L.push(`          ${k}: ${yStr(v)}`);
      }
    }
  }
  return L.join("\n") + "\n";
}

export function formatReport(r: ImportReport): string {
  const out: string[] = [];
  if (r.translated.length) {
    out.push(`✓ translated ${r.translated.length} job(s):`);
    for (const t of r.translated) out.push(`    ${t.workflow} › ${t.job} — ${t.steps} ${t.kind} step(s)`);
  } else out.push("✗ nothing translated");
  if (r.warnings.length) {
    out.push(`⚠ ${r.warnings.length} note(s):`);
    for (const w of r.warnings) out.push(`    ${w.workflow}${w.job ? ` › ${w.job}` : ""}${w.step ? ` › ${w.step}` : ""}: ${w.note}`);
  }
  if (r.dropped.length) {
    out.push(`✗ ${r.dropped.length} dropped:`);
    for (const d of r.dropped) out.push(`    ${d.workflow}${d.job ? ` › ${d.job}` : ""}: ${d.reason}`);
  }
  return out.join("\n");
}
