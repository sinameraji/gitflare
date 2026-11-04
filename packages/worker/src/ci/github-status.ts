// Posts CI results to GitHub's legacy Commit Status API. The Worker holds a
// classic PAT with `repo` scope (set by `gitflare init`), which Status accepts;
// the newer Checks API needs a GitHub App and is out of reach — fine, since
// statuses render on commits/PRs all the same. Callers soft-fail on errors:
// GitHub being down is exactly the scenario gitflare exists for.

export type CommitState = "pending" | "success" | "failure" | "error";

export interface CommitStatusParams {
  githubFullName: string; // "owner/repo"
  sha: string;
  state: CommitState;
  description: string;
  targetUrl?: string;
  /** Status context; defaults to the overall `gitflare/ci`. */
  context?: string;
  token: string;
  fetchImpl?: typeof fetch;
}

export interface CommitStatusResult {
  ok: boolean;
  status: number;
  detail?: string;
}

export const CI_CONTEXT = "gitflare/ci";
export const MAX_DESCRIPTION = 140; // GitHub caps description length
/** Don't let a hung api.github.com stall the pipeline: statuses are best-effort. */
const POST_TIMEOUT_MS = 10_000;

export function truncateDescription(d: string): string {
  return d.length > MAX_DESCRIPTION ? `${d.slice(0, MAX_DESCRIPTION - 1)}…` : d;
}

export function buildStatusRequest(p: CommitStatusParams): { url: string; init: RequestInit } {
  const body: Record<string, string> = {
    state: p.state,
    context: p.context ?? CI_CONTEXT,
    description: truncateDescription(p.description),
  };
  if (p.targetUrl) body.target_url = p.targetUrl;
  return {
    url: `https://api.github.com/repos/${p.githubFullName}/statuses/${p.sha}`,
    init: {
      method: "POST",
      headers: {
        Authorization: `Bearer ${p.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        // GitHub rejects requests without a User-Agent.
        "User-Agent": "gitflare-worker",
      },
      body: JSON.stringify(body),
    },
  };
}

export async function postCommitStatus(p: CommitStatusParams): Promise<CommitStatusResult> {
  const fetchImpl = p.fetchImpl ?? fetch;
  const { url, init } = buildStatusRequest(p);
  try {
    const signal =
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(POST_TIMEOUT_MS)
        : undefined;
    const resp = await fetchImpl(url, signal ? { ...init, signal } : init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, detail: text.slice(0, 200) };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  }
}
