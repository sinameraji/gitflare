import * as p from "@clack/prompts";
import kleur from "kleur";
import { loadConfig } from "../config.js";
import { pickRepo } from "../repo-select.js";
import { ciSecret, controlFetch } from "./ci.js";
import {
  parseLogsArgs,
  logsPath,
  formatLogLine,
  formatRunHeader,
  formatRunFooter,
  type LogsResponse,
} from "../logs.js";

const POLL_MS = 2_000;
const MAX_CONSECUTIVE_ERRORS = 5;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `gitflare logs [run-id] [--job <name>] [--follow] [--repo <repo>]`
 * Logs go to stdout (pipeable); the header/footer go to stderr.
 * --follow polls the CONTROL_SECRET-gated endpoint (the dashboard's WebSocket
 * sits behind Cloudflare Access, which a CLI can't pass) until the run ends,
 * and exits 1 if the run (or the selected job) failed.
 */
export async function runLogs(
  runArg: string | undefined,
  opts: { job?: string; follow?: boolean; repo?: string },
): Promise<void> {
  const parsed = parseLogsArgs(runArg, opts);
  if (!parsed.args) {
    p.log.error(parsed.error ?? "bad arguments");
    process.exitCode = 2;
    return;
  }
  const args = parsed.args;
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, opts.repo);
  if (!entry) return void (process.exitCode = 1);
  const secret = ciSecret(entry);
  if (!secret) return void (process.exitCode = 1);

  const color = process.stdout.isTTY === true;
  const err = (s: string) => process.stderr.write(`${s}\n`);
  let after = 0;
  let runId: "latest" | number = args.run;
  let first = true;
  let errors = 0;

  for (;;) {
    let body: LogsResponse;
    try {
      const res = await controlFetch(entry, secret, logsPath(entry.artifactsRepoName, { run: runId, ...(args.job ? { job: args.job } : {}) }, after));
      if (!res.ok) {
        const text = await res.text();
        let msg = text;
        try {
          const j = JSON.parse(text) as { error?: string; jobs?: string[] };
          msg = j.error ?? text;
          if (j.jobs) msg += ` (jobs: ${j.jobs.join(", ") || "none"})`;
        } catch {
          // not JSON
        }
        p.log.error(`${res.status}: ${msg}`);
        process.exitCode = 1;
        return;
      }
      body = (await res.json()) as LogsResponse;
      errors = 0;
    } catch (e) {
      if (!args.follow || ++errors >= MAX_CONSECUTIVE_ERRORS) {
        p.log.error((e as Error).message);
        process.exitCode = 1;
        return;
      }
      await sleep(POLL_MS * errors);
      continue;
    }

    if (first) {
      first = false;
      runId = body.run.id; // pin "latest" so a newer run can't splice in mid-follow
      err(kleur.bold(formatRunHeader(body.run, args.job)));
      if (body.truncated) err(kleur.gray("… earlier lines were dropped (the run log keeps the newest 500)"));
    } else if (body.truncated) {
      err(kleur.gray("… some lines were dropped while polling"));
    }
    for (const line of body.lines) process.stdout.write(`${formatLogLine(line, { ...(args.job ? { job: args.job } : {}), color })}\n`);
    after = body.next;

    if (!args.follow || body.done) {
      if (body.done || args.follow) err(kleur.bold(formatRunFooter(body.run, args.job)));
      if (args.follow) {
        const job = args.job ? body.run.jobs.find((j) => j.name === args.job) : undefined;
        const failed = job ? job.status === "failed" : body.run.status === "failed";
        if (failed) process.exitCode = 1;
      }
      return;
    }
    await sleep(POLL_MS);
  }
}
