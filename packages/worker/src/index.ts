import { Hono } from "hono";
import { verifyGithubSignature } from "./github/webhook";
import { lookupArtifactsRepoName, type Env } from "./env";
import { repoStubFor } from "./durable-objects/repo";

export { RepoDO } from "./durable-objects/repo";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  c.json({ ok: true, version: c.env.GITFLARE_VERSION ?? "0.0.0" }),
);

app.post("/webhooks/github", async (c) => {
  const signature = c.req.header("x-hub-signature-256");
  const event = c.req.header("x-github-event");
  const body = await c.req.text();

  if (!signature || !event) {
    return c.json({ error: "missing signature or event header" }, 400);
  }

  const ok = await verifyGithubSignature(
    body,
    signature,
    c.env.GITHUB_WEBHOOK_SECRET,
  );
  if (!ok) return c.json({ error: "invalid signature" }, 401);

  if (event === "ping") return c.json({ pong: true });

  if (event === "push") {
    const payload = JSON.parse(body) as {
      ref: string;
      before: string;
      after: string;
      repository: { full_name: string };
      deleted?: boolean;
    };

    if (payload.deleted) {
      // Branch deletion: handle in a later milestone (delete ref on Artifacts side).
      return c.json({ accepted: true, skipped: "branch-delete" }, 202);
    }

    const artifactsRepoName = lookupArtifactsRepoName(
      c.env,
      payload.repository.full_name,
    );
    if (!artifactsRepoName) {
      return c.json(
        { error: "unknown repo", github: payload.repository.full_name },
        404,
      );
    }

    const stub = repoStubFor(c.env, artifactsRepoName);
    const resp = await stub.fetch("https://repo-do/sync", {
      method: "POST",
      body: JSON.stringify({
        githubFullName: payload.repository.full_name,
        artifactsRepoName,
        ref: payload.ref,
        beforeSha: payload.before,
        afterSha: payload.after,
      }),
    });
    const json = await resp.json();
    return c.json({ accepted: true, result: json }, resp.ok ? 202 : 500);
  }

  // Other events (issues, pull_request, etc.) — handled in later milestones.
  return c.json({ accepted: true, skipped: event }, 202);
});

export default app;
