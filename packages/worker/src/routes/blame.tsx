import type { Hono } from "hono";
import { lookupByArtifactsName, type Env } from "../env";
import type { AccessVariables } from "../access/middleware";
import type { ArtifactsRepo } from "../types";
import { listArtifactsRefs } from "../artifacts/refs";
import { cloneBranchReaching, type ShallowRepo } from "../artifacts/content";
import { computeBlame } from "../blame/algorithm";
import { collectFileHistory, DEFAULT_BLAME_LIMITS } from "../blame/history";
import { BlameView } from "../ui/blame";
import { NotFound, ErrorView } from "../ui/states";

/** Upper bound for `?depth=`: a deeper clone costs memory in the isolate. */
export const MAX_BLAME_DEPTH = 500;

export interface BlameDeps {
  listBranches(repo: ArtifactsRepo, remote: string): Promise<string[]>;
  /** Clone `branch` with exactly `depth` commits of history. */
  cloneBranch(repo: ArtifactsRepo, remote: string, branch: string, depth: number): Promise<ShallowRepo>;
}

const defaultDeps: BlameDeps = {
  async listBranches(repo, remote) {
    const refs = await listArtifactsRefs(repo, remote);
    return refs.filter((r) => r.ref.startsWith("refs/heads/")).map((r) => r.ref.slice("refs/heads/".length));
  },
  async cloneBranch(repo, remote, branch, depth) {
    // No anchors: just the branch tip plus `depth` commits of history.
    return cloneBranchReaching(repo, remote, branch, [], { initialDepth: depth });
  },
};

/** `/r/:name/blame/:ref/*path` → { ref, path }; ref is one URL segment (encode `/` as %2F). */
export function parseBlamePath(pathname: string, name: string): { ref: string; path: string } | null {
  const prefix = `/r/${name}/blame/`;
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  try {
    const ref = decodeURIComponent(rest.slice(0, slash));
    const path = decodeURIComponent(rest.slice(slash + 1)).replace(/^\/+|\/+$/g, "");
    if (!ref || !path) return null;
    return { ref, path };
  } catch {
    return null;
  }
}

/**
 * Blame view. Registered on the main app under /r/*, so the Access guard
 * applied there covers it like every other browse route.
 */
export function registerBlameRoutes(
  app: Hono<{ Bindings: Env; Variables: AccessVariables }>,
  deps: BlameDeps = defaultDeps,
): void {
  app.get("/r/:name/blame/*", async (c) => {
    const name = c.req.param("name");
    const repo = lookupByArtifactsName(c.env, name);
    if (!repo)
      return c.html(<NotFound title="Repo not found" detail={`No mirror named “${name}” is configured on this Worker.`} />, 404);
    const parsed = parseBlamePath(new URL(c.req.url).pathname, name);
    if (!parsed)
      return c.html(
        <NotFound title="Not found" detail="Use /r/<repo>/blame/<branch>/<path>." backHref={`/r/${name}/tree/`} backLabel="← Repo root" />,
        404,
      );
    const { ref, path } = parsed;
    const depthQ = Number(c.req.query("depth"));
    const maxCommits =
      Number.isInteger(depthQ) && depthQ > 0 ? Math.min(depthQ, MAX_BLAME_DEPTH) : DEFAULT_BLAME_LIMITS.maxCommits;

    try {
      const handle = await c.env.ARTIFACTS.get(name);
      const branches = await deps.listBranches(handle, repo.remote);
      if (!branches.includes(ref))
        return c.html(
          <NotFound
            title="Branch not found"
            detail={`“${ref}” isn't a branch on the mirror (blame works on branches).`}
            backHref={`/r/${name}/tree/`}
            backLabel="← Repo root"
          />,
          404,
        );
      const clone = await deps.cloneBranch(handle, repo.remote, ref, maxCommits);
      const limits = { ...DEFAULT_BLAME_LIMITS, maxCommits };
      const history = await collectFileHistory({ fs: clone.fs, dir: clone.dir, headSha: clone.headSha, path, limits });
      if (history.kind === "missing" || history.kind === "directory")
        return c.html(
          <NotFound
            title="File not found"
            detail={`“${path}” isn't a file on ${ref}.`}
            backHref={`/r/${name}/tree/`}
            backLabel="← Repo root"
          />,
          404,
        );
      const common = {
        githubFullName: repo.githubFullName,
        artifactsRepoName: name,
        branch: ref,
        headSha: clone.headSha,
        path,
        limits: { ...limits, maxDepth: MAX_BLAME_DEPTH },
      };
      if (history.kind !== "ok")
        return c.html(<BlameView {...common} unavailable={history.kind} size={history.size} />);
      const result = computeBlame(history.versions, { truncated: history.truncated !== null });
      return c.html(
        <BlameView
          {...common}
          text={history.versions[0]!.text}
          result={result}
          commitsWalked={history.commitsWalked}
          truncated={history.truncated}
        />,
      );
    } catch (err) {
      return c.html(<ErrorView detail={(err as Error).message} backHref={`/r/${name}/tree/`} />, 500);
    }
  });
}
