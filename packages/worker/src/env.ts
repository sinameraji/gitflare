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
  // CD deploy token (optional — set by `gitflare deploy enable`). Scoped to
  // Workers Scripts: Edit on the user's own account. Absent = CD disabled.
  CF_DEPLOY_TOKEN?: string;
  // Bearer secret the CLI presents to /control/* endpoints (manual deploy,
  // rollback, deploy list). Set by `gitflare deploy enable`.
  CONTROL_SECRET?: string;

  // Vars
  GITFLARE_VERSION: string;
  // JSON-encoded { "owner/repo": { name, remote } }
  REPO_MAP: string;
  // The Cloudflare account id, exposed so the Worker can call the Scripts API.
  ACCOUNT_ID?: string;
  // "1" when `gitflare deploy enable` is active. Gates CD independently of the
  // secret's presence so `disable` (a redeploy without this var) cleanly stops
  // deploys without needing to delete the Worker Secret.
  CD_ENABLED?: string;

  // Cloudflare Access (optional — set by `gitflare access enable`). When
  // ACCESS_AUD is present, the dashboard + API routes are gated behind a
  // verified Access token; absent means the mirror is public-readable.
  ACCESS_AUD?: string;
  ACCESS_TEAM_DOMAIN?: string; // e.g. "myteam.cloudflareaccess.com"

  // "1" when `gitflare ci enable` is active (v0.3). Gates the CI pipeline the
  // same way CD_ENABLED gates deploys; `ci disable` drops the var but keeps
  // the Sandbox container provisioned so re-enable never needs a migration.
  CI_ENABLED?: string;

  // "1" when `gitflare sync enable` is active (M9). Gates the alarm-driven
  // reverse pushes (Artifacts → GitHub); explicit `gitflare sync now` runs
  // regardless. The queue consumer only exists once sync is provisioned.
  SYNC_ENABLED?: string;
  // The Worker's own public URL (set by the CLI at deploy time) — needed by
  // the queue consumer, which has no incoming request to derive an origin
  // from, to build the commit-status target URL.
  WORKER_URL?: string;

  // Bindings
  ARTIFACTS: ArtifactsNamespace;
  REPO: DurableObjectNamespace;
  DEPLOY: DurableObjectNamespace;
  CI: DurableObjectNamespace;
  // Read-only issues/PRs/releases mirror (Stage 1). Migration v5.
  META: DurableObjectNamespace;
  // The Cloudflare Sandbox container namespace — present only after
  // `gitflare ci enable` adds the [[containers]] block to the Worker config.
  SANDBOX?: DurableObjectNamespace;
}

export function parseRepoMap(env: Env): RepoMap {
  try {
    return JSON.parse(env.REPO_MAP) as RepoMap;
  } catch {
    return {};
  }
}

/** Reverse lookup: an Artifacts repo name → its REPO_MAP entry + GitHub full_name. */
export function lookupByArtifactsName(
  env: Env,
  artifactsName: string,
): { githubFullName: string; name: string; remote: string } | undefined {
  const map = parseRepoMap(env);
  for (const [github, entry] of Object.entries(map)) {
    if (entry.name === artifactsName) return { githubFullName: github, ...entry };
  }
  return undefined;
}

export function lookupArtifactsRepoEntry(
  env: Env,
  githubFullName: string,
): RepoMapEntry | undefined {
  return parseRepoMap(env)[githubFullName];
}
