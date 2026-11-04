// Pure helpers for `gitflare logs` — argument handling, the control-endpoint
// path, and line formatting. The command itself lives in commands/logs.ts.
import kleur from "kleur";

export interface LogsArgs {
  run: "latest" | number;
  job?: string;
  follow: boolean;
}

export interface LogsRun {
  id: number;
  branch: string;
  sha: string;
  mode: string;
  status: "running" | "success" | "failed" | "skipped";
  message?: string;
  jobs: Array<{ name: string; status: string; message?: string }>;
}

export interface LogsResponse {
  run: LogsRun;
  lines: string[];
  next: number;
  truncated: boolean;
  done: boolean;
}

export function parseLogsArgs(
  runArg: string | undefined,
  opts: { job?: string; follow?: boolean },
): { args?: LogsArgs; error?: string } {
  let run: LogsArgs["run"] = "latest";
  if (runArg !== undefined && runArg !== "latest") {
    const cleaned = runArg.replace(/^#/, "");
    if (!/^[1-9]\d{0,9}$/.test(cleaned)) {
      return { error: `run id must be a positive number (as shown by \`gitflare ci list\`), got "${runArg}"` };
    }
    run = Number(cleaned);
  }
  const job = opts.job?.trim();
  if (opts.job !== undefined && !job) return { error: "--job needs a job name" };
  return { args: { run, follow: !!opts.follow, ...(job ? { job } : {}) } };
}

/** Path + query for GET /control/ci/logs. */
export function logsPath(repo: string, args: Pick<LogsArgs, "run" | "job">, after = 0): string {
  const qs = new URLSearchParams({ repo, run: String(args.run), after: String(after) });
  if (args.job) qs.set("job", args.job);
  return `/control/ci/logs?${qs}`;
}

/**
 * `2026-11-04T01:02:03.456Z  [test] npm test` → `01:02:03 [test] npm test`,
 * with the job tag dimmed. When following a single job the tag is redundant
 * and dropped. Lines that don't carry a timestamp pass through unchanged.
 */
export function formatLogLine(line: string, opts: { job?: string; color?: boolean } = {}): string {
  const m = /^\d{4}-\d{2}-\d{2}T(\d{2}:\d{2}:\d{2})(?:\.\d+)?Z {2}(.*)$/s.exec(line);
  if (!m) return line;
  const [, time, rest] = m as unknown as [string, string, string];
  const color = opts.color ?? false;
  const dim = (s: string) => (color ? kleur.gray(s) : s);
  const tag = /^\[([^\]]+)\] /.exec(rest);
  if (!tag) return `${dim(time)} ${rest}`;
  const body = rest.slice(tag[0].length);
  if (opts.job && tag[1] === opts.job) return `${dim(time)} ${body}`;
  return `${dim(time)} ${color ? kleur.cyan(`[${tag[1]}]`) : `[${tag[1]}]`} ${body}`;
}

export function formatRunHeader(run: LogsRun, job?: string): string {
  const jobs = run.jobs.map((j) => `${j.name}:${j.status}`).join(" ") || "no jobs";
  return `run #${run.id} · ${run.branch} @ ${run.sha.slice(0, 8)} · ${run.mode} · ${run.status}${
    job ? ` · job ${job}` : ` · ${jobs}`
  }${run.message ? ` — ${run.message}` : ""}`;
}

export function formatRunFooter(run: LogsRun, job?: string): string {
  const j = job ? run.jobs.find((x) => x.name === job) : undefined;
  if (j) return `job ${j.name} ${j.status}${j.message ? ` — ${j.message}` : ""} (run #${run.id} ${run.status})`;
  return `run #${run.id} ${run.status}${run.message ? ` — ${run.message}` : ""}`;
}
