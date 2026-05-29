import { Hono } from "hono";
import { verifyGithubSignature } from "./github/webhook";
import { lookupArtifactsRepoEntry, parseRepoMap, type Env } from "./env";
import { repoStubFor } from "./durable-objects/repo";
import { listArtifactsRefs } from "./artifacts/refs";
import { cloneRepoShallow, getRepoContent, listTreeAt, readBlobAt } from "./artifacts/content";
import { Browse } from "./ui/browse";
import { Home, type HomeRepo } from "./ui/home";
import { Deployments } from "./ui/deployments";
import { NotFound, ErrorView } from "./ui/states";
import { accessGuard, type AccessVariables } from "./access/middleware";
import { deployStubFor, type DeployRecord } from "./durable-objects/deploy";

export { RepoDO } from "./durable-objects/repo";
export { DeployDO } from "./durable-objects/deploy";

const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();

// /health and /webhooks/github stay open (the latter is HMAC-gated). Everything
// human- or API-facing is gated behind Cloudflare Access when ACCESS_AUD is set.
app.use("/", accessGuard);
app.use("/r/*", accessGuard);
app.use("/api/*", accessGuard);

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

const CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  avif: "image/avif",
  pdf: "application/pdf",
};

function contentTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

app.get("/r/:name/tree/*", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo)
    return c.html(
      <NotFound title="Repo not found" detail={`No mirror named “${name}” is configured on this Worker.`} />,
      404,
    );

  const prefix = `/r/${name}/tree/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)).replace(/^\/+|\/+$/g, "");

  try {
    const handle = await c.env.ARTIFACTS.get(name);
    const shallow = await cloneRepoShallow(handle, repo.remote);
    const entries = await listTreeAt(shallow, path);
    if (!entries)
      return c.html(
        <NotFound
          title="Path not found"
          detail={`“${path}” doesn't exist on ${shallow.branchName}.`}
          backHref={`/r/${name}/tree/`}
          backLabel="← Repo root"
        />,
        404,
      );
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
    return c.html(<ErrorView detail={(err as Error).message} backHref={`/r/${name}/tree/`} />, 500);
  }
});

app.get("/r/:name/blob/*", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo)
    return c.html(
      <NotFound title="Repo not found" detail={`No mirror named “${name}” is configured on this Worker.`} />,
      404,
    );

  const prefix = `/r/${name}/blob/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)).replace(/^\/+|\/+$/g, "");

  try {
    const handle = await c.env.ARTIFACTS.get(name);
    const shallow = await cloneRepoShallow(handle, repo.remote);
    const blob = await readBlobAt(shallow, path);
    if (!blob)
      return c.html(
        <NotFound
          title="File not found"
          detail={`“${path}” doesn't exist on ${shallow.branchName}.`}
          backHref={`/r/${name}/tree/`}
          backLabel="← Repo root"
        />,
        404,
      );
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
    return c.html(<ErrorView detail={(err as Error).message} backHref={`/r/${name}/tree/`} />, 500);
  }
});

// Raw blob proxy — serves file bytes straight from the Artifacts mirror. Used
// for README images so they render for private repos and survive GitHub
// outages. Under /r/* so the Access guard already covers it.
app.get("/r/:name/raw/*", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.text(`Unknown repo: ${name}`, 404);

  const prefix = `/r/${name}/raw/`;
  const path = decodeURIComponent(c.req.path.slice(prefix.length)).replace(/^\/+|\/+$/g, "");

  try {
    const handle = await c.env.ARTIFACTS.get(name);
    const shallow = await cloneRepoShallow(handle, repo.remote);
    const blob = await readBlobAt(shallow, path);
    if (!blob) return c.text(`File not found: ${path}`, 404);
    // bytes is a plain Uint8Array; the cast sidesteps the ArrayBufferLike vs
    // ArrayBuffer generic mismatch in the typed-array lib types.
    return new Response(blob.bytes as unknown as BodyInit, {
      headers: {
        "Content-Type": contentTypeFor(path),
        "Cache-Control": "public, max-age=300",
      },
    });
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

app.get("/r/:name/deployments", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo)
    return c.html(
      <NotFound title="Repo not found" detail={`No mirror named “${name}” is configured on this Worker.`} />,
      404,
    );
  let deploys: DeployRecord[] = [];
  try {
    const stub = deployStubFor(c.env, name);
    const resp = await stub.fetch("https://deploy-do/state");
    if (resp.ok) ({ deploys } = (await resp.json()) as { deploys: DeployRecord[] });
  } catch {
    // Soft fail — show an empty list.
  }
  return c.html(
    <Deployments
      githubFullName={repo.githubFullName}
      artifactsRepoName={name}
      deploys={deploys}
      cdEnabled={c.env.CD_ENABLED === "1"}
      version={c.env.GITFLARE_VERSION ?? "0.0.0"}
    />,
  );
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

    // CD (v0.2): once the sync landed, kick off a deploy. DeployDO no-ops if
    // there's no .gitflare/deploy.yml or CD isn't enabled. Runs after the
    // response so the webhook returns fast.
    if (resp.ok) {
      const deploy = deployStubFor(c.env, entry.name);
      c.executionCtx.waitUntil(
        deploy.fetch("https://deploy-do/deploy", {
          method: "POST",
          body: JSON.stringify({
            artifactsRepoName: entry.name,
            remote: entry.remote,
            ref: payload.ref,
            sha: payload.after,
          }),
        }),
      );
    }
    return c.json({ accepted: true, result: json }, resp.ok ? 202 : 500);
  }

  return c.json({ accepted: true, skipped: event }, 202);
});

export default app;
