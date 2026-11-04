// Per-job commit statuses (M10). Besides the overall `gitflare/ci` status,
// every job gets its own context `gitflare/ci/<job>`, so a PR shows which job
// broke and branch protection can require individual jobs. Pure mapping —
// the CiDO decides WHEN to post, this decides WHAT.

import { CI_CONTEXT, truncateDescription, type CommitState } from "./github-status";
import type { CiJobRecord } from "../durable-objects/ci";

/** Keep contexts short and printable; GitHub shows them verbatim in PR checks. */
const MAX_CONTEXT = 100;

export interface JobStatusPost {
  context: string;
  state: CommitState;
  description: string;
  targetUrl?: string;
}

/**
 * `gitflare/ci/<job>`. Job names are YAML keys, so they can hold anything:
 * whitespace/control characters collapse to "-" and the whole context is
 * capped so a pathological name can't produce an unusable check row.
 */
export function jobStatusContext(jobName: string): string {
  const cleaned =
    jobName
      .replace(/[\s\u0000-\u001f\u007f]+/g, "-")
      .replace(/^-+|-+$/g, "") || "job";
  const ctx = `${CI_CONTEXT}/${cleaned}`;
  return ctx.length > MAX_CONTEXT ? ctx.slice(0, MAX_CONTEXT) : ctx;
}

/**
 * Dashboard link to one job's log: the runs page filtered to (run, job).
 * `base` is the run's statusTargetUrl (`<origin>/r/<repo>/ci`).
 */
export function jobLogsUrl(base: string, runId: number, jobName: string): string {
  return `${base}?run=${runId}&job=${encodeURIComponent(jobName)}#logs`;
}

/**
 * Map a job's state to the status to post, or null when there's nothing to
 * say yet (a job still queued behind its `needs` is not posted — it appears
 * as pending only once it actually starts).
 *
 * GitHub's Status API has no "skipped"/"neutral" state. A skipped job is
 * posted as `error` with a "skipped — <why>" description: it did NOT pass, so
 * a branch-protection rule requiring that job must not go green because the
 * job never ran (dependency failed, run cancelled, watchdog).
 */
export function jobCommitStatus(
  job: Pick<CiJobRecord, "name" | "status" | "message">,
  runId: number,
  base?: string,
): JobStatusPost | null {
  let state: CommitState;
  let what: string;
  switch (job.status) {
    case "pending":
      return null;
    case "running":
      state = "pending";
      what = "running";
      break;
    case "success":
      state = "success";
      what = "passed";
      break;
    case "failed":
      state = "failure";
      what = job.message ? `failed — ${job.message}` : "failed";
      break;
    case "skipped":
      state = "error";
      what = `skipped — ${job.message ?? "not run"}`;
      break;
    default:
      return null;
  }
  // Keep the description single-line: GitHub renders it in one row.
  const description = truncateDescription(`run #${runId}: ${what}`.replace(/\s+/g, " ").trim());
  return {
    context: jobStatusContext(job.name),
    state,
    description,
    ...(base ? { targetUrl: jobLogsUrl(base, runId, job.name) } : {}),
  };
}
