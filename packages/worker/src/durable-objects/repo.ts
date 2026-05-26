import type { Env } from "../env";
import { syncGithubToArtifacts } from "../sync/git-sync";

interface RefState {
  ref: string;
  sha: string;
  syncedAt: number;
}

interface SyncRequest {
  githubFullName: string;
  artifactsRepoName: string;
  ref: string;
  beforeSha: string;
  afterSha: string;
}

/**
 * Per-repo Durable Object. Holds the last-synced SHA per ref and serializes
 * sync operations so concurrent webhooks for the same repo don't race.
 */
export class RepoDO {
  private state: DurableObjectState;
  private env: Env;
  private inFlight: Promise<unknown> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      const body = (await request.json()) as SyncRequest;
      return this.handleSync(body);
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const refs = await this.allRefs();
      return Response.json({ refs });
    }
    return new Response("not found", { status: 404 });
  }

  private async handleSync(req: SyncRequest): Promise<Response> {
    // Serialize: if a sync is in flight, queue behind it.
    const prior = this.inFlight ?? Promise.resolve();
    const run = prior.then(() => this.runSync(req));
    this.inFlight = run.catch(() => undefined);
    try {
      const result = await run;
      return Response.json(result);
    } catch (err) {
      return Response.json(
        { ok: false, error: (err as Error).message },
        { status: 500 },
      );
    }
  }

  private async runSync(req: SyncRequest): Promise<unknown> {
    const artifactsRepo = await this.env.ARTIFACTS.get(req.artifactsRepoName);
    const result = await syncGithubToArtifacts({
      githubFullName: req.githubFullName,
      githubToken: this.env.GITHUB_TOKEN,
      ref: req.ref,
      artifactsRepo,
      beforeSha: req.beforeSha,
      afterSha: req.afterSha,
    });
    await this.state.storage.put<RefState>(`ref:${req.ref}`, {
      ref: req.ref,
      sha: req.afterSha,
      syncedAt: Date.now(),
    });
    return result;
  }

  private async allRefs(): Promise<RefState[]> {
    const map = await this.state.storage.list<RefState>({ prefix: "ref:" });
    return [...map.values()];
  }
}

export function repoStubFor(env: Env, artifactsRepoName: string): DurableObjectStub {
  const id = env.REPO.idFromName(artifactsRepoName);
  return env.REPO.get(id);
}
