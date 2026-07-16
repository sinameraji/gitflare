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
  token: string;
  fetchImpl?: typeof fetch;
}

export interface CommitStatusResult {
  ok: boolean;
  status: number;
  detail?: string;
}

const CONTEXT = "gitflare/ci";
const MAX_DESCRIPTION = 140; // GitHub caps description length

export function buildStatusRequest(p: CommitStatusParams): { url: string; init: RequestInit } {
  const body: Record<string, string> = {
    state: p.state,
    context: CONTEXT,
    description:
      p.description.length > MAX_DESCRIPTION
        ? `${p.description.slice(0, MAX_DESCRIPTION - 1)}…`
        : p.description,
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
    const resp = await fetchImpl(url, init);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, detail: text.slice(0, 200) };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    return { ok: false, status: 0, detail: (e as Error).message };
  }
}
