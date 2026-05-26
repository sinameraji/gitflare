import type { FC } from "hono/jsx";
import { Layout } from "./layout";

export interface HomeRepo {
  githubFullName: string;
  artifactsRepoName: string;
  artifactsRemote: string;
  refs: Array<{ ref: string; sha: string; syncedAt: number }>;
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

const RepoCard: FC<{ repo: HomeRepo }> = ({ repo }) => (
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
          ) : repo.refs.length === 0 ? (
            <span class="pill warn">no syncs yet</span>
          ) : (
            <span class="pill ok">synced</span>
          )}
          {repo.error ? <span style="color:var(--muted); margin-left: 8px;">{repo.error}</span> : null}
        </div>
      </div>

      <div style="margin-top: 16px;">
        {repo.refs.length === 0 ? (
          <div class="empty">
            Push to <span class="mono">{repo.githubFullName}</span> to trigger the first sync.
          </div>
        ) : (
          <table class="refs">
            <thead>
              <tr>
                <th>Ref</th>
                <th>SHA</th>
                <th>Synced</th>
              </tr>
            </thead>
            <tbody>
              {repo.refs.map((r) => (
                <tr>
                  <td class="mono">{r.ref}</td>
                  <td class="mono">{r.sha.slice(0, 12)}</td>
                  <td>{formatAgo(r.syncedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  </>
);

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
