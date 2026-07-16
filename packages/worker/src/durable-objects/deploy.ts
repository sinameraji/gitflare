import type { Env } from "../env";
import {
  cloneRepoShallow,
  cloneRepoFull,
  cloneRepoAtRef,
  readBlobAtCommit,
  listFilesUnder,
} from "../artifacts/content";
import {
  parseDeployWorkflow,
  matchesPush,
  branchOf,
  type DeployStep,
  type DeployWorkflow,
} from "../deploy/workflow";
import { parseCiWorkflow, deployStepsOf, CI_WORKFLOW_PATH } from "../ci/workflow";
import {
  uploadWorkerScript,
  deployPages,
  d1Query,
  type PagesFile,
  type DeployApiResult,
} from "../deploy/cf-deploy";
import type { ShallowRepo } from "../artifacts/content";

export interface DeployStepResult {
  project: string;
  kind: string;
  ok: boolean;
  detail?: string;
  url?: string;
}

export interface DeployRecord {
  id: number;
  ref: string;
  branch: string;
  sha: string;
  mode: "push" | "manual" | "rollback" | "ci";
  startedAt: number;
  finishedAt?: number;
  status: "running" | "success" | "failed" | "skipped";
  steps: DeployStepResult[];
  logs: string[];
  message?: string;
  // v0.3: which workflow file/job produced this deploy, so rollback re-reads
  // the right steps at the target sha. Absent = the v0.2 deploy.yml path
  // (all pre-v0.3 records). job absent with workflow set = all deploy jobs.
  workflow?: string;
  job?: string;
}

interface DeployRequest {
  artifactsRepoName: string;
  remote: string;
  ref: string;
  sha: string;
  mode?: "push" | "manual" | "ci";
  // mode "ci" only: the CI pipeline names the workflow file + deploy job it is
  // delegating, and may override entry files with sandbox-built artifacts so
  // the deploy ships what CI just built instead of a stale committed file.
  workflow?: string;
  job?: string;
  entryOverrides?: Record<string, string>;
}

interface RollbackRequest {
  artifactsRepoName: string;
  remote: string;
  toDeployId?: number; // omitted → most recent successful deploy
}

const WORKFLOW_PATH = ".gitflare/deploy.yml";
const MAX_LOG_LINES = 500;
const CONTENT_TYPES: Record<string, string> = {
  html: "text/html",
  css: "text/css",
  js: "application/javascript",
  mjs: "application/javascript",
  json: "application/json",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  txt: "text/plain",
  wasm: "application/wasm",
  map: "application/json",
};

/**
 * Per-repo deploy stream. Serializes deploys, records history + logs, runs the
 * Workers Scripts / Pages / D1 calls, and live-streams logs over a hibernatable
 * WebSocket. Mirrors RepoDO's idFromName-per-repo shape.
 */
export class DeployDO {
  private state: DurableObjectState;
  private env: Env;
  private inFlight: Promise<unknown> | null = null;
  private current: DeployRecord | null = null;

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
      // Replay the current run's logs so a late subscriber catches up.
      if (this.current) {
        server.send(JSON.stringify({ type: "snapshot", record: this.current }));
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "POST" && url.pathname === "/deploy") {
      const body = (await request.json()) as DeployRequest;
      return this.serialize(() => this.runDeploy(body));
    }
    if (request.method === "POST" && url.pathname === "/rollback") {
      const body = (await request.json()) as RollbackRequest;
      return this.serialize(() => this.runRollback(body));
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({ deploys: await this.history() });
    }
    return new Response("not found", { status: 404 });
  }

  // Hibernatable WebSocket handlers (no inbound messages expected).
  webSocketMessage(): void {}
  webSocketClose(): void {}
  webSocketError(): void {}

  private async serialize(run: () => Promise<DeployRecord>): Promise<Response> {
    const prior = this.inFlight ?? Promise.resolve();
    const next = prior.then(run);
    this.inFlight = next.catch(() => undefined);
    try {
      return Response.json(await next);
    } catch (err) {
      return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
    }
  }

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

  private async record(r: DeployRecord): Promise<void> {
    await this.state.storage.put<DeployRecord>(`deploy:${String(r.id).padStart(10, "0")}`, r);
  }

  private async begin(
    ref: string,
    sha: string,
    mode: DeployRecord["mode"],
    source?: { workflow?: string; job?: string },
  ): Promise<DeployRecord> {
    const id = await this.nextId();
    const rec: DeployRecord = {
      id,
      ref,
      branch: branchOf(ref),
      sha,
      mode,
      startedAt: Date.now(),
      status: "running",
      steps: [],
      logs: [],
      ...(source?.workflow ? { workflow: source.workflow } : {}),
      ...(source?.job ? { job: source.job } : {}),
    };
    this.current = rec;
    await this.record(rec);
    this.broadcast({ type: "start", record: rec });
    this.log(`deploy #${id} started (${mode}, ${rec.branch} @ ${sha.slice(0, 8)})`);
    return rec;
  }

  private async finish(
    rec: DeployRecord,
    status: DeployRecord["status"],
    message?: string,
  ): Promise<DeployRecord> {
    rec.status = status;
    rec.finishedAt = Date.now();
    if (message) rec.message = message;
    this.log(`deploy #${rec.id} ${status}${message ? `: ${message}` : ""}`);
    await this.record(rec);
    this.broadcast({ type: "done", record: rec });
    this.current = null;
    return rec;
  }

  private creds(): { token: string; accountId: string } | null {
    const token = this.env.CF_DEPLOY_TOKEN;
    const accountId = this.env.ACCOUNT_ID;
    if (this.env.CD_ENABLED !== "1" || !token || !accountId) return null;
    return { token, accountId };
  }

  private async loadWorkflow(
    shallow: ShallowRepo,
    commitOid: string,
  ): Promise<DeployWorkflow | { error: string }> {
    const blob = await readBlobAtCommit(shallow, commitOid, WORKFLOW_PATH).catch(() => null);
    if (!blob || blob.isBinary || !blob.text) return { error: `no ${WORKFLOW_PATH}` };
    const parsed = parseDeployWorkflow(blob.text);
    if (parsed.error || !parsed.workflow) return { error: `invalid ${WORKFLOW_PATH}: ${parsed.error}` };
    return parsed.workflow;
  }

  /** Read `.gitflare/ci.yml` at a commit and extract deploy steps (v0.3). */
  private async loadCiDeploySteps(
    shallow: ShallowRepo,
    commitOid: string,
    job?: string,
  ): Promise<{ steps: DeployStep[] } | { error: string }> {
    const blob = await readBlobAtCommit(shallow, commitOid, CI_WORKFLOW_PATH).catch(() => null);
    if (!blob || blob.isBinary || !blob.text) return { error: `no ${CI_WORKFLOW_PATH}` };
    const parsed = parseCiWorkflow(blob.text);
    if (parsed.error || !parsed.workflow)
      return { error: `invalid ${CI_WORKFLOW_PATH}: ${parsed.error}` };
    const extracted = deployStepsOf(parsed.workflow, job);
    if (extracted.error || !extracted.steps) return { error: extracted.error ?? "no deploy steps" };
    return { steps: extracted.steps };
  }

  /** Does `.gitflare/ci.yml` exist at this commit (any validity)? */
  private async ciFileExists(shallow: ShallowRepo, commitOid: string): Promise<boolean> {
    const blob = await readBlobAtCommit(shallow, commitOid, CI_WORKFLOW_PATH).catch(() => null);
    return !!blob && !blob.isBinary && !!blob.text;
  }

  // -- push / manual / CI-delegated deploy ------------------------------------

  private async runDeploy(req: DeployRequest): Promise<DeployRecord> {
    const mode = req.mode ?? "push";
    if (mode === "ci") return this.runCiDelegatedDeploy(req);

    // Clone first so a manual run (empty ref/sha — the GitHub-down escape hatch)
    // can learn the current default branch + tip from Artifacts directly.
    let shallow: ShallowRepo;
    try {
      shallow = await cloneRepoShallow(await this.env.ARTIFACTS.get(req.artifactsRepoName), req.remote);
    } catch (e) {
      const rec = await this.begin(req.ref || "refs/heads/?", req.sha || "0".repeat(40), mode);
      return this.finish(rec, "failed", `clone failed: ${(e as Error).message}`);
    }

    const ref = req.ref || `refs/heads/${shallow.branchName}`;
    const sha = req.sha || shallow.headSha;

    // v0.3: when a ci.yml is committed, the CI pipeline owns pushes. Fail
    // CLOSED rather than run deploy.yml ungated — the user added `needs:`
    // gating on purpose, and deploying around it would ship untested code.
    if (mode === "push" && (await this.ciFileExists(shallow, shallow.headSha))) {
      const rec = await this.begin(ref, sha, mode);
      return this.finish(
        rec,
        "skipped",
        this.env.CI_ENABLED === "1"
          ? `${CI_WORKFLOW_PATH} owns this push — the CI pipeline deploys (see the CI runs page)`
          : `${CI_WORKFLOW_PATH} present but CI not enabled — run \`gitflare ci enable\` (deploy.yml is not run ungated)`,
      );
    }

    // v0.3: a manual "deploy now" prefers ci.yml's deploy jobs when CI is
    // enabled and ci.yml actually has deploy jobs — the GitHub-down escape
    // hatch deploys immediately, intentionally skipping test jobs.
    if (mode === "manual" && this.env.CI_ENABLED === "1") {
      const ci = await this.loadCiDeploySteps(shallow, shallow.headSha);
      if ("steps" in ci) {
        const rec = await this.begin(ref, sha, mode, { workflow: CI_WORKFLOW_PATH });
        const creds = this.creds();
        if (!creds) return this.finish(rec, "skipped", "CD not enabled — run `gitflare deploy enable`");
        this.log(`manual deploy from ${CI_WORKFLOW_PATH} deploy jobs (test jobs intentionally skipped)`);
        const anyFailed = await this.runSteps(rec, ci.steps, shallow, shallow.headSha, creds, rec.branch);
        return this.finish(rec, anyFailed ? "failed" : "success");
      }
    }

    const rec = await this.begin(ref, sha, mode);

    const creds = this.creds();
    if (!creds) return this.finish(rec, "skipped", "CD not enabled — run `gitflare deploy enable`");

    const wf = await this.loadWorkflow(shallow, shallow.headSha);
    if ("error" in wf) return this.finish(rec, "skipped", wf.error);
    // A manual run is an explicit "deploy now" and bypasses branch matching.
    if (mode !== "manual" && !matchesPush(wf, ref)) {
      return this.finish(rec, "skipped", `${rec.branch} not matched by workflow branches`);
    }

    const anyFailed = await this.runSteps(rec, wf.steps, shallow, shallow.headSha, creds, rec.branch);
    return this.finish(rec, anyFailed ? "failed" : "success");
  }

  // -- CI-delegated deploy (v0.3) ---------------------------------------------
  // The CI pipeline already matched branches and gated on its `needs:` graph;
  // here we read the named job's deploy steps STRICTLY at the delegated sha
  // (ref-aware clone — feature branches and raced HEADs included) and ship
  // them, preferring sandbox-built entry files handed over by the CI run.

  private async runCiDelegatedDeploy(req: DeployRequest): Promise<DeployRecord> {
    const workflow = req.workflow ?? CI_WORKFLOW_PATH;
    let shallow: ShallowRepo;
    try {
      shallow = await cloneRepoAtRef(
        await this.env.ARTIFACTS.get(req.artifactsRepoName),
        req.remote,
        branchOf(req.ref),
        req.sha,
      );
    } catch (e) {
      const rec = await this.begin(req.ref, req.sha, "ci", {
        workflow,
        ...(req.job ? { job: req.job } : {}),
      });
      return this.finish(rec, "failed", `clone failed: ${(e as Error).message}`);
    }

    const rec = await this.begin(req.ref, req.sha, "ci", {
      workflow,
      ...(req.job ? { job: req.job } : {}),
    });
    const creds = this.creds();
    if (!creds) return this.finish(rec, "skipped", "CD not enabled — run `gitflare deploy enable`");

    const ci = await this.loadCiDeploySteps(shallow, req.sha, req.job);
    if ("error" in ci) return this.finish(rec, "failed", ci.error);

    const anyFailed = await this.runSteps(
      rec,
      ci.steps,
      shallow,
      req.sha,
      creds,
      rec.branch,
      req.entryOverrides,
    );
    return this.finish(rec, anyFailed ? "failed" : "success");
  }

  // -- rollback -------------------------------------------------------------

  private async runRollback(req: RollbackRequest): Promise<DeployRecord> {
    let target: DeployRecord | undefined;
    if (req.toDeployId) {
      target = await this.state.storage.get<DeployRecord>(
        `deploy:${String(req.toDeployId).padStart(10, "0")}`,
      );
    } else {
      // Default: the most recent successful, non-rollback deploy.
      const hist = await this.history();
      target = hist.find((d) => d.status === "success" && d.mode !== "rollback");
    }
    if (!target) {
      const rec = await this.begin("refs/heads/?", "0".repeat(40), "rollback");
      return this.finish(
        rec,
        "failed",
        req.toDeployId ? `deploy #${req.toDeployId} not found` : "no prior successful deploy to roll back to",
      );
    }
    // Carry the source workflow/job so a rollback-of-a-rollback re-resolves.
    const source = {
      ...(target.workflow ? { workflow: target.workflow } : {}),
      ...(target.job ? { job: target.job } : {}),
    };
    const rec = await this.begin(target.ref, target.sha, "rollback", source);
    const creds = this.creds();
    if (!creds) return this.finish(rec, "skipped", "CD not enabled");

    this.log(`rolling back to deploy #${target.id} (${target.sha.slice(0, 8)})`);
    let full: ShallowRepo;
    try {
      full = await cloneRepoFull(await this.env.ARTIFACTS.get(req.artifactsRepoName), req.remote);
    } catch (e) {
      return this.finish(rec, "failed", `full clone failed: ${(e as Error).message}`);
    }

    // Re-read the steps from whichever workflow file produced the target
    // deploy (absent workflow field = pre-v0.3 record = deploy.yml).
    let steps: DeployStep[];
    if (target.workflow === CI_WORKFLOW_PATH) {
      const ci = await this.loadCiDeploySteps(full, target.sha, target.job);
      if ("error" in ci) {
        return this.finish(rec, "failed", `cannot read workflow at target: ${ci.error}`);
      }
      steps = ci.steps;
      this.log("note: CI-built artifacts aren't stored — rolling back to the committed entry at the target sha");
    } else {
      const wf = await this.loadWorkflow(full, target.sha);
      if ("error" in wf) {
        return this.finish(rec, "failed", `cannot read workflow at target: ${wf.error}`);
      }
      steps = wf.steps;
    }

    // Rollback never re-runs migrations (they're forward-only). Note: a CI
    // deploy that shipped a sandbox-built entry rolls back to the COMMITTED
    // file at the target sha — build outputs aren't stored anywhere to replay.
    steps = steps.map((s) => {
      const { migrations, ...rest } = s;
      void migrations;
      return rest as DeployStep;
    });
    const anyFailed = await this.runSteps(rec, steps, full, target.sha, creds, target.branch);
    return this.finish(rec, anyFailed ? "failed" : "success");
  }

  // -- shared step runner ---------------------------------------------------

  private async runSteps(
    rec: DeployRecord,
    steps: DeployStep[],
    shallow: ShallowRepo,
    commitOid: string,
    creds: { token: string; accountId: string },
    branch: string,
    entryOverrides?: Record<string, string>,
  ): Promise<boolean> {
    let anyFailed = false;
    for (const step of steps) {
      this.log(`▸ ${step.kind} deploy: ${step.project}`);
      try {
        if (step.migrations?.apply) {
          const mig = await this.runMigrations(step, shallow, commitOid, creds);
          if (!mig) {
            anyFailed = true;
            rec.steps.push({ project: step.project, kind: "d1-migrations", ok: false, detail: "migration failed" });
            await this.record(rec);
            continue;
          }
        } else if (step.migrations) {
          this.log(`  migrations present but apply:false — skipping (set apply: true to run)`);
        }

        const result =
          step.kind === "pages"
            ? await this.deployPagesStep(step, shallow, commitOid, creds, branch)
            : await this.deployWorkerStep(step, shallow, commitOid, creds, entryOverrides?.[step.entry]);

        const sr: DeployStepResult = {
          project: step.project,
          kind: step.kind,
          ok: result.ok,
          ...(result.detail ? { detail: result.detail } : {}),
          ...(result.url ? { url: result.url } : {}),
        };
        rec.steps.push(sr);
        this.log(`  ${result.ok ? "✓ ok" : "✗ failed"}${result.detail ? ` — ${result.detail}` : ""}`);
        if (!result.ok) anyFailed = true;
      } catch (e) {
        anyFailed = true;
        rec.steps.push({ project: step.project, kind: step.kind, ok: false, detail: (e as Error).message });
        this.log(`  ✗ ${(e as Error).message}`);
      }
      await this.record(rec);
    }
    return anyFailed;
  }

  private async deployWorkerStep(
    step: DeployStep,
    shallow: ShallowRepo,
    commitOid: string,
    creds: { token: string; accountId: string },
    entryOverride?: string,
  ): Promise<DeployApiResult> {
    // A CI run hands over the entry it just built in the sandbox; the commit's
    // copy (often a stale checked-in artifact) is only the fallback.
    let code: string;
    if (entryOverride !== undefined) {
      code = entryOverride;
      this.log(`  uploading CI-built ${step.entry} (${code.length} bytes, ${countBindings(step)} bindings)`);
    } else {
      const entry = await readBlobAtCommit(shallow, commitOid, step.entry).catch(() => null);
      if (!entry || entry.isBinary || !entry.text) {
        return { ok: false, status: 0, detail: `entry not found or not text: ${step.entry}` };
      }
      code = entry.text;
      this.log(`  uploading ${step.entry} (${entry.size} bytes, ${countBindings(step)} bindings)`);
    }
    return uploadWorkerScript({
      accountId: creds.accountId,
      apiToken: creds.token,
      upload: {
        scriptName: step.project,
        moduleFileName: "worker.js",
        code,
        bindings: step.bindings,
        ...(step.compatibility_date ? { compatibilityDate: step.compatibility_date } : {}),
      },
    });
  }

  private async deployPagesStep(
    step: DeployStep,
    shallow: ShallowRepo,
    commitOid: string,
    creds: { token: string; accountId: string },
    branch: string,
  ): Promise<DeployApiResult> {
    const files = await listFilesUnder(shallow, commitOid, step.entry).catch(() => null);
    if (!files || files.length === 0) {
      return { ok: false, status: 0, detail: `no files under ${step.entry}` };
    }
    const isProd = step.production_branch ? branch === step.production_branch : true;
    this.log(`  uploading ${files.length} files (${isProd ? "production" : `preview: ${branch}`})`);
    const pagesFiles: PagesFile[] = files.map((f) => ({
      path: f.path,
      bytes: f.bytes,
      contentType: contentTypeFor(f.path),
    }));
    return deployPages({
      accountId: creds.accountId,
      apiToken: creds.token,
      project: step.project,
      files: pagesFiles,
      ...(isProd ? {} : { branch }),
    });
  }

  private async runMigrations(
    step: DeployStep,
    shallow: ShallowRepo,
    commitOid: string,
    creds: { token: string; accountId: string },
  ): Promise<boolean> {
    const cfg = step.migrations!;
    const files = await listFilesUnder(shallow, commitOid, cfg.dir).catch(() => null);
    if (!files) {
      this.log(`  no migrations dir: ${cfg.dir}`);
      return true;
    }
    const sqlFiles = files
      .filter((f) => f.path.endsWith(".sql"))
      .sort((a, b) => a.path.localeCompare(b.path));
    const appliedKey = `migrations:${cfg.database_id}`;
    const applied = new Set((await this.state.storage.get<string[]>(appliedKey)) ?? []);

    for (const f of sqlFiles) {
      if (applied.has(f.path)) continue;
      this.log(`  applying migration ${cfg.dir}/${f.path}`);
      const sql = new TextDecoder().decode(f.bytes);
      const res = await d1Query({
        accountId: creds.accountId,
        apiToken: creds.token,
        databaseId: cfg.database_id,
        sql,
      });
      if (!res.ok) {
        this.log(`  ✗ migration ${f.path} failed: ${res.detail ?? res.status}`);
        return false;
      }
      applied.add(f.path);
      await this.state.storage.put(appliedKey, [...applied]);
      this.log(`  ✓ migration ${f.path} applied`);
    }
    return true;
  }

  private async history(): Promise<DeployRecord[]> {
    const map = await this.state.storage.list<DeployRecord>({
      prefix: "deploy:",
      reverse: true,
      limit: 50,
    });
    return [...map.values()];
  }
}

function countBindings(step: DeployStep): number {
  const b = step.bindings;
  return (
    Object.keys(b.vars).length +
    b.kv.length +
    b.r2.length +
    b.d1.length +
    b.durable_objects.length +
    b.services.length
  );
}

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

export function deployStubFor(env: Env, artifactsRepoName: string): DurableObjectStub {
  const id = env.DEPLOY.idFromName(artifactsRepoName);
  return env.DEPLOY.get(id);
}
