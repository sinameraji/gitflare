import type { Env } from "../env";

// Stubs are resolved inline (not via ciStubFor/deployStubFor) so this module
// stays free of the DO classes' heavy imports (@cloudflare/sandbox) and can be
// unit-tested in a plain node environment like the rest of the suite.

export type PushMode = "push" | "artifacts-push";

export interface DispatchInput {
  githubFullName: string;
  artifactsRepoName: string;
  remote: string;
  ref: string;
  sha: string;
  mode: PushMode;
  /** The Worker's public origin, for the commit-status "Details" link. */
  origin: string;
}

/**
 * Hand a mirrored push to exactly ONE pipeline — a single decision point so
 * two DOs never decide independently:
 *  - CI enabled (v0.3): CiDO. It runs .gitflare/ci.yml when present and
 *    passes plain v0.2 pushes through to DeployDO itself when it isn't.
 *  - otherwise (v0.2): DeployDO, which no-ops without a deploy.yml and fails
 *    closed if a ci.yml is committed but CI was never enabled.
 * Used by both the GitHub webhook (mode "push") and the Artifacts queue
 * consumer (mode "artifacts-push").
 */
export async function dispatchPush(env: Env, input: DispatchInput): Promise<void> {
  if (env.CI_ENABLED === "1") {
    await env.CI.get(env.CI.idFromName(input.artifactsRepoName)).fetch("https://ci-do/run", {
      method: "POST",
      body: JSON.stringify({
        artifactsRepoName: input.artifactsRepoName,
        remote: input.remote,
        githubFullName: input.githubFullName,
        ref: input.ref,
        sha: input.sha,
        mode: input.mode,
        statusTargetUrl: `${input.origin}/r/${input.artifactsRepoName}/ci`,
      }),
    });
  } else {
    await env.DEPLOY.get(env.DEPLOY.idFromName(input.artifactsRepoName)).fetch("https://deploy-do/deploy", {
      method: "POST",
      body: JSON.stringify({
        artifactsRepoName: input.artifactsRepoName,
        remote: input.remote,
        ref: input.ref,
        sha: input.sha,
        mode: input.mode,
      }),
    });
  }
}
