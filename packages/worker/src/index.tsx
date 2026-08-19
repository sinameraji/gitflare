import { Hono } from "hono";
import { verifyGithubSignature } from "./github/webhook";
import { lookupArtifactsRepoEntry, lookupByArtifactsName, parseRepoMap, type Env } from "./env";
import { dispatchPush } from "./pipeline/dispatch";
import { handleQueue } from "./events/consumer";
import { repoStubFor } from "./durable-objects/repo";
import { listArtifactsRefs } from "./artifacts/refs";
import { cloneRepoShallow, getRepoContent, listTreeAt, readBlobAt, listCommits } from "./artifacts/content";
import { Commits } from "./ui/commits";
import { probeGithub } from "./github/health";
import { Browse } from "./ui/browse";
import { Home, type HomeRepo } from "./ui/home";
import { Deployments } from "./ui/deployments";
import { Runs } from "./ui/runs";
import { NotFound, ErrorView } from "./ui/states";
import { accessGuard, type AccessVariables } from "./access/middleware";
import { deployStubFor, type DeployRecord } from "./durable-objects/deploy";
import { ciStubFor, type CiRunRecord } from "./durable-objects/ci";

export { RepoDO } from "./durable-objects/repo";
export { DeployDO } from "./durable-objects/deploy";
export { CiDO } from "./durable-objects/ci";
// The Sandbox container class must be exported for the (optional) SANDBOX
// binding + [[containers]] block that `gitflare ci enable` adds; inert unless
// the deployed config binds it.
export { Sandbox } from "@cloudflare/sandbox";

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
  const github = await probeGithub();
  for (const [github, entry] of Object.entries(repoMap)) {
    const r: HomeRepo = {
      githubFullName: github,
      artifactsRepoName: entry.name,
      artifactsRemote: entry.remote,
      branches: [],
      syncedRefs: [],
      reverseRefs: [],
      syncEnabled: c.env.SYNC_ENABLED === "1",
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
        const j = (await resp.json()) as {
          refs: HomeRepo["syncedRefs"];
          reverse?: HomeRepo["reverseRefs"];
          tagBackfill?: HomeRepo["tagBackfill"];
        };
        r.syncedRefs = j.refs;
        r.reverseRefs = j.reverse ?? [];
        r.tagBackfill = j.tagBackfill ?? null;
      }
    } catch {
      // Soft fail.
    }
    repos.push(r);
  }
  return c.html(<Home repos={repos} version={c.env.GITFLARE_VERSION ?? "0.0.0"} github={github} />);
});

// Look up an artifacts repo name → its REPO_MAP entry + github full_name.
const findRepoByArtifactsName = lookupByArtifactsName;

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
app.get("/r/:name/commits", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.html(<NotFound title="Unknown repo" detail={`No mirror named ${name}.`} />, 404);
  try {
    const handle = await c.env.ARTIFACTS.get(repo.name);
    const refs = await listArtifactsRefs(handle, repo.remote);
    const branches = refs.filter((r) => r.ref.startsWith("refs/heads/")).map((r) => r.ref.slice("refs/heads/".length));
    const defaultBranch = refs.find((r) => r.isDefault && r.ref.startsWith("refs/heads/"))?.ref.slice("refs/heads/".length) ?? branches[0] ?? "main";
    const wanted = c.req.query("ref");
    const branch = wanted && branches.includes(wanted) ? wanted : defaultBranch;
    const limit = 100;
    const { commits, headSha } = await listCommits(handle, repo.remote, branch, limit);
    return c.html(
      <Commits
        githubFullName={repo.githubFullName}
        artifactsRepoName={repo.name}
        branch={branch}
        branches={[defaultBranch, ...branches.filter((b) => b !== defaultBranch)]}
        headSha={headSha}
        commits={commits}
        limit={limit}
      />,
    );
  } catch (err) {
    return c.html(<ErrorView detail={(err as Error).message} backHref={`/r/${name}/tree/`} />, 500);
  }
});

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

// Live deploy-log WebSocket — the Deployments page connects here. Under /r/* so
// the Access guard covers it; the upgrade is forwarded to the DeployDO.
app.get("/r/:name/deployments/stream", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.text("unknown repo", 404);
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  const stub = deployStubFor(c.env, name);
  return stub.fetch(new Request("https://deploy-do/stream", c.req.raw));
});

// ---- CI runs (v0.3) --------------------------------------------------------

app.get("/r/:name/ci", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo)
    return c.html(
      <NotFound title="Repo not found" detail={`No mirror named “${name}” is configured on this Worker.`} />,
      404,
    );
  let runs: CiRunRecord[] = [];
  try {
    const stub = ciStubFor(c.env, name);
    const resp = await stub.fetch("https://ci-do/state");
    if (resp.ok) ({ runs } = (await resp.json()) as { runs: CiRunRecord[] });
  } catch {
    // Soft fail — show an empty list.
  }
  return c.html(
    <Runs
      githubFullName={repo.githubFullName}
      artifactsRepoName={name}
      runs={runs}
      ciEnabled={c.env.CI_ENABLED === "1"}
      canCancel={!!c.env.ACCESS_AUD}
      version={c.env.GITFLARE_VERSION ?? "0.0.0"}
    />,
  );
});

// Live CI-log WebSocket — forwarded to the CiDO, Access-guarded via /r/*.
app.get("/r/:name/ci/stream", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.text("unknown repo", 404);
  if (c.req.header("Upgrade") !== "websocket") return c.text("expected websocket", 426);
  const stub = ciStubFor(c.env, name);
  return stub.fetch(new Request("https://ci-do/stream", c.req.raw));
});

// Cancel button on the runs page. This is a state-changing action, so it must
// only be reachable by an authenticated principal. The Access guard on /r/*
// authenticates the human ONLY when Access is enabled; on a public mirror it
// no-ops, which would let anyone kill in-flight runs. So we refuse the
// page-initiated cancel when Access is off and point users at the
// CONTROL_SECRET-gated CLI (`gitflare ci cancel`) instead.
app.post("/r/:name/ci/cancel", async (c) => {
  const name = c.req.param("name");
  const repo = findRepoByArtifactsName(c.env, name);
  if (!repo) return c.json({ error: "unknown repo" }, 404);
  if (!c.env.ACCESS_AUD) {
    return c.json(
      { error: "cancel from the dashboard requires Cloudflare Access; use `gitflare ci cancel`" },
      403,
    );
  }
  const stub = ciStubFor(c.env, name);
  const resp = await stub.fetch("https://ci-do/cancel", { method: "POST" });
  return c.json((await resp.json()) as object, resp.status === 202 ? 202 : 200);
});

// ---- Control plane (CLI → Worker), authed by CONTROL_SECRET, not Access ----
// Mirrors how /webhooks/github sits outside Access with its own auth.

function controlAuthorized(c: { req: { header: (n: string) => string | undefined }; env: Env }): boolean {
  const secret = c.env.CONTROL_SECRET;
  if (!secret) return false;
  const auth = c.req.header("Authorization") ?? "";
  const provided = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (provided.length !== secret.length) return false;
  let diff = 0;
  for (let i = 0; i < secret.length; i++) diff |= provided.charCodeAt(i) ^ secret.charCodeAt(i);
  return diff === 0;
}

app.post("/control/deploy/run", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { repo } = (await c.req.json().catch(() => ({}))) as { repo?: string };
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = deployStubFor(c.env, entry.name);
  c.executionCtx.waitUntil(
    stub.fetch("https://deploy-do/deploy", {
      method: "POST",
      body: JSON.stringify({ artifactsRepoName: entry.name, remote: entry.remote, ref: "", sha: "", mode: "manual" }),
    }),
  );
  return c.json({ accepted: true }, 202);
});

app.post("/control/deploy/rollback", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { repo, toDeployId } = (await c.req.json().catch(() => ({}))) as {
    repo?: string;
    toDeployId?: number;
  };
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = deployStubFor(c.env, entry.name);
  c.executionCtx.waitUntil(
    stub.fetch("https://deploy-do/rollback", {
      method: "POST",
      body: JSON.stringify({
        artifactsRepoName: entry.name,
        remote: entry.remote,
        ...(toDeployId ? { toDeployId } : {}),
      }),
    }),
  );
  return c.json({ accepted: true }, 202);
});

app.get("/control/deployments", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const repo = c.req.query("repo");
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = deployStubFor(c.env, entry.name);
  const resp = await stub.fetch("https://deploy-do/state");
  return c.json(resp.ok ? ((await resp.json()) as object) : { deploys: [] });
});

// ---- CI control plane (v0.3) — same CONTROL_SECRET bearer as deploys ------

app.post("/control/ci/run", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { repo } = (await c.req.json().catch(() => ({}))) as { repo?: string };
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = ciStubFor(c.env, entry.name);
  // CiDO answers 202 immediately and runs the pipeline detached.
  c.executionCtx.waitUntil(
    stub.fetch("https://ci-do/run", {
      method: "POST",
      body: JSON.stringify({
        artifactsRepoName: entry.name,
        remote: entry.remote,
        githubFullName: entry.githubFullName,
        ref: "",
        sha: "",
        mode: "manual",
        statusTargetUrl: `${new URL(c.req.url).origin}/r/${entry.name}/ci`,
      }),
    }),
  );
  return c.json({ accepted: true }, 202);
});

app.get("/control/ci/runs", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const repo = c.req.query("repo");
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = ciStubFor(c.env, entry.name);
  const resp = await stub.fetch("https://ci-do/state");
  return c.json(resp.ok ? ((await resp.json()) as object) : { runs: [] });
});

app.post("/control/ci/cancel", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { repo } = (await c.req.json().catch(() => ({}))) as { repo?: string };
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = ciStubFor(c.env, entry.name);
  const resp = await stub.fetch("https://ci-do/cancel", { method: "POST" });
  return c.json((await resp.json()) as object, resp.status === 202 ? 202 : 200);
});

// ---- Sync control plane (M9) — same CONTROL_SECRET bearer -----------------

app.post("/control/sync/reverse", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { repo, ref, reconcile } = (await c.req.json().catch(() => ({}))) as {
    repo?: string;
    ref?: string;
    reconcile?: boolean;
  };
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = repoStubFor(c.env, entry.name);
  const resp = await stub.fetch("https://repo-do/reverse/now", {
    method: "POST",
    body: JSON.stringify({
      githubFullName: entry.githubFullName,
      artifactsRepoName: entry.name,
      remote: entry.remote,
      ...(ref ? { ref } : {}),
      reconcile: reconcile !== false,
    }),
  });
  return c.json((await resp.json()) as object, resp.ok ? 202 : 500);
});

app.post("/control/sync/tags", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const { repo } = (await c.req.json().catch(() => ({}))) as { repo?: string };
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = repoStubFor(c.env, entry.name);
  const resp = await stub.fetch("https://repo-do/sync-tags", {
    method: "POST",
    body: JSON.stringify({ githubFullName: entry.githubFullName, artifactsRepoName: entry.name, remote: entry.remote }),
  });
  return c.json((await resp.json()) as object, resp.status === 202 ? 202 : 500);
});

app.get("/control/sync/state", async (c) => {
  if (!controlAuthorized(c)) return c.json({ error: "unauthorized" }, 401);
  const repo = c.req.query("repo");
  const entry = repo ? findRepoByArtifactsName(c.env, repo) : undefined;
  if (!entry) return c.json({ error: "unknown repo" }, 404);
  const stub = repoStubFor(c.env, entry.name);
  const resp = await stub.fetch("https://repo-do/state");
  return c.json(resp.ok ? ((await resp.json()) as object) : { refs: [], reverse: [] });
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

    // Tag pushes are mirrored (tag only — no CI/CD dispatch: branchOf() would
    // leave them unmatched by any workflow and mint red statuses). Deletes were
    // handled above (never propagated).
    if (payload.ref.startsWith("refs/tags/")) {
      const tag = payload.ref.slice("refs/tags/".length);
      c.executionCtx.waitUntil(
        repoStubFor(c.env, entry.name).fetch("https://repo-do/sync-tag", {
          method: "POST",
          body: JSON.stringify({
            githubFullName: payload.repository.full_name,
            artifactsRepoName: entry.name,
            remote: entry.remote,
            tag,
            sha: payload.after,
          }),
        }),
      );
      return c.json({ accepted: true, tag }, 202);
    }
    // Only branch pushes drive sync + CD/CI.
    if (!payload.ref.startsWith("refs/heads/")) {
      return c.json({ accepted: true, skipped: "non-branch-ref" }, 202);
    }

    // Respond to GitHub immediately and do the (potentially multi-second) sync
    // + dispatch in the background. GitHub times out webhook deliveries at 10s;
    // an in-worker isomorphic-git sync of a real repo can exceed that, so
    // awaiting it inline makes every push show as a failed delivery (and
    // triggers redeliveries). Fire-and-forget instead — sync errors surface in
    // the RepoDO/dashboard, not GitHub's delivery UI.
    const origin = new URL(c.req.url).origin;
    c.executionCtx.waitUntil(
      (async () => {
        const stub = repoStubFor(c.env, entry.name);
        const resp = await stub.fetch("https://repo-do/sync", {
          method: "POST",
          body: JSON.stringify({
            githubFullName: payload.repository.full_name,
            artifactsRepoName: entry.name,
            remote: entry.remote,
            ref: payload.ref,
            beforeSha: payload.before,
            afterSha: payload.after,
          }),
        });
        if (!resp.ok) return;
        // The RepoDO says whether this push is NEW to the mirror. When the
        // mirror already had the sha (the webhook echo of our own reverse
        // push, or a fan-out push that reached the mirror first), the
        // pipeline already ran — don't run it twice.
        const sync = (await resp.json().catch(() => ({}))) as { dispatch?: boolean };
        if (sync.dispatch === false) return;

        // Once the sync landed, exactly ONE pipeline owns the push.
        await dispatchPush(c.env, {
          githubFullName: payload.repository.full_name,
          artifactsRepoName: entry.name,
          remote: entry.remote,
          ref: payload.ref,
          sha: payload.after,
          mode: "push",
          origin,
        });
      })(),
    );
    return c.json({ accepted: true }, 202);
  }

  return c.json({ accepted: true, skipped: event }, 202);
});

// The Worker is both an HTTP app and (once `gitflare sync enable` binds a
// queue consumer) a consumer of Artifacts `pushed` events.
export default {
  fetch: app.fetch,
  queue: handleQueue,
};
