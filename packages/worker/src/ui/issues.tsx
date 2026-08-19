import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { marked } from "marked";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import { linkifyReferences, type CommentRecord, type IssueRecord, type PullRecord, type ReleaseRecord } from "../meta/map";
import type { MetaState } from "../durable-objects/meta";

interface Shell {
  githubFullName: string;
  artifactsRepoName: string;
  backfill?: MetaState["backfill"] | null | undefined;
}

const Nav: FC<Shell & { active: "issues" | "pulls" | "releases" }> = (p) => (
  <>
    <div class="hdr">
      <div class="brand">
        <a href="/" style="display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none;">
          <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
          GitFlare
        </a>
      </div>
    </div>
    <p class="muted" style="margin-top: 8px;">
      {p.githubFullName} · <a href={`/r/${p.artifactsRepoName}/tree/`}>code</a> ·{" "}
      <a href={`/r/${p.artifactsRepoName}/commits`}>commits</a> ·{" "}
      {p.active === "issues" ? <b>issues</b> : <a href={`/r/${p.artifactsRepoName}/issues`}>issues</a>} ·{" "}
      {p.active === "pulls" ? <b>pull requests</b> : <a href={`/r/${p.artifactsRepoName}/pulls`}>pull requests</a>} ·{" "}
      {p.active === "releases" ? <b>releases</b> : <a href={`/r/${p.artifactsRepoName}/releases`}>releases</a>} ·{" "}
      <a href={`/r/${p.artifactsRepoName}/deployments`}>deployments</a> · <a href={`/r/${p.artifactsRepoName}/ci`}>CI</a>
    </p>
    <BackfillNote {...p} />
  </>
);

const BackfillNote: FC<Shell> = ({ backfill, artifactsRepoName }) => {
  if (!backfill) {
    return (
      <div class="banner">
        <strong>Read-only mirror of GitHub's issues, pull requests, and releases.</strong> Nothing has been imported yet — the first
        import runs on this visit and shows up on refresh; new activity arrives via the webhook from now on. Actions (comment, close,
        merge) happen on GitHub — every item links out.
      </div>
    );
  }
  if (backfill.status === "running") {
    return <div class="banner">Importing history from GitHub… refresh in a moment. New activity is captured live meanwhile.</div>;
  }
  if (backfill.status === "failed") {
    return (
      <div class="banner">
        Import failed: <span class="mono">{backfill.error}</span>. Live events still work; retry with{" "}
        <code class="mono">gitflare sync issues</code>.
      </div>
    );
  }
  return backfill.truncated ? (
    <div class="banner">
      Imported {backfill.issues} issues, {backfill.pulls} PRs, {backfill.comments} comments, {backfill.releases} releases — very large
      history, oldest items beyond the import cap are only on GitHub. <span class="muted">({artifactsRepoName})</span>
    </div>
  ) : null;
};

function fmtWhen(ms: number | undefined): string {
  if (!ms) return "";
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 30 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

const Labels: FC<{ labels: IssueRecord["labels"] }> = ({ labels }) => (
  <>
    {labels.map((l) => (
      <span
        class="pill"
        style={`margin-left:6px; ${l.color ? `border-color:#${l.color}; color:#${l.color};` : ""}`}
        title={l.name}
      >
        {l.name}
      </span>
    ))}
  </>
);

const StatePill: FC<{ item: IssueRecord | PullRecord }> = ({ item }) => {
  if (item.isPull) {
    const p = item as PullRecord;
    if (p.merged) return <span class="pill" style="border-color:#8957e5; color:#b58cff;">merged</span>;
    if (p.state === "closed") return <span class="pill err">closed</span>;
    if (p.draft) return <span class="pill">draft</span>;
    return <span class="pill ok">open</span>;
  }
  return item.state === "open" ? <span class="pill ok">open</span> : <span class="pill err">closed{item.stateReason === "not_planned" ? " · not planned" : ""}</span>;
};

export const IssueList: FC<
  Shell & { kind: "issues" | "pulls"; items: Array<IssueRecord | PullRecord>; filter: "open" | "closed" | "all" }
> = (p) => {
  const shown = p.items.filter((i) => (p.filter === "all" ? true : i.state === p.filter)).sort((a, b) => b.updatedAt - a.updatedAt);
  const openN = p.items.filter((i) => i.state === "open").length;
  const closedN = p.items.length - openN;
  const base = `/r/${p.artifactsRepoName}/${p.kind}`;
  const label = p.kind === "issues" ? "Issues" : "Pull requests";
  return (
    <Layout title={`${label} · ${p.githubFullName}`}>
      <div class="wrap">
        <Nav {...p} active={p.kind} />
        <h1>{label}</h1>
        <p class="muted">
          {p.filter === "open" ? <b>{openN} open</b> : <a href={`${base}?state=open`}>{openN} open</a>} ·{" "}
          {p.filter === "closed" ? <b>{closedN} closed</b> : <a href={`${base}?state=closed`}>{closedN} closed</a>} ·{" "}
          {p.filter === "all" ? <b>all</b> : <a href={`${base}?state=all`}>all</a>} ·{" "}
          <a href={`https://github.com/${p.githubFullName}/${p.kind}`}>on GitHub ↗</a>
          {p.kind === "issues" ? (
            <>
              {" · "}
              <a href={`https://github.com/${p.githubFullName}/issues/new`}>new issue on GitHub ↗</a>
            </>
          ) : null}
        </p>
        {shown.length === 0 ? (
          <div class="empty">Nothing here{p.filter !== "all" ? ` (${p.filter})` : ""}.</div>
        ) : (
          <table class="refs">
            <tbody>
              {shown.map((i) => (
                <tr>
                  <td class="mono" style="width: 70px;">
                    <a href={`${base}/${i.number}`}>#{i.number}</a>
                  </td>
                  <td>
                    <a href={`${base}/${i.number}`} style="color: var(--fg); font-weight: 500;">{i.title}</a>
                    <Labels labels={i.labels} />
                    <div class="muted" style="font-size: 12px; margin-top: 2px;">
                      <StatePill item={i} /> {i.user.login} · updated {fmtWhen(i.updatedAt)}
                      {i.commentsCount ? ` · ${i.commentsCount} comment${i.commentsCount === 1 ? "" : "s"}` : ""}
                      {i.isPull ? ` · ${(i as PullRecord).head.ref} → ${(i as PullRecord).base.ref}` : ""}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </Layout>
  );
};

function renderMd(md: string, base: string, isPull: (n: number) => boolean): string {
  try {
    return marked.parse(linkifyReferences(md, base, isPull), { async: false }) as string;
  } catch {
    return `<pre>${md.replace(/</g, "&lt;")}</pre>`;
  }
}

export const IssueDetail: FC<
  Shell & { kind: "issues" | "pulls"; item: IssueRecord | PullRecord; comments: CommentRecord[]; isPull: (n: number) => boolean }
> = (p) => {
  const base = `/r/${p.artifactsRepoName}`;
  const i = p.item;
  const pr = i.isPull ? (i as PullRecord) : null;
  return (
    <Layout title={`#${i.number} ${i.title} · ${p.githubFullName}`}>
      <div class="wrap">
        <Nav {...p} active={p.kind} />
        <h1 style="margin-bottom: 4px;">
          {i.title} <span class="muted mono" style="font-weight: 400;">#{i.number}</span>
        </h1>
        <p class="muted" style="margin-top: 0;">
          <StatePill item={i} /> <b>{i.user.login}</b> opened {fmtWhen(i.createdAt)}
          {i.closedAt ? ` · closed ${fmtWhen(i.closedAt)}` : ""}
          {pr ? (
            <>
              {" · "}
              <span class="mono">{pr.head.ref}</span> → <span class="mono">{pr.base.ref}</span>
              {pr.additions !== undefined ? (
                <span class="mono">
                  {" "}
                  <span style="color: var(--ok);">+{pr.additions}</span> <span style="color: var(--err);">−{pr.deletions}</span>
                </span>
              ) : null}
              {pr.mergedAt ? ` · merged ${fmtWhen(pr.mergedAt)}` : ""}
            </>
          ) : null}
          <Labels labels={i.labels} />
          {" · "}
          <a href={i.htmlUrl}>{pr ? "review / merge on GitHub ↗" : "comment / close on GitHub ↗"}</a>
        </p>
        <div class="card readme">
          {i.body ? raw(renderMd(i.body, base, p.isPull)) : <span class="muted">No description.</span>}
          {i.bodyTruncated ? <p class="muted">(truncated — full text on GitHub)</p> : null}
        </div>
        {p.comments.length > 0 ? (
          <h2 style="margin-top: 20px;">
            {p.comments.length} comment{p.comments.length === 1 ? "" : "s"}
          </h2>
        ) : null}
        {p.comments.map((c) => (
          <div class="card" style="margin-top: 10px;">
            <div class="muted" style="font-size: 12px; margin-bottom: 8px;">
              <b>{c.user.login}</b>
              {c.kind === "review" ? (
                <span class={`pill ${c.reviewState === "approved" ? "ok" : c.reviewState === "changes_requested" ? "err" : ""}`} style="margin-left: 6px;">
                  review: {c.reviewState ?? "commented"}
                </span>
              ) : null}{" "}
              · {fmtWhen(c.createdAt)} · <a href={c.htmlUrl}>on GitHub ↗</a>
            </div>
            <div class="readme">{c.body ? raw(renderMd(c.body, base, p.isPull)) : <span class="muted">(no text)</span>}</div>
          </div>
        ))}
        {i.commentsCount > p.comments.filter((c) => c.kind === "comment").length ? (
          <p class="muted" style="margin-top: 10px;">
            Some comments predate the import window — see the full thread <a href={i.htmlUrl}>on GitHub ↗</a>.
          </p>
        ) : null}
      </div>
    </Layout>
  );
};

export const Releases: FC<Shell & { items: ReleaseRecord[]; isPull: (n: number) => boolean }> = (p) => {
  const base = `/r/${p.artifactsRepoName}`;
  return (
    <Layout title={`Releases · ${p.githubFullName}`}>
      <div class="wrap">
        <Nav {...p} active="releases" />
        <h1>Releases</h1>
        <p class="muted">
          {p.items.length} release{p.items.length === 1 ? "" : "s"} · <a href={`https://github.com/${p.githubFullName}/releases`}>on GitHub ↗</a>
        </p>
        {p.items.length === 0 ? (
          <div class="empty">No releases mirrored yet.</div>
        ) : (
          p.items.map((r) => (
            <div class="card" style="margin-top: 12px;">
              <h2 style="margin: 0 0 4px;">
                <a href={r.htmlUrl}>{r.name}</a> <span class="mono muted" style="font-size: 12px;">{r.tagName}</span>
                {r.prerelease ? <span class="pill" style="margin-left: 8px;">pre-release</span> : null}
                {r.draft ? <span class="pill" style="margin-left: 8px;">draft</span> : null}
              </h2>
              <div class="muted" style="font-size: 12px; margin-bottom: 8px;">
                {r.author.login} · {fmtWhen(r.publishedAt ?? r.createdAt)}
                {r.assets.length ? ` · ${r.assets.length} asset${r.assets.length === 1 ? "" : "s"}` : ""}
              </div>
              <div class="readme">{r.body ? raw(renderMd(r.body, base, p.isPull)) : <span class="muted">No notes.</span>}</div>
              {r.assets.length ? (
                <ul style="margin: 8px 0 0; padding-left: 18px;">
                  {r.assets.map((a) => (
                    <li>
                      <a href={a.downloadUrl}>{a.name}</a> <span class="muted mono">{(a.size / 1024).toFixed(0)} KB</span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ))
        )}
      </div>
    </Layout>
  );
};
