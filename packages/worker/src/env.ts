import type { ArtifactsNamespace } from "./types";

export interface RepoMapEntry {
  name: string;    // Artifacts repo name
  remote: string;  // git clone URL handed back by Artifacts on create/import
}

export type RepoMap = Record<string, RepoMapEntry>;

export interface Env {
  // Secrets
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;

  // Vars
  GITFLARE_VERSION: string;
  // JSON-encoded { "owner/repo": { name, remote } }
  REPO_MAP: string;

  // Bindings
  ARTIFACTS: ArtifactsNamespace;
  REPO: DurableObjectNamespace;
}

export function parseRepoMap(env: Env): RepoMap {
  try {
    return JSON.parse(env.REPO_MAP) as RepoMap;
  } catch {
    return {};
  }
}

export function lookupArtifactsRepoEntry(
  env: Env,
  githubFullName: string,
): RepoMapEntry | undefined {
  return parseRepoMap(env)[githubFullName];
}
