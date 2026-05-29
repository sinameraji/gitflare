import type { Env } from "../env";
import { cloneRepoShallow, readBlobAt } from "../artifacts/content";
import { parseDeployWorkflow, matchesPush } from "../deploy/workflow";
import { uploadWorkerScript } from "../deploy/cf-deploy";

export interface DeployRecord {
  id: number;
  ref: string;
  sha: string;
  startedAt: number;
  finishedAt?: number;
  status: "running" | "success" | "failed" | "skipped";
  steps: Array<{ project: string; kind: string; ok: boolean; detail?: string }>;
  message?: string;
}

interface DeployRequest {
  artifactsRepoName: string;
  remote: string;
  ref: string;
  sha: string;
}

const WORKFLOW_PATH = ".gitflare/deploy.yml";

/**
 * Per-repo deploy stream. Serializes deploys, records history, and runs the
 * Workers Scripts upload. Mirrors RepoDO's shape (idFromName per repo).
 */
export class DeployDO {
  private state: DurableObjectState;
  private env: Env;
  private inFlight: Promise<unknown> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/deploy") {
      const body = (await request.json()) as DeployRequest;
      const prior = this.inFlight ?? Promise.resolve();
      const run = prior.then(() => this.runDeploy(body));
      this.inFlight = run.catch(() => undefined);
      try {
        return Response.json(await run);
      } catch (err) {
        return Response.json({ ok: false, error: (err as Error).message }, { status: 500 });
      }
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return Response.json({ deploys: await this.history() });
    }
    return new Response("not found", { status: 404 });
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

  private async runDeploy(req: DeployRequest): Promise<DeployRecord> {
    const id = await this.nextId();
    const rec: DeployRecord = {
      id,
      ref: req.ref,
      sha: req.sha,
      startedAt: Date.now(),
      status: "running",
      steps: [],
    };
    await this.record(rec);

    const finish = async (
      status: DeployRecord["status"],
      message?: string,
    ): Promise<DeployRecord> => {
      rec.status = status;
      rec.finishedAt = Date.now();
      if (message) rec.message = message;
      await this.record(rec);
      return rec;
    };

    const token = this.env.CF_DEPLOY_TOKEN;
    const accountId = this.env.ACCOUNT_ID;
    if (this.env.CD_ENABLED !== "1" || !token || !accountId) {
      return finish("skipped", "CD not enabled. Run `gitflare deploy enable`.");
    }

    let shallow;
    try {
      const handle = await this.env.ARTIFACTS.get(req.artifactsRepoName);
      shallow = await cloneRepoShallow(handle, req.remote);
    } catch (e) {
      return finish("failed", `clone failed: ${(e as Error).message}`);
    }

    const wfBlob = await readBlobAt(shallow, WORKFLOW_PATH).catch(() => null);
    if (!wfBlob || wfBlob.isBinary || !wfBlob.text) {
      return finish("skipped", `no ${WORKFLOW_PATH}`);
    }

    const parsed = parseDeployWorkflow(wfBlob.text);
    if (parsed.error || !parsed.workflow) {
      return finish("failed", `invalid ${WORKFLOW_PATH}: ${parsed.error}`);
    }
    if (!matchesPush(parsed.workflow, req.ref)) {
      return finish("skipped", `${req.ref} doesn't match workflow branches`);
    }

    let anyFailed = false;
    for (const step of parsed.workflow.steps) {
      const entryBlob = await readBlobAt(shallow, step.entry).catch(() => null);
      if (!entryBlob || entryBlob.isBinary || !entryBlob.text) {
        rec.steps.push({ project: step.project, kind: step.kind, ok: false, detail: `entry not found: ${step.entry}` });
        anyFailed = true;
        continue;
      }
      if (step.kind !== "worker") {
        rec.steps.push({ project: step.project, kind: step.kind, ok: false, detail: "only kind: worker in v0.2 MVP" });
        anyFailed = true;
        continue;
      }
      const result = await uploadWorkerScript({
        accountId,
        apiToken: token,
        upload: {
          scriptName: step.project,
          moduleFileName: "worker.js",
          code: entryBlob.text,
        },
      });
      rec.steps.push({
        project: step.project,
        kind: step.kind,
        ok: result.ok,
        ...(result.detail ? { detail: result.detail } : {}),
      });
      if (!result.ok) anyFailed = true;
      await this.record(rec); // checkpoint after each step
    }

    return finish(anyFailed ? "failed" : "success");
  }

  private async history(): Promise<DeployRecord[]> {
    const map = await this.state.storage.list<DeployRecord>({ prefix: "deploy:", reverse: true, limit: 50 });
    return [...map.values()];
  }
}

export function deployStubFor(env: Env, artifactsRepoName: string): DurableObjectStub {
  const id = env.DEPLOY.idFromName(artifactsRepoName);
  return env.DEPLOY.get(id);
}
