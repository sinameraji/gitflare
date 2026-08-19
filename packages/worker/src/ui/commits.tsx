import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import type { CommitSummary } from "../artifacts/content";

export interface CommitsProps {
  githubFullName: string;
  artifactsRepoName: string;
  branch: string;
  branches: string[]; // for the switcher
  headSha: string;
  commits: CommitSummary[];
  limit: number;
}

export const Commits: FC<CommitsProps> = (p) => (
  <Layout title={`Commits · ${p.githubFullName}`}>
    <div class="wrap">
      <div class="hdr">
        <div class="brand">
          <a href="/" style="display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none;">
            <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
            GitFlare
          </a>
        </div>
      </div>

      <h1>Commits</h1>
      <p class="muted">
        {p.githubFullName} · <a href={`/r/${p.artifactsRepoName}/tree/`}>browse code</a> ·{" "}
        <a href={`/r/${p.artifactsRepoName}/deployments`}>deployments</a> ·{" "}
        <a href={`/r/${p.artifactsRepoName}/ci`}>CI runs</a> ·{" "}
        <a href={`https://github.com/${p.githubFullName}/commits/${encodeURIComponent(p.branch)}`}>on GitHub ↗</a>
      </p>
    <div class="card" style="margin-bottom: 14px; display:flex; gap:12px; align-items:center; flex-wrap:wrap;">
      <span class="muted">branch</span>
      <span class="mono">{p.branch}</span>
      <span class="muted">· head</span>
      <span class="mono">{p.headSha.slice(0, 12)}</span>
      <span class="muted">· showing the latest {p.commits.length} (mirror history window {p.limit})</span>
      {p.branches.length > 1 ? (
        <span style="margin-left:auto;">
          <span class="muted">switch: </span>
          {p.branches.slice(0, 12).map((b) =>
            b === p.branch ? (
              <span class="mono" style="margin-right:8px;">{b}</span>
            ) : (
              <a class="mono" style="margin-right:8px;" href={`/r/${p.artifactsRepoName}/commits?ref=${encodeURIComponent(b)}`}>
                {b}
              </a>
            ),
          )}
        </span>
      ) : null}
    </div>
    {p.commits.length === 0 ? (
      <div class="empty">No commits on the mirror for this branch yet.</div>
    ) : (
      <table class="refs">
        <thead>
          <tr>
            <th>SHA</th>
            <th>Message</th>
            <th>Author</th>
            <th>When</th>
          </tr>
        </thead>
        <tbody>
          {p.commits.map((c) => (
            <tr>
              <td class="mono">
                <a href={`https://github.com/${p.githubFullName}/commit/${c.sha}`} title="open on GitHub">{c.sha.slice(0, 8)}</a>
                {c.parents.length > 1 ? <span class="pill" style="margin-left:6px;" title="merge commit">merge</span> : null}
              </td>
              <td title={c.body || undefined}>{c.message}</td>
              <td style="color: var(--muted);" title={c.author.email}>{c.author.name}</td>
              <td style="color: var(--muted); white-space: nowrap;" title={new Date(c.author.timestamp).toISOString()}>
                {formatAgo(c.author.timestamp)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}
    </div>
  </Layout>
);

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}
