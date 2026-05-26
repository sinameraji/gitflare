import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { tokenSecret, type ArtifactsRepo } from "../types";

export interface ArtifactsRefSummary {
  ref: string;
  sha: string;
  isDefault?: boolean;
}

/**
 * List refs that currently exist in an Artifacts repo by speaking the smart
 * HTTP protocol against the repo's remote URL. This is "go look at what's
 * actually there" — independent of whether our incremental webhook sync has
 * fired yet, so it picks up the initial import history immediately.
 *
 * Mints a short-lived read token via the binding. Token never leaves this
 * Worker invocation.
 */
export async function listArtifactsRefs(
  repo: ArtifactsRepo,
  remote: string,
): Promise<ArtifactsRefSummary[]> {
  const token = await repo.createToken("read", 120);
  const password = tokenSecret(token.token);

  const refs = await git.listServerRefs({
    http,
    url: remote,
    onAuth: () => ({ username: "x", password }),
  });

  // Find HEAD (default branch) and tag it.
  const head = refs.find((r) => r.ref === "HEAD");
  const defaultSha = head?.oid;

  return refs
    .filter((r) => r.ref !== "HEAD")
    .map((r) => ({
      ref: r.ref,
      sha: r.oid,
      ...(defaultSha && r.oid === defaultSha ? { isDefault: true } : {}),
    }));
}
