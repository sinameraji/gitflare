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
 * HTTP protocol against the repo's remote URL.
 *
 * The Artifacts Workers-binding docs describe createToken(scope?, ttl?) but
 * don't pin down the return shape. We handle the plausible variants and
 * throw a diagnostic error if none match — so future shape changes show up
 * as actionable errors instead of "Cannot read properties of undefined."
 */
export async function listArtifactsRefs(
  repo: ArtifactsRepo,
  remote: string,
): Promise<ArtifactsRefSummary[]> {
  const tokenResult: unknown = await repo.createToken("read", 120);
  const rawToken = await extractToken(tokenResult);
  const password = tokenSecret(rawToken);

  const refs = await git.listServerRefs({
    http,
    url: remote,
    onAuth: () => ({ username: "x", password }),
  });

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

async function extractToken(result: unknown): Promise<string> {
  // (a) String literal.
  if (typeof result === "string") return result;
  // (b) Object — try plausible field names. Each may also be an RPC property
  //     that needs an extra await; awaiting a string is a no-op so it's safe.
  if (result && typeof result === "object") {
    const obj = result as Record<string, unknown>;
    for (const k of ["plaintext", "token", "secret", "value", "accessToken"]) {
      const v = obj[k];
      if (v == null) continue;
      const awaited = await (v as Promise<unknown>);
      if (typeof awaited === "string") return awaited;
    }
  }
  // (c) RPC stub directly — try awaiting properties on it.
  if (result && typeof (result as { token?: unknown }).token !== "undefined") {
    const awaited = await ((result as { token: Promise<unknown> }).token);
    if (typeof awaited === "string") return awaited;
  }
  throw new Error(
    `createToken returned unexpected shape: ${safeStringify(result)}`,
  );
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v);
  } catch {
    return String(v);
  }
}
