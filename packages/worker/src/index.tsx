import { Hono } from "hono";
import { verifyGithubSignature } from "./github/webhook";
import { lookupArtifactsRepoName, type Env } from "./env";
import { repoStubFor } from "./durable-objects/repo";
import { Home, type HomeRepo } from "./ui/home";

export { RepoDO } from "./durable-objects/repo";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  c.json({ ok: true, version: c.env.GITFLARE_VERSION ?? "0.0.0" }),
);

app.get("/favicon.svg", (c) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="6" fill="#f38020"/><circle cx="12" cy="12" r="3" fill="#fff"/><circle cx="22" cy="16" r="3" fill="#fff"/><circle cx="14" cy="22" r="3" fill="#fff"/><path d="M12 12L17 16L14 22M17 16L22 16" stroke="#fff" stroke-width="2" fill="none"/></svg>`;
  return c.body(svg, 200, { "Content-Type": "image/svg+xml; charset=utf-8" });
});

app.get("/", async (c) => {
  const repoMap = safeParseRepoMap(c.env.REPO_MAP);
  const repos: HomeRepo[] = [];
  for (const [github, artifactsName] of Object.entries(repoMap)) {
    const r: HomeRepo = {
      githubFullName: github,
      artifactsRepoName: artifactsName,
      artifactsRemote: "",
      refs: [],
    };
    try {
      const handle = await c.env.ARTIFACTS.get(artifactsName);
      r.artifactsRemote = handle.remote;
    } catch (err) {
      r.error = `Artifacts lookup failed: ${(err as Error).message}`;
    }
    try {
      const stub = repoStubFor(c.env, artifactsName);
      const resp = await stub.fetch("https://repo-do/state");
      if (resp.ok) {
        const j = (await resp.json()) as { refs: HomeRepo["refs"] };
        r.refs = j.refs;
      }
    } catch {
      // Soft fail — sync hasn't happened yet.
    }
    repos.push(r);
  }
  return c.html(<Home repos={repos} version={c.env.GITFLARE_VERSION ?? "0.0.0"} />);
});

app.get("/api/refs", async (c) => {
  const repoMap = safeParseRepoMap(c.env.REPO_MAP);
  const out: Record<string, unknown> = {};
  for (const [github, artifactsName] of Object.entries(repoMap)) {
    try {
      const stub = repoStubFor(c.env, artifactsName);
      const resp = await stub.fetch("https://repo-do/state");
      out[github] = resp.ok ? await resp.json() : { error: resp.status };
    } catch (err) {
      out[github] = { error: (err as Error).message };
    }
  }
  return c.json(out);
});

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

  return c.json({ accepted: true, skipped: event }, 202);
});

function safeParseRepoMap(s: string): Record<string, string> {
  try {
    return JSON.parse(s) as Record<string, string>;
  } catch {
    return {};
  }
}

export default app;
