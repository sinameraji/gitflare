// Slicing a CI run's log for `gitflare logs` and the dashboard's per-job view.
// A run keeps ONE line-buffered log (capped, oldest dropped) where every job
// line is prefixed `[<job>] ` after the timestamp. `logSeq` counts every line
// ever logged for the run, so a follower can resume with `after=<seq>` even
// after old lines have been dropped from the buffer.

export interface LogSource {
  logs: string[];
  logSeq?: number;
}

export interface LogSlice {
  lines: string[];
  /** Cursor to pass as `after` on the next poll. */
  next: number;
  /** Lines between `after` and the oldest buffered line were dropped. */
  truncated: boolean;
}

/** The message part of a stamped line (`<iso>  <message>`). */
function messageOf(line: string): string {
  const i = line.indexOf("  ");
  return i >= 0 && /^\d{4}-\d{2}-\d{2}T/.test(line) ? line.slice(i + 2) : line;
}

/** True iff the line was logged by `job` (prefixed `[job] `). */
export function isJobLine(line: string, job: string): boolean {
  return messageOf(line).startsWith(`[${job}] `);
}

export function sliceRunLogs(run: LogSource, opts: { job?: string; after?: number } = {}): LogSlice {
  const total = Math.max(run.logSeq ?? run.logs.length, run.logs.length);
  const firstSeq = total - run.logs.length + 1; // seq of logs[0], 1-based
  const after = Math.max(0, opts.after ?? 0);
  const start = Math.max(0, after - firstSeq + 1);
  let lines = run.logs.slice(start);
  if (opts.job !== undefined) {
    const job = opts.job;
    lines = lines.filter((l) => isJobLine(l, job));
  }
  return { lines, next: Math.max(total, after), truncated: after < firstSeq - 1 };
}
