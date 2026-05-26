import { Hono } from "hono";
import { verifyGithubSignature } from "./github/webhook";
import { lookupArtifactsRepoEntry, parseRepoMap, type Env } from "./env";
import { repoStubFor } from "./durable-objects/repo";
import { listArtifactsRefs } from "./artifacts/refs";
import { cloneRepoShallow, getRepoContent, listTreeAt, readBlobAt } from "./artifacts/content";
import { Browse } from "./ui/browse";
import { Home, type HomeRepo } from "./ui/home";

export { RepoDO } from "./durable-objects/repo";

const app = new Hono<{ Bindings: Env }>();

app.get("/health", (c) =>
  c.json({ ok: true, version: c.env.GITFLARE_VERSION ?? "0.0.0" }),
);

app.get("/", async (c) => {
  const repoMap = parseRepoMap(c.env);
  const repos: HomeRepo[] = [];
  for (const [github, entry] of Object.entries(repoMap)) {
    const r: HomeRepo = {
      githubFullName: github,
      artifactsRepoName: entry.name,
      artifactsRemote: entry.remote,
      branches: [],
      syncedRefs: [],
    };
    // Live state from Artifacts: refs + content (README + top-level tree).
    try {
      const repoHandle = await c.env.ARTIFACTS.get(entry.name);
      r.branches = await listArtifactsRefs(repoHandle, entry.remote);
      try {
        r.content = await getRepoContent(repoHandle, entry.remote);
      } catch (err) {
        // Soft fail on content — refs still show.
        r.error = `Content fetch failed: ${(err as Error).message}`;
      }
    } catch (err) {
      r.error = `Artifacts ref list failed: ${(err as Error).message}`;
    }
    // Per-webhook sync state from the DO.
    try {
      const stub = repoStubFor(c.env, entry.name);
      const resp = await stub.fetch("https://repo-do/state");
      if (resp.ok) {
        const j = (await resp.json()) as { refs: HomeRepo["syncedRefs"] };
        r.syncedRefs = j.refs;
      }
    } catch {
      // Soft fail.
    }
    repos.push(r);
  }
  return c.html(<Home repos={repos} version={c.env.GITFLARE_VERSION ?? "0.0.0"} />);
});

// Look up an artifacts repo name → its REPO_MAP entry + github full_name.
function findRepoByArtifactsName(env: Env, artifactsName: string):
  | { githubFullName: string; name: string; remote: string }
  | undefined {
  const map = parseRepoMap(env);
  for (const [github, entry] of Object.entries(map)) {
    if (entry.name === artifactsName) return { githubFullName: github, ...entry };
  }
  return undefined;
}

app.get("/r/:name/tree/*", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.text(`Unknown repo: ${name}`, 404);

  const prefix = `/r/${name}/tree/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)).replace(/^\/+|\/+$/g, "");

  try {
    const handle = await c.env.ARTIFACTS.get(name);
    const shallow = await cloneRepoShallow(handle, repo.remote);
    const entries = await listTreeAt(shallow, path);
    if (!entries) return c.text(`Path not found: ${path}`, 404);
    return c.html(
      <Browse
        githubFullName={repo.githubFullName}
        artifactsRepoName={name}
        branchName={shallow.branchName}
        headSha={shallow.headSha}
        path={path}
        entries={entries}
        version={c.env.GITFLARE_VERSION ?? "0.0.0"}
      />,
    );
  } catch (err) {
    return c.text(`Error: ${(err as Error).message}`, 500);
  }
});

app.get("/r/:name/blob/*", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.text(`Unknown repo: ${name}`, 404);

  const prefix = `/r/${name}/blob/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)).replace(/^\/+|\/+$/g, "");

  try {
    const handle = await c.env.ARTIFACTS.get(name);
    const shallow = await cloneRepoShallow(handle, repo.remote);
    const blob = await readBlobAt(shallow, path);
    if (!blob) return c.text(`File not found: ${path}`, 404);
    return c.html(
      <Browse
        githubFullName={repo.githubFullName}
        artifactsRepoName={name}
        branchName={shallow.branchName}
        headSha={shallow.headSha}
        path={path}
        blob={blob}
        version={c.env.GITFLARE_VERSION ?? "0.0.0"}
      />,
    );
  } catch (err) {
    return c.text(`Error: ${(err as Error).message}`, 500);
  }
});

app.get("/api/refs", async (c) => {
  const repoMap = parseRepoMap(c.env);
  const out: Record<string, unknown> = {};
  for (const [github, entry] of Object.entries(repoMap)) {
    try {
      const stub = repoStubFor(c.env, entry.name);
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

    const entry = lookupArtifactsRepoEntry(
      c.env,
      payload.repository.full_name,
    );
    if (!entry) {
      return c.json(
        { error: "unknown repo", github: payload.repository.full_name },
        404,
      );
    }

    const stub = repoStubFor(c.env, entry.name);
    const resp = await stub.fetch("https://repo-do/sync", {
      method: "POST",
      body: JSON.stringify({
        githubFullName: payload.repository.full_name,
        artifactsRepoName: entry.name,
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

export default app;
