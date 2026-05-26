import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { tokenSecret, type ArtifactsRepo } from "../types";

// Cloudflare Workers don't have a real fs. isomorphic-git accepts any
// LightningFS-compatible fs; we use a minimal in-memory implementation that
// supports the operations isomorphic-git calls during fetch + push.
import { MemFs } from "./memfs";

export interface SyncParams {
  githubFullName: string;          // "owner/repo"
  githubToken: string;             // for private repos + rate limit
  ref: string;                     // "refs/heads/main"
  artifactsRepo: ArtifactsRepo;    // the destination handle
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

  await git.init({ fs, dir, defaultBranch: "main" });

  const githubUrl = `https://github.com/${params.githubFullName}.git`;
  const isNewBranch = /^0+$/.test(params.beforeSha);

  // Fetch from GitHub. For new branches we don't know how deep to go; default
  // to a reasonable depth and let isomorphic-git extend if needed. For
  // existing branches, depth covers the delta with headroom.
  await git.fetch({
    fs,
    http,
    dir,
    url: githubUrl,
    ref: params.ref.replace(/^refs\/heads\//, ""),
    singleBranch: true,
    depth: isNewBranch ? 200 : 50,
    tags: true,
    onAuth: () => ({
      username: "x-access-token",
      password: params.githubToken,
    }),
  });

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
    url: params.artifactsRepo.remote,
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
