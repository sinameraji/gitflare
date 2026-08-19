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
