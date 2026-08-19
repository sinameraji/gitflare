export interface DeployLike {
  id: number;
  branch: string;
  sha: string;
  mode: string;
  status: string;
}

export const PUSH_LIKE_MODES = new Set(["push", "artifacts-push"]);

export function isPushLikeMode(mode: string | undefined): boolean {
  return PUSH_LIKE_MODES.has(mode ?? "push");
}

/**
 * Has a push-triggered deploy for this exact branch+sha already run to a
 * terminal verdict? A GitHub webhook redelivery, or the second delivery of a
 * fan-out push (webhook + Artifacts event), must not deploy the same commit
 * twice. Only push-like modes count — a manual re-deploy or a rollback is an
 * explicit "do it again"; a CI-delegated deploy is gated by CiDO's own dedupe.
 * "skipped" records don't count either: they didn't ship, so a retry may.
 */
export function findDuplicateDeploy<T extends DeployLike>(
  history: readonly T[],
  branch: string,
  sha: string,
): T | undefined {
  if (!/^[0-9a-f]{40}$/.test(sha)) return undefined;
  return history.find(
    (d) =>
      isPushLikeMode(d.mode) &&
      d.branch === branch &&
      d.sha === sha &&
      (d.status === "success" || d.status === "failed"),
  );
}
