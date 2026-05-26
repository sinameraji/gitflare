import type { FC } from "hono/jsx";
import { Layout } from "./layout";

export interface HomeRepo {
  githubFullName: string;
  artifactsRepoName: string;
  artifactsRemote: string;
  /** Refs currently in the Artifacts repo (from the live git protocol). */
  branches: Array<{ ref: string; sha: string; isDefault?: boolean }>;
  /** Refs we've handled via webhook sync (last synced time per ref). */
  syncedRefs: Array<{ ref: string; sha: string; syncedAt: number }>;
  error?: string;
}

export const Home: FC<{ repos: HomeRepo[]; version: string }> = ({
  repos,
  version,
}) => (
  <Layout>
    <div class="wrap">
      <div class="hdr">
        <div class="brand">
          <span class="logo" />
          GitFlare
        </div>
        <div class="ver mono">v{version}</div>
      </div>

      <h1>Your mirrors</h1>
      <p class="muted">
        GitHub stays your source of truth. This Worker mirrors into your Artifacts repos.
      </p>

      {repos.length === 0 ? (
        <div class="empty" style="margin-top: 24px;">
          No repos configured yet. Set <code>REPO_MAP</code> on this Worker (the CLI does this for you) and re-deploy.
        </div>
      ) : (
        repos.map((r) => <RepoCard key={r.githubFullName} repo={r} />)
      )}

      <footer>
        <span class="mono">/health</span> · <span class="mono">/webhooks/github</span> · <span class="mono">/api/refs</span>
      </footer>
    </div>
  </Layout>
);

const RepoCard: FC<{ repo: HomeRepo }> = ({ repo }) => {
  const synced = new Map(repo.syncedRefs.map((s) => [s.ref, s]));
  const mirrored = repo.branches.length > 0;
  return (
    <>
      <h2>{repo.githubFullName}</h2>
      <div class="card">
        <div class="kv">
          <div class="k">GitHub</div>
          <div class="v">
            <a href={`https://github.com/${repo.githubFullName}`}>{repo.githubFullName}</a>
          </div>
          <div class="k">Artifacts repo</div>
          <div class="v">{repo.artifactsRepoName}</div>
          <div class="k">Clone URL</div>
          <div class="v">{repo.artifactsRemote || "—"}</div>
          <div class="k">Status</div>
          <div class="v">
            {repo.error ? (
              <span class="pill err">error</span>
            ) : mirrored ? (
              <span class="pill ok">mirrored</span>
            ) : (
              <span class="pill warn">empty</span>
            )}
            {repo.error ? <span style="color:var(--muted); margin-left: 8px;">{repo.error}</span> : null}
            {mirrored ? (
              <span style="color:var(--muted); margin-left: 8px;">
                {repo.branches.length} ref{repo.branches.length === 1 ? "" : "s"} in Artifacts
              </span>
            ) : null}
          </div>
        </div>

        <div style="margin-top: 16px;">
          {!mirrored ? (
            <div class="empty">
              No refs in Artifacts yet. If init just finished, the import is still seeding — refresh in a few seconds.
            </div>
          ) : (
            <table class="refs">
              <thead>
                <tr>
                  <th>Ref</th>
                  <th>SHA</th>
                  <th>Last synced via webhook</th>
                </tr>
              </thead>
              <tbody>
                {repo.branches.map((b) => {
                  const s = synced.get(b.ref);
                  return (
                    <tr>
                      <td class="mono">
                        {b.ref}
                        {b.isDefault ? <span class="pill ok" style="margin-left: 8px;">default</span> : null}
                      </td>
                      <td class="mono">{b.sha.slice(0, 12)}</td>
                      <td style="color: var(--muted);">{s ? formatAgo(s.syncedAt) : <em>import seed</em>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <details style="margin-top: 16px;">
          <summary style="cursor: pointer; color: var(--muted); font-size: 12px;">How to clone</summary>
          <pre style="margin-top: 8px; padding: 12px; background: var(--bg); border-radius: 6px; border: 1px solid var(--border); overflow-x: auto;"><code class="mono">{`# Mint a read token (Cloudflare dashboard → Artifacts → ${repo.artifactsRepoName} → Tokens)
ARTIFACTS_TOKEN=<paste-token-here>
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" \\
    clone "${repo.artifactsRemote}"`}</code></pre>
        </details>
      </div>
    </>
  );
};

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
