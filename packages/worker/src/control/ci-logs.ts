// GET /control/ci/logs?repo=<artifacts name>&run=<id|latest>&job=<name>&after=<seq>
// Backs `gitflare logs`. CONTROL_SECRET-gated like /control/ci/cancel; the
// stub lookup is injected so the route can be tested without a Durable Object.

import type { Context } from "hono";
import { lookupByArtifactsName, type Env } from "../env";
import { controlAuthorized } from "./auth";

export type CiStubLookup = (env: Env, artifactsRepoName: string) => { fetch: (url: string) => Promise<Response> };

export function ciLogsHandler(stubFor: CiStubLookup) {
  return async (c: Context<{ Bindings: Env }>): Promise<Response> => {
    if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
    const repo = c.req.query("repo");
    const entry = repo ? lookupByArtifactsName(c.env, repo) : undefined;
    if (!entry) return c.json({ error: "unknown repo" }, 404);

    const run = c.req.query("run") ?? "latest";
    if (run !== "latest" && !/^[1-9]\d{0,9}$/.test(run)) {
      return c.json({ error: "run must be a run id or \"latest\"" }, 400);
    }
    const after = c.req.query("after") ?? "0";
    if (!/^\d{1,12}$/.test(after)) return c.json({ error: "after must be a non-negative integer" }, 400);
    const job = c.req.query("job");

    const qs = new URLSearchParams({ run, after });
    if (job) qs.set("job", job);
    const resp = await stubFor(c.env, entry.name).fetch(`https://ci-do/logs?${qs}`);
    const body = (await resp.json().catch(() => ({ error: "bad response from CI" }))) as object;
    return c.json(body, resp.status === 404 ? 404 : resp.ok ? 200 : 502);
  };
}
