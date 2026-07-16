// Runs CI job steps inside a Cloudflare Sandbox. Kept free of the Sandbox SDK:
// everything is written against the minimal structural SandboxHandle below and
// unit-tested with fakes (the DO passes the real sandbox from getSandbox()).
//
// Token hygiene (the sandbox runs UNTRUSTED code — npm postinstall scripts et
// al): the Artifacts read token never appears in argv, in .git/config, or in
// git's stderr. Auth rides in env-scoped git config (GIT_CONFIG_* variables,
// visible only to the git commands we run), and every captured output line is
// scrubbed for the secret and its Basic-auth encoding before it reaches logs.

import type { CiJob } from "./workflow";

export interface ExecResultLike {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
}

export interface ExecOptionsLike {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  stream?: boolean;
  onOutput?: (stream: "stdout" | "stderr", data: string) => void;
}

/** Structural subset of @cloudflare/sandbox's Sandbox used by the CI runner. */
export interface SandboxHandle {
  exec(command: string, options?: ExecOptionsLike): Promise<ExecResultLike>;
  readFile(path: string): Promise<{ content: string }>;
  destroy(): Promise<void>;
}

export const REPO_DIR = "/workspace/repo";
const CLONE_TIMEOUT_MS = 5 * 60_000;
const CHECKOUT_TIMEOUT_MS = 60_000;
/** Per-job cap on captured output lines — the DO ring buffer holds 500 anyway. */
export const MAX_JOB_LOG_LINES = 1000;

// -- validation ---------------------------------------------------------------
// sha/branch/remote come from webhook JSON and are interpolated into shell
// commands run in the user's own sandbox. Injection there would "only" run in
// an environment that already executes the repo's arbitrary code, but a forged
// branch name must never be able to smuggle flags or shell syntax regardless.

export function validateCloneInputs(p: {
  remote: string;
  branch: string;
  sha: string;
}): string | null {
  if (!/^[0-9a-f]{40}$/.test(p.sha)) return `invalid sha "${p.sha.slice(0, 60)}"`;
  if (!/^[A-Za-z0-9._/-]+$/.test(p.branch) || p.branch.startsWith("-")) {
    return `invalid branch name "${p.branch.slice(0, 60)}"`;
  }
  if (!/^https:\/\/[A-Za-z0-9._~:/?#@!$&'()*+,;=%[\]-]+$/.test(p.remote) || /["'`\\\s]/.test(p.remote)) {
    return `invalid remote URL`;
  }
  return null;
}

/** Env-scoped git auth: applies only to commands we pass it to, persists nowhere. */
export function gitAuthEnv(tokenSecret: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${btoa(`x:${tokenSecret}`)}`,
  };
}

/**
 * Returns a scrubber that blanks each secret — and its Basic-auth base64 form —
 * from a log line. Belt-and-suspenders: the secrets shouldn't reach output in
 * the first place, but git error paths are creative.
 */
export function makeScrubber(secrets: string[]): (line: string) => string {
  const needles = secrets
    .filter((s) => s.length > 0)
    .flatMap((s) => [s, btoa(`x:${s}`)]);
  return (line: string): string => {
    let out = line;
    for (const n of needles) out = out.split(n).join("***");
    return out;
  };
}

/** Split streamed chunks into lines; flush() emits any unterminated remainder. */
export function makeLineBuffer(onLine: (line: string) => void): {
  push: (data: string) => void;
  flush: () => void;
} {
  let rest = "";
  return {
    push(data: string): void {
      rest += data;
      let idx: number;
      while ((idx = rest.indexOf("\n")) !== -1) {
        onLine(rest.slice(0, idx).replace(/\r$/, ""));
        rest = rest.slice(idx + 1);
      }
    },
    flush(): void {
      if (rest.trim() !== "") onLine(rest.replace(/\r$/, ""));
      rest = "";
    },
  };
}

// -- clone --------------------------------------------------------------------

export interface CloneParams {
  remote: string;
  branch: string;
  sha: string;
  tokenSecret: string;
  log: (line: string) => void;
}

export interface CloneResult {
  ok: boolean;
  message?: string;
}

/**
 * Clone the Artifacts mirror into the sandbox at REPO_DIR and check out the
 * exact sha (deepening once if the push raced HEAD past our depth).
 */
export async function cloneIntoSandbox(
  sandbox: SandboxHandle,
  p: CloneParams,
): Promise<CloneResult> {
  const invalid = validateCloneInputs(p);
  if (invalid) return { ok: false, message: invalid };
  const auth = gitAuthEnv(p.tokenSecret);

  p.log(`cloning ${p.remote} (${p.branch}) — auth via short-lived read token`);
  const clone = await sandbox.exec(
    `git clone --quiet --depth 50 --single-branch --branch ${p.branch} -- ${p.remote} ${REPO_DIR}`,
    { cwd: "/workspace", env: auth, timeout: CLONE_TIMEOUT_MS },
  );
  if (clone.exitCode !== 0) {
    return { ok: false, message: `git clone failed: ${tail(clone.stderr)}` };
  }

  const checkoutCmd = `git -c advice.detachedHead=false checkout --quiet ${p.sha}`;
  let checkout = await sandbox.exec(checkoutCmd, { cwd: REPO_DIR, timeout: CHECKOUT_TIMEOUT_MS });
  if (checkout.exitCode !== 0) {
    p.log(`sha ${p.sha.slice(0, 8)} not in shallow clone — deepening`);
    const deepen = await sandbox.exec(`git fetch --quiet --depth 500 origin ${p.branch}`, {
      cwd: REPO_DIR,
      env: auth,
      timeout: CLONE_TIMEOUT_MS,
    });
    if (deepen.exitCode !== 0) {
      return { ok: false, message: `git fetch (deepen) failed: ${tail(deepen.stderr)}` };
    }
    checkout = await sandbox.exec(checkoutCmd, { cwd: REPO_DIR, timeout: CHECKOUT_TIMEOUT_MS });
    if (checkout.exitCode !== 0) {
      return {
        ok: false,
        message: `commit ${p.sha.slice(0, 8)} not reachable on ${p.branch} (checked 500 commits deep)`,
      };
    }
  }
  p.log(`checked out ${p.sha.slice(0, 8)}`);
  return { ok: true };
}

// -- job steps ----------------------------------------------------------------

export interface JobStepOutcome {
  command: string;
  ok: boolean;
  exitCode?: number;
  detail?: string;
}

export interface RunJobResult {
  ok: boolean;
  steps: JobStepOutcome[];
  message?: string;
}

export interface RunJobParams {
  job: CiJob; // kind "run"
  meta: { repo: string; branch: string; sha: string };
  log: (line: string) => void;
  now?: () => number;
}

/** First line of a (possibly multi-line) command, for step labels. */
export function commandLabel(command: string): string {
  const first = command.split("\n", 1)[0]!.trim();
  return command.includes("\n") ? `${first} …` : first;
}

function tail(s: string, n = 300): string {
  const t = s.trim();
  return t.length > n ? `…${t.slice(-n)}` : t;
}

/**
 * Run one CI job's `run:` steps sequentially in the (already cloned) sandbox.
 * timeout_minutes is a wall-clock budget across ALL of the job's steps.
 * Note: on a step timeout the underlying process may keep running until the
 * run's sandbox is destroyed — logged so the user isn't surprised.
 */
export async function runJobSteps(
  sandbox: SandboxHandle,
  p: RunJobParams,
): Promise<RunJobResult> {
  const now = p.now ?? Date.now;
  const deadline = now() + p.job.timeoutMinutes * 60_000;
  const steps: JobStepOutcome[] = [];

  const env: Record<string, string> = {
    CI: "true",
    GITFLARE: "1",
    GITFLARE_REPO: p.meta.repo,
    GITFLARE_BRANCH: p.meta.branch,
    GITFLARE_SHA: p.meta.sha,
    ...p.job.env,
  };

  let lines = 0;
  const emit = (line: string): void => {
    lines++;
    if (lines === MAX_JOB_LOG_LINES) {
      p.log(`  … output truncated at ${MAX_JOB_LOG_LINES} lines`);
      return;
    }
    if (lines > MAX_JOB_LOG_LINES) return;
    p.log(`  ${line}`);
  };

  for (const step of p.job.steps) {
    if (step.type !== "run") continue; // parser guarantees run-only; defensive
    const label = commandLabel(step.command);
    const remaining = deadline - now();
    if (remaining <= 0) {
      steps.push({ command: label, ok: false, detail: `job timeout (${p.job.timeoutMinutes}m)` });
      return { ok: false, steps, message: `timed out after ${p.job.timeoutMinutes}m` };
    }

    p.log(`$ ${label}`);
    const buf = makeLineBuffer(emit);
    try {
      const res = await sandbox.exec(step.command, {
        cwd: REPO_DIR,
        env,
        timeout: remaining,
        stream: true,
        onOutput: (_stream, data) => buf.push(data),
      });
      buf.flush();
      if (res.exitCode !== 0) {
        // Non-streaming fallbacks put output on the result instead.
        if (lines === 0 && (res.stdout || res.stderr)) emit(tail(res.stderr || res.stdout));
        steps.push({ command: label, ok: false, exitCode: res.exitCode });
        return { ok: false, steps, message: `"${label}" exited ${res.exitCode}` };
      }
      steps.push({ command: label, ok: true, exitCode: 0 });
    } catch (e) {
      buf.flush();
      const msg = (e as Error).message;
      const timedOut = /timed?\s?out|timeout/i.test(msg);
      if (timedOut) {
        p.log(`  step hit the job's ${p.job.timeoutMinutes}m budget — its process may keep running until the sandbox is torn down`);
      }
      steps.push({ command: label, ok: false, detail: timedOut ? "timed out" : msg });
      return { ok: false, steps, message: timedOut ? `"${label}" timed out` : `"${label}": ${msg}` };
    }
  }
  return { ok: true, steps };
}

/**
 * Read a build artifact (a worker entry file) out of the sandbox so a deploy
 * job can ship what CI just built instead of a stale committed file. Returns
 * undefined when the file doesn't exist in the sandbox workspace.
 */
export const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;

export async function readArtifact(
  sandbox: SandboxHandle,
  path: string,
): Promise<{ content?: string; error?: string }> {
  if (path.includes("..") || path.startsWith("/")) return { error: `invalid entry path: ${path}` };
  try {
    const { content } = await sandbox.readFile(`${REPO_DIR}/${path}`);
    if (content.length > MAX_ARTIFACT_BYTES) {
      return { error: `built ${path} exceeds ${MAX_ARTIFACT_BYTES / 1024 / 1024}MB` };
    }
    return { content };
  } catch {
    return {}; // not built in this run — deploy falls back to the committed file
  }
}
