import { getSandbox } from "@cloudflare/sandbox";
import type { Env } from "../env";
import {
  cloneRepoAtRef,
  cloneRepoShallow,
  mintReadPassword,
  readBlobAtCommit,
  type ShallowRepo,
} from "../artifacts/content";
import { branchOf } from "../deploy/workflow";
import {
  parseCiWorkflow,
  ciMatchesPush,
  CI_WORKFLOW_PATH,
  type CiJob,
  type CiWorkflow,
} from "../ci/workflow";
import {
  cloneIntoSandbox,
  runJobSteps,
  readArtifact,
  makeScrubber,
  type SandboxHandle,
} from "../ci/sandbox-runner";
import { postCommitStatus, type CommitState } from "../ci/github-status";
import { deployStubFor, type DeployRecord } from "./deploy";

const MAX_LOG_LINES = 500;
/** Slack added on top of the summed job budgets before the watchdog fires. */
const WATCHDOG_SLACK_MS = 10 * 60_000;
const SANDBOX_READ_TOKEN_TTL_S = 600;

export interface CiJobRecord {
  name: string;
  kind: "run" | "deploy";
  status: "pending" | "running" | "success" | "failed" | "skipped";
  steps: Array<{ label: string; ok: boolean; detail?: string }>;
  message?: string;
}

export interface CiRunRecord {
  id: number;
  ref: string;
  branch: string;
  sha: string;
  mode: "push" | "manual";
  startedAt: number;
  finishedAt?: number;
  status: "running" | "success" | "failed" | "skipped";
  jobs: CiJobRecord[];
  logs: string[];
  message?: string;
  // For the watchdog + late status posts (records outlive in-memory state).
  deadlineAt?: number;
  githubFullName?: string;
  statusTargetUrl?: string;
}

export interface CiRunRequest {
  artifactsRepoName: string;
  remote: string;
  githubFullName: string;
  ref: string; // "" for manual (learned from the mirror's HEAD)
  sha: string; // "" for manual
  mode?: "push" | "manual";
  statusTargetUrl?: string;
}

/**
 * Per-repo CI pipeline runner (v0.3). Executes `.gitflare/ci.yml` jobs in a
 * Cloudflare Sandbox on the user's own account, serialized per repo like
 * DeployDO — but detached: POST /run answers 202 immediately and the pipeline
 * (minutes, not seconds) continues as pending DO work, guarded by an alarm
 * watchdog that fails interrupted runs and tears down orphaned sandboxes.
 */
export class CiDO {
  private state: DurableObjectState;
  private env: Env;
  private inFlight: Promise<unknown> | null = null;
  private current: CiRunRecord | null = null;
  private cancelRequested = false;
  // Latest queued push sha per branch — a queued run superseded by a newer
  // push records "skipped" instead of burning a sandbox. In-memory only:
  // best-effort, and an evicted queue has nothing left to supersede anyway.
  private latestPushSha = new Map<string, string>();

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/stream") {
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server);
      if (this.current) {
        server.send(JSON.stringify({ type: "snapshot", record: this.current }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/run") {
      const body = (await request.json()) as CiRunRequest;
      if ((body.mode ?? "push") === "push" && body.ref) {
        this.latestPushSha.set(branchOf(body.ref), body.sha);
      }
      // Chain behind any in-flight run, but do NOT hold this request open for
      // the pipeline — pending work keeps the DO alive.
      const prior = this.inFlight ?? Promise.resolve();
      const next = prior.then(() => this.executeRun(body));
      this.inFlight = next.catch(() => undefined);
      return Response.json({ accepted: true }, { status: 202 });
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      if (!this.current) {
        return Response.json({ accepted: false, message: "no run in progress" });
      }
      this.cancelRequested = true;
      this.log("cancel requested — tearing down the sandbox");
      await this.destroySandbox(this.current.id).catch(() => undefined);
      return Response.json({ accepted: true, runId: this.current.id }, { status: 202 });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({ runs: await this.history() });
    }
    return new Response("not found", { status: 404 });
  }

  webSocketMessage(): void {}
  webSocketClose(): void {}
  webSocketError(): void {}

  /**
   * Watchdog: fires past the current run's deadline (or after an eviction).
   * Any record still "running" whose deadline passed — or that no longer
   * matches in-memory state (the DO restarted mid-run) — is failed loudly and
   * its sandbox torn down, so the UI never shows a zombie "running" forever
   * and no orphaned container keeps billing.
   */
  async alarm(): Promise<void> {
    const runs = await this.history();
    const now = Date.now();
    for (const run of runs) {
      if (run.status !== "running") continue;
      const isCurrent = this.current?.id === run.id;
      const pastDeadline = run.deadlineAt !== undefined && now > run.deadlineAt;
      if (isCurrent && !pastDeadline) {
        // Still legitimately running — re-arm.
        if (run.deadlineAt) await this.state.storage.setAlarm(run.deadlineAt + 60_000);
        continue;
      }
      run.status = "failed";
      run.finishedAt = now;
      run.message = pastDeadline
        ? "watchdog: run exceeded its wall-clock budget"
        : "interrupted (worker restarted mid-run)";
      for (const j of run.jobs) {
        if (j.status === "running" || j.status === "pending") j.status = "skipped";
      }
      await this.record(run);
      this.broadcast({ type: "done", record: run });
      await this.destroySandbox(run.id).catch(() => undefined);
      await this.postStatus(run, "failure", run.message);
      if (isCurrent) {
        this.current = null;
        this.cancelRequested = false;
      }
    }
  }

  // -- plumbing (mirrors DeployDO) -------------------------------------------

  private broadcast(msg: unknown): void {
    const data = JSON.stringify(msg);
    for (const ws of this.state.getWebSockets()) {
      try {
        ws.send(data);
      } catch {
        // socket gone — ignore
      }
    }
  }

  private log(line: string): void {
    if (!this.current) return;
    const stamped = `${new Date().toISOString()}  ${line}`;
    this.current.logs.push(stamped);
    if (this.current.logs.length > MAX_LOG_LINES) this.current.logs.shift();
    this.broadcast({ type: "log", line: stamped });
  }

  private async nextId(): Promise<number> {
    const last = (await this.state.storage.get<number>("lastId")) ?? 0;
    const id = last + 1;
    await this.state.storage.put("lastId", id);
    return id;
  }

  private async record(r: CiRunRecord): Promise<void> {
    await this.state.storage.put<CiRunRecord>(`run:${String(r.id).padStart(10, "0")}`, r);
  }

  private async history(): Promise<CiRunRecord[]> {
    const map = await this.state.storage.list<CiRunRecord>({
      prefix: "run:",
      reverse: true,
      limit: 50,
    });
    return [...map.values()];
  }

  private async begin(
    req: CiRunRequest,
    ref: string,
    sha: string,
    mode: CiRunRecord["mode"],
    jobs: CiJobRecord[],
  ): Promise<CiRunRecord> {
    const id = await this.nextId();
    const rec: CiRunRecord = {
      id,
      ref,
      branch: branchOf(ref),
      sha,
      mode,
      startedAt: Date.now(),
      status: "running",
      jobs,
      logs: [],
      ...(req.githubFullName ? { githubFullName: req.githubFullName } : {}),
      ...(req.statusTargetUrl ? { statusTargetUrl: req.statusTargetUrl } : {}),
    };
    this.current = rec;
    this.cancelRequested = false;
    await this.record(rec);
    this.broadcast({ type: "start", record: rec });
    this.log(`ci run #${id} started (${mode}, ${rec.branch} @ ${sha.slice(0, 8)})`);
    return rec;
  }

  private async finish(
    rec: CiRunRecord,
    status: CiRunRecord["status"],
    message?: string,
  ): Promise<CiRunRecord> {
    rec.status = status;
    rec.finishedAt = Date.now();
    if (message) rec.message = message;
    this.log(`ci run #${rec.id} ${status}${message ? `: ${message}` : ""}`);
    await this.record(rec);
    this.broadcast({ type: "done", record: rec });
    this.current = null;
    this.cancelRequested = false;
    return rec;
  }

  private async postStatus(
    rec: CiRunRecord,
    state: CommitState,
    description: string,
  ): Promise<void> {
    // Soft-fail by construction: GitHub being down is gitflare's raison d'être.
    if (!rec.githubFullName || !/^[0-9a-f]{40}$/.test(rec.sha)) return;
    await postCommitStatus({
      githubFullName: rec.githubFullName,
      sha: rec.sha,
      state,
      description,
      token: this.env.GITHUB_TOKEN,
      ...(rec.statusTargetUrl ? { targetUrl: rec.statusTargetUrl } : {}),
    }).catch(() => undefined);
  }

  private sandboxName(runId: number): string {
    return `ci-${this.state.id.toString().slice(0, 16)}-r${runId}`;
  }

  private sandbox(runId: number): SandboxHandle {
    if (!this.env.SANDBOX) throw new Error("SANDBOX binding missing");
    return getSandbox(
      this.env.SANDBOX as never,
      this.sandboxName(runId),
    ) as unknown as SandboxHandle;
  }

  private async destroySandbox(runId: number): Promise<void> {
    if (!this.env.SANDBOX) return;
    await this.sandbox(runId).destroy();
  }

  // -- pipeline ---------------------------------------------------------------

  private async executeRun(req: CiRunRequest): Promise<void> {
    try {
      await this.executeRunInner(req);
    } catch (e) {
      // Never let one run poison the serialize chain.
      if (this.current) {
        await this.finish(this.current, "failed", (e as Error).message).catch(() => undefined);
      }
    }
  }

  private async executeRunInner(req: CiRunRequest): Promise<void> {
    const mode = req.mode ?? "push";

    // A queued push superseded by a newer push to the same branch is skipped
    // before it costs a clone or a sandbox.
    if (mode === "push" && req.ref) {
      const latest = this.latestPushSha.get(branchOf(req.ref));
      if (latest !== undefined && latest !== req.sha) {
        const rec = await this.begin(req, req.ref, req.sha, mode, []);
        await this.finish(rec, "skipped", `superseded by a newer push (${latest.slice(0, 8)})`);
        return;
      }
    }

    // Clone the mirror to learn/verify what we're running.
    const handle = await this.env.ARTIFACTS.get(req.artifactsRepoName);
    let shallow: ShallowRepo;
    let ref = req.ref;
    let sha = req.sha;
    try {
      if (mode === "push" && ref && /^[0-9a-f]{40}$/.test(sha)) {
        shallow = await cloneRepoAtRef(handle, req.remote, branchOf(ref), sha);
      } else {
        shallow = await cloneRepoShallow(handle, req.remote);
        ref = `refs/heads/${shallow.branchName}`;
        sha = shallow.headSha;
      }
    } catch (e) {
      const rec = await this.begin(req, ref || "refs/heads/?", sha || "0".repeat(40), mode, []);
      await this.finish(rec, "failed", `clone failed: ${(e as Error).message}`);
      return;
    }

    // No ci.yml → this push belongs to the v0.2 deploy path. Pass it through
    // to DeployDO (the webhook only fires one DO — us — when CI is enabled)
    // without minting a CI run record.
    const blob = await readBlobAtCommit(shallow, sha, CI_WORKFLOW_PATH).catch(() => null);
    if (!blob || blob.isBinary || !blob.text) {
      if (mode === "push") {
        await this.delegatePlainDeploy(req);
      } else {
        const rec = await this.begin(req, ref, sha, mode, []);
        await this.finish(rec, "skipped", `no ${CI_WORKFLOW_PATH} at ${sha.slice(0, 8)}`);
      }
      return;
    }

    const parsed = parseCiWorkflow(blob.text);
    if (parsed.error || !parsed.workflow) {
      const rec = await this.begin(req, ref, sha, mode, []);
      await this.finish(rec, "failed", `invalid ${CI_WORKFLOW_PATH}: ${parsed.error}`);
      await this.postStatus(rec, "error", `invalid ci.yml: ${parsed.error ?? ""}`);
      return;
    }
    const wf = parsed.workflow;

    if (mode !== "manual" && !ciMatchesPush(wf, ref)) {
      const rec = await this.begin(req, ref, sha, mode, []);
      await this.finish(rec, "skipped", `${branchOf(ref)} not matched by workflow branches`);
      return;
    }

    if (this.env.CI_ENABLED !== "1") {
      const rec = await this.begin(req, ref, sha, mode, []);
      await this.finish(rec, "skipped", "CI not enabled — run `gitflare ci enable`");
      return;
    }
    if (!this.env.SANDBOX) {
      // Config drift (e.g. hand-edited wrangler config): don't silently stop
      // shipping — fail the run loudly AND let the v0.2 deploy path proceed.
      const rec = await this.begin(req, ref, sha, mode, []);
      await this.finish(
        rec,
        "failed",
        "SANDBOX binding missing — rerun `gitflare ci enable`; falling back to deploy.yml",
      );
      await this.postStatus(rec, "error", "CI sandbox missing — rerun gitflare ci enable");
      if (mode === "push") await this.delegatePlainDeploy(req);
      return;
    }

    await this.runPipeline(req, wf, ref, sha, mode);
  }

  private async delegatePlainDeploy(req: CiRunRequest): Promise<void> {
    const stub = deployStubFor(this.env, req.artifactsRepoName);
    await stub
      .fetch("https://deploy-do/deploy", {
        method: "POST",
        body: JSON.stringify({
          artifactsRepoName: req.artifactsRepoName,
          remote: req.remote,
          ref: req.ref,
          sha: req.sha,
        }),
      })
      .catch(() => undefined);
  }

  private async runPipeline(
    req: CiRunRequest,
    wf: CiWorkflow,
    ref: string,
    sha: string,
    mode: CiRunRecord["mode"],
  ): Promise<void> {
    const jobRecords: CiJobRecord[] = wf.jobs.map((j) => ({
      name: j.name,
      kind: j.kind,
      status: "pending",
      steps: [],
    }));
    const rec = await this.begin(req, ref, sha, mode, jobRecords);

    // Watchdog: sum of job budgets + slack. Survives eviction via storage.
    const budgetMs =
      wf.jobs.reduce((ms, j) => ms + j.timeoutMinutes * 60_000, 0) + WATCHDOG_SLACK_MS;
    rec.deadlineAt = rec.startedAt + budgetMs;
    await this.record(rec);
    await this.state.storage.setAlarm(rec.deadlineAt + 60_000);

    await this.postStatus(rec, "pending", `run #${rec.id} started`);

    const branch = branchOf(ref);
    let sandboxCreated = false;
    // Mutated inside closures — TS control flow can't see that, so expose the
    // bits the loop body needs as thunks instead of comparing the `let` direct.
    let cloneState: "pending" | "ok" | "failed" = "pending";
    const cloneOk = (): boolean => cloneState === "ok";
    let scrub: (line: string) => string = (l) => l;
    let failedJob: string | undefined;

    const statusOf = (name: string): CiJobRecord["status"] =>
      rec.jobs.find((j) => j.name === name)?.status ?? "pending";

    try {
      for (const job of wf.jobs) {
        const jr = rec.jobs.find((j) => j.name === job.name)!;

        if (this.cancelRequested) {
          jr.status = "skipped";
          jr.message = "cancelled";
          continue;
        }
        const blocked = job.needs.find((n) => statusOf(n) !== "success");
        if (blocked) {
          jr.status = "skipped";
          jr.message = `dependency "${blocked}" ${statusOf(blocked)}`;
          this.log(`[${job.name}] skipped — ${jr.message}`);
          await this.record(rec);
          continue;
        }

        jr.status = "running";
        await this.record(rec);
        this.log(`[${job.name}] started (${job.kind} job)`);

        const outcome =
          job.kind === "deploy"
            ? await this.runDeployJob(req, job, rec, sandboxCreated && cloneOk())
            : await this.runSandboxJob(req, job, rec, branch, sha, {
                ensureClone: async () => {
                  if (cloneState !== "pending") return cloneState === "ok";
                  const repoHandle = await this.env.ARTIFACTS.get(req.artifactsRepoName);
                  const tokenSecret = await mintReadPassword(repoHandle, SANDBOX_READ_TOKEN_TTL_S);
                  scrub = makeScrubber([tokenSecret]);
                  sandboxCreated = true;
                  const res = await cloneIntoSandbox(this.sandbox(rec.id), {
                    remote: req.remote,
                    branch,
                    sha,
                    tokenSecret,
                    log: (l) => this.log(`[${job.name}] ${scrub(l)}`),
                  });
                  cloneState = res.ok ? "ok" : "failed";
                  if (!res.ok) this.log(`[${job.name}] ${scrub(res.message ?? "clone failed")}`);
                  return res.ok;
                },
                scrub: (l) => scrub(l),
              });

        jr.status = outcome.ok ? "success" : "failed";
        if (outcome.message) jr.message = outcome.message;
        jr.steps = outcome.steps;
        if (!outcome.ok && !failedJob) failedJob = job.name;
        this.log(`[${job.name}] ${outcome.ok ? "✓ success" : `✗ failed${outcome.message ? ` — ${outcome.message}` : ""}`}`);
        await this.record(rec);
      }
    } finally {
      if (sandboxCreated) {
        await this.destroySandbox(rec.id).catch((e) =>
          this.log(`sandbox teardown failed (it will idle out): ${(e as Error).message}`),
        );
      }
    }

    if (this.cancelRequested) {
      await this.finish(rec, "failed", "cancelled");
      await this.postStatus(rec, "failure", "run cancelled");
      return;
    }
    const anyFailed = rec.jobs.some((j) => j.status === "failed");
    await this.finish(rec, anyFailed ? "failed" : "success");
    await this.postStatus(
      rec,
      anyFailed ? "failure" : "success",
      anyFailed ? `job "${failedJob}" failed` : `${rec.jobs.length} job(s) passed`,
    );
  }

  private async runSandboxJob(
    req: CiRunRequest,
    job: CiJob,
    rec: CiRunRecord,
    branch: string,
    sha: string,
    io: { ensureClone: () => Promise<boolean>; scrub: (l: string) => string },
  ): Promise<{ ok: boolean; steps: Array<{ label: string; ok: boolean; detail?: string }>; message?: string }> {
    const cloned = await io.ensureClone().catch((e) => {
      this.log(`[${job.name}] ${io.scrub((e as Error).message)}`);
      return false;
    });
    if (!cloned) {
      return { ok: false, steps: [], message: "workspace clone failed" };
    }
    try {
      const result = await runJobSteps(this.sandbox(rec.id), {
        job,
        meta: { repo: req.artifactsRepoName, branch, sha },
        log: (l) => this.log(`[${job.name}] ${io.scrub(l)}`),
      });
      return {
        ok: result.ok,
        steps: result.steps.map((s) => ({
          label: s.command,
          ok: s.ok,
          ...(s.detail ? { detail: s.detail } : {}),
        })),
        ...(result.message ? { message: result.message } : {}),
      };
    } catch (e) {
      return { ok: false, steps: [], message: io.scrub((e as Error).message) };
    }
  }

  private async runDeployJob(
    req: CiRunRequest,
    job: CiJob,
    rec: CiRunRecord,
    sandboxUsable: boolean,
  ): Promise<{ ok: boolean; steps: Array<{ label: string; ok: boolean; detail?: string }>; message?: string }> {
    // Ship what CI just built (worker entries only in M8): read built entry
    // files out of the run's sandbox and pass them as overrides — otherwise
    // the deploy would ship the stale COMMITTED file, which is exactly the
    // trap users fall into with "build then deploy" pipelines.
    const entryOverrides: Record<string, string> = {};
    if (sandboxUsable) {
      for (const step of job.steps) {
        if (step.type !== "cloudflare/deploy" || step.step.kind !== "worker") continue;
        const art = await readArtifact(this.sandbox(rec.id), step.step.entry);
        if (art.error) this.log(`[${job.name}] ${art.error}`);
        if (art.content !== undefined) {
          entryOverrides[step.step.entry] = art.content;
          this.log(`[${job.name}] using CI-built ${step.step.entry} (${art.content.length} bytes)`);
        } else if (!art.error) {
          this.log(`[${job.name}] ${step.step.entry} not built in this run — deploying the committed file`);
        }
      }
    }

    const stub = deployStubFor(this.env, req.artifactsRepoName);
    let resp: Response;
    try {
      resp = await stub.fetch("https://deploy-do/deploy", {
        method: "POST",
        body: JSON.stringify({
          artifactsRepoName: req.artifactsRepoName,
          remote: req.remote,
          ref: rec.ref,
          sha: rec.sha,
          mode: "ci",
          workflow: CI_WORKFLOW_PATH,
          job: job.name,
          ...(Object.keys(entryOverrides).length > 0 ? { entryOverrides } : {}),
        }),
      });
    } catch (e) {
      return { ok: false, steps: [], message: `deploy delegation failed: ${(e as Error).message}` };
    }

    if (!resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as { error?: string };
      return { ok: false, steps: [], message: `deploy failed: ${body.error ?? resp.status}` };
    }
    const record = (await resp.json()) as DeployRecord;
    const steps = record.steps.map((s) => ({
      label: `${s.kind}: ${s.project}`,
      ok: s.ok,
      ...(s.detail ? { detail: s.detail } : {}),
    }));
    this.log(`[${job.name}] deploy #${record.id} ${record.status} — see the deployments page for logs`);
    if (record.status === "success") return { ok: true, steps };
    // "skipped" (e.g. CD not enabled) must NOT read as green — the whole point
    // of a needs-gated deploy job is that it actually shipped.
    return {
      ok: false,
      steps,
      message:
        record.status === "skipped"
          ? `deploy skipped: ${record.message ?? "CD not enabled — run \`gitflare deploy enable\`"}`
          : `deploy #${record.id} ${record.status}${record.message ? `: ${record.message}` : ""}`,
    };
  }
}

export function ciStubFor(env: Env, artifactsRepoName: string): DurableObjectStub {
  const id = env.CI.idFromName(artifactsRepoName);
  return env.CI.get(id);
}
