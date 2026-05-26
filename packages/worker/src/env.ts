import type { ArtifactsNamespace } from "./types";

export interface Env {
  // Secrets
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_TOKEN: string;

  // Vars
  GITFLARE_VERSION: string;
  // JSON-encoded { "owner/repo": "artifacts-repo-name" }
  REPO_MAP: string;

  // Bindings
  ARTIFACTS: ArtifactsNamespace;
  REPO: DurableObjectNamespace;
}

export function lookupArtifactsRepoName(
  env: Env,
  githubFullName: string,
): string | undefined {
  try {
    const map = JSON.parse(env.REPO_MAP) as Record<string, string>;
    return map[githubFullName];
  } catch {
    return undefined;
  }
}
