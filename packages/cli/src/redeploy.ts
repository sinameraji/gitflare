import type { LocalConfig } from "./config.js";
import { wranglerDeploy, type DeployResult } from "./wrangler.js";

type RepoEntry = LocalConfig["repos"][number];

/**
 * Redeploy a repo's Worker, preserving any already-enabled Cloudflare Access
 * config stored on the entry. Used by `access` and `deploy` commands so that
 * enabling one feature never silently drops the other (Worker vars are
 * replaced wholesale on each deploy).
 */
export async function redeployWorker(
  entry: RepoEntry,
  cfToken: string,
  remote: string,
): Promise<DeployResult> {
  return wranglerDeploy({
    cloudflareApiToken: cfToken,
    accountId: entry.cloudflareAccountId,
    workerName: entry.workerName,
    artifactsNamespace: entry.artifactsNamespace,
    repoMap: {
      [entry.githubFullName]: { name: entry.artifactsRepoName, remote },
    },
    ...(entry.access
      ? { accessAud: entry.access.aud, accessTeamDomain: entry.access.teamDomain }
      : {}),
    ...(entry.deploy ? { cdEnabled: true } : {}),
  });
}
