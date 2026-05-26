import { Hono } from "hono";
import { verifyGithubSignature } from "./github/webhook";

export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;
  ARTIFACTS_TOKEN: string;
  GITFLARE_VERSION: string;
}

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

  // M1: dispatch to handler. For now, just acknowledge.
  // Real implementation: parse event, enqueue a sync job, return 202.
  return c.json({ accepted: true, event });
});

export default app;
