import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { tokenSecret, type ArtifactsRepo } from "../types";

// Cloudflare Workers don't have a real fs. isomorphic-git accepts any
// LightningFS-compatible fs; we use a minimal in-memory implementation that
// supports the operations isomorphic-git calls during fetch + push.
import { MemFs } from "./memfs";
import { deepenUntilReachable } from "../artifacts/content";

export interface SyncParams {
  githubFullName: string;          // "owner/repo"
  githubToken: string;             // for private repos + rate limit
  ref: string;                     // "refs/heads/main"
  artifactsRepo: ArtifactsRepo;    // the destination handle (for createToken)
  remote: string;                  // the Artifacts clone URL, from REPO_MAP
  beforeSha: string;               // SHA before the push (00...0 if new branch)
  afterSha: string;                // SHA after the push
}

export interface SyncResult {
  ok: boolean;
  pushedRef: string;
  pushedSha: string;
  durationMs: number;
  bytesTransferred?: number;
}

/**
 * Incrementally mirror new commits from GitHub into an Artifacts repo.
 *
 * Strategy:
 * 1. Initialize an empty in-memory repo.
 * 2. Add GitHub as a remote with token auth.
 * 3. Shallow-fetch just the new ref (depth chosen to cover beforeSha → afterSha;
 *    for new branches, full history of the ref).
 * 4. Add the Artifacts remote.
 * 5. Mint a write-scoped token and push the ref.
 *
 * This runs per-webhook, on a small delta. CPU stays well under Worker limits
 * for typical pushes (a few commits at a time).
 */
export async function syncGithubToArtifacts(
  params: SyncParams,
): Promise<SyncResult> {
  const start = Date.now();
  const fs = new MemFs();
  const dir = "/repo";

  const githubUrl = `https://github.com/${params.githubFullName}.git`;
  const isNewBranch = /^0+$/.test(params.beforeSha);
  const branchName = params.ref.replace(/^refs\/heads\//, "");

  // Shallow clone of just this branch from GitHub. clone() configures the
  // remote + refspec internally so we don't hit the "no fetch refspec"
  // error that bare init+fetch produces. depth covers the delta with
  // headroom; for new branches we go deeper.
  const githubAuth = (): { username: string; password: string } => ({
    username: "x-access-token",
    password: params.githubToken,
  });
  await git.clone({
    fs,
    http,
    dir,
    url: githubUrl,
    ref: branchName,
    singleBranch: true,
    depth: isNewBranch ? 200 : 50,
    noCheckout: true,
    noTags: false,
    onAuth: githubAuth,
  });
  // isomorphic-git judges fast-forward-ness from LOCAL history: the mirror's
  // current tip must be inside our shallow window or the push is misreported
  // as not-fast-forward. That tip is NOT necessarily the webhook's `before` —
  // once a sync has failed, the mirror lags GitHub by many pushes (seen live
  // on kimiflare: main stuck at the import sha for months while every push
  // "failed" the fast-forward check). So anchor on what the mirror actually
  // has, falling back to `before` if the mirror can't be asked. Not reachable
  // at any depth = a genuine divergence (e.g. a force push on GitHub) and the
  // push below fails honestly with force:false.
  const mirrorTip = await currentMirrorTip(params).catch(() => null);
  const anchors = mirrorTip ? [mirrorTip] : isNewBranch ? [] : [params.beforeSha];
  if (anchors.length > 0) {
    await deepenUntilReachable({
      fs,
      dir,
      url: githubUrl,
      ref: branchName,
      anchors,
      onAuth: githubAuth,
    });
  }

  const tokenResult = (await params.artifactsRepo.createToken("write", 600)) as {
    plaintext?: string;
    token?: string;
  };
  const rawToken = tokenResult.plaintext ?? tokenResult.token;
  if (!rawToken) {
    throw new Error(
      `createToken (write) returned unexpected shape: ${JSON.stringify(tokenResult)}`,
    );
  }
  await git.push({
    fs,
    http,
    dir,
    // Use the REPO_MAP remote string, NOT artifactsRepo.remote: on the live
    // Artifacts beta, property access on the binding returns a lazy RPC proxy
    // (JsRpcProperty) that stringifies to "[object JsRpcProperty]" — only RPC
    // *methods* like createToken() resolve. The REPO_MAP string is what every
    // browse path already uses successfully.
    url: params.remote,
    ref: params.ref,
    remoteRef: params.ref,
    force: false,
    onAuth: () => ({
      username: "x",
      password: tokenSecret(rawToken),
    }),
  });

  return {
    ok: true,
    pushedRef: params.ref,
    pushedSha: params.afterSha,
    durationMs: Date.now() - start,
  };
}

/** The mirror's tip for `params.ref`, or null if the ref doesn't exist there yet. */
async function currentMirrorTip(params: SyncParams): Promise<string | null> {
  const tokenResult = (await params.artifactsRepo.createToken("read", 120)) as {
    plaintext?: string;
    token?: string;
  };
  const rawToken = tokenResult.plaintext ?? tokenResult.token;
  if (!rawToken) return null;
  const password = tokenSecret(rawToken);
  const refs = await git.listServerRefs({
    http,
    url: params.remote,
    prefix: params.ref,
    onAuth: () => ({ username: "x", password }),
  });
  return refs.find((r) => r.ref === params.ref)?.oid ?? null;
}

// ---- tags (forward: GitHub → Artifacts) ------------------------------------
//
// Why the local store is cloned from the MIRROR first: isomorphic-git's push
// only omits objects it can prove the remote has — everything reachable from
// `refs/remotes/origin/HEAD` in the local store (thin pack). With the mirror as
// origin (depth-1 clone of its default branch), a tag push carries just the tag
// commit plus the blobs that differ from the mirror's tip — instead of a full
// snapshot per tag, which is what a GitHub-cloned store produced (~35 s/tag
// live). Tag objects themselves come from GitHub into the same store.

export interface TagSyncParams {
  githubFullName: string;
  githubToken: string;
  artifactsRepo: ArtifactsRepo;
  remote: string;
}

async function openTagWorkspace(params: TagSyncParams): Promise<{
  fs: MemFs;
  dir: string;
  githubUrl: string;
  githubAuth: () => { username: string; password: string };
  mirrorTags: Map<string, string>;
}> {
  const fs = new MemFs();
  const dir = "/repo";
  const githubUrl = `https://github.com/${params.githubFullName}.git`;
  const githubAuth = (): { username: string; password: string } => ({
    username: "x-access-token",
    password: params.githubToken,
  });
  const readPassword = await mintPassword(params.artifactsRepo, "read", 300);
  const mirrorAuth = (): { username: string; password: string } => ({ username: "x", password: readPassword });
  const refs = await git.listServerRefs({ http, url: params.remote, prefix: "refs/tags/", onAuth: mirrorAuth });
  const mirrorTags = new Map(refs.filter((r) => !r.ref.endsWith("^{}")).map((r) => [r.ref, r.oid]));
  // origin = the mirror. noTags: its tags come back on the listing above; we
  // don't need their objects.
  await git.clone({ fs, http, dir, url: params.remote, singleBranch: true, depth: 1, noCheckout: true, noTags: true, onAuth: mirrorAuth });
  // A second remote for GitHub so fetch() has a refspec to work with; tag
  // objects land in the same object store as the mirror's.
  await git.addRemote({ fs, dir, remote: "github", url: githubUrl, force: true });
  return { fs, dir, githubUrl, githubAuth, mirrorTags };
}

async function pushTag(
  ws: { fs: MemFs; dir: string },
  remote: string,
  writePassword: string,
  fullRef: string,
): Promise<void> {
  await git.push({
    fs: ws.fs,
    http,
    dir: ws.dir,
    url: remote,
    remote: "origin",
    ref: fullRef,
    remoteRef: fullRef,
    force: false,
    onAuth: () => ({ username: "x", password: writePassword }),
  });
}

/**
 * Mirror ONE tag from GitHub into the Artifacts repo (webhook path). Tags are
 * immutable: an identical tag on the mirror is a no-op; a different sha for
 * the same name is left alone (never force).
 */
export async function syncTagGithubToArtifacts(
  params: TagSyncParams & { tag: string },
): Promise<{ ok: boolean; sha?: string | undefined; skipped?: string | undefined; durationMs: number }> {
  const start = Date.now();
  const fullRef = `refs/tags/${params.tag}`;
  const ws = await openTagWorkspace(params);
  const existing = ws.mirrorTags.get(fullRef);
  const fetched = await git.fetch({
    fs: ws.fs,
    http,
    dir: ws.dir,
    url: ws.githubUrl,
    remote: "github",
    ref: fullRef,
    singleBranch: true,
    depth: 1,
    tags: false,
    onAuth: ws.githubAuth,
  });
  const sha = fetched.fetchHead ?? undefined;
  if (!sha) return { ok: false, skipped: "tag not found on GitHub", durationMs: Date.now() - start };
  if (existing === sha) return { ok: true, sha, skipped: "already on mirror", durationMs: Date.now() - start };
  if (existing && existing !== sha) {
    return { ok: false, sha, skipped: `mirror has ${existing.slice(0, 8)} for this tag; not overwriting`, durationMs: Date.now() - start };
  }
  await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: fullRef, value: sha, force: true });
  const writePassword = await mintPassword(params.artifactsRepo, "write", 600);
  await pushTag(ws, params.remote, writePassword, fullRef);
  return { ok: true, sha, durationMs: Date.now() - start };
}

/**
 * Backfill: mirror every GitHub tag the Artifacts repo doesn't have yet.
 * One bulk shallow fetch of all tags from GitHub (`tags: true` needs
 * `singleBranch: false` to actually bring the objects — verified), then one
 * thin-pack push per missing tag. Per-tag failures are recorded, not fatal.
 */
export async function syncAllTagsGithubToArtifacts(
  params: TagSyncParams & { limit?: number | undefined },
): Promise<{
  pushed: Array<{ ref: string; oid: string }>;
  alreadyPresent: number;
  conflicts: string[];
  failed: Array<{ ref: string; error: string }>;
  durationMs: number;
}> {
  const start = Date.now();
  const ws = await openTagWorkspace(params);
  const githubRefs = await git.listServerRefs({ http, url: ws.githubUrl, prefix: "refs/tags/", onAuth: ws.githubAuth });
  const wanted: Array<{ ref: string; oid: string }> = [];
  const conflicts: string[] = [];
  let alreadyPresent = 0;
  for (const r of githubRefs) {
    if (r.ref.endsWith("^{}")) continue; // peeled entries
    const have = ws.mirrorTags.get(r.ref);
    if (have === r.oid) alreadyPresent++;
    else if (have) conflicts.push(r.ref);
    else wanted.push({ ref: r.ref, oid: r.oid });
  }
  const todo = params.limit ? wanted.slice(0, params.limit) : wanted;
  if (todo.length === 0) return { pushed: [], alreadyPresent, conflicts, failed: [], durationMs: Date.now() - start };

  await git.fetch({
    fs: ws.fs,
    http,
    dir: ws.dir,
    url: ws.githubUrl,
    remote: "github",
    depth: 1,
    tags: true,
    singleBranch: false,
    onAuth: ws.githubAuth,
  });

  const writePassword = await mintPassword(params.artifactsRepo, "write", 1800);
  const pushed: Array<{ ref: string; oid: string }> = [];
  const failed: Array<{ ref: string; error: string }> = [];
  for (const t of todo) {
    try {
      const local = await git.resolveRef({ fs: ws.fs, dir: ws.dir, ref: t.ref }).catch(() => null);
      if (!local) await git.writeRef({ fs: ws.fs, dir: ws.dir, ref: t.ref, value: t.oid, force: true });
      await pushTag(ws, params.remote, writePassword, t.ref);
      pushed.push({ ref: t.ref, oid: local ?? t.oid });
    } catch (err) {
      failed.push({ ref: t.ref, error: (err as Error).message.slice(0, 200) });
    }
  }
  return { pushed, alreadyPresent, conflicts, failed, durationMs: Date.now() - start };
}

async function mintPassword(repo: ArtifactsRepo, scope: "read" | "write", ttl: number): Promise<string> {
  const tokenResult = (await repo.createToken(scope, ttl)) as { plaintext?: string; token?: string };
  const rawToken = tokenResult.plaintext ?? tokenResult.token;
  if (!rawToken) throw new Error(`createToken (${scope}) returned no token`);
  return tokenSecret(rawToken);
}
