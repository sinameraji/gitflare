import type { FC } from "hono/jsx";
import { marked } from "marked";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import type { TreeEntry } from "../artifacts/content";

export interface HomeRepo {
  githubFullName: string;
  artifactsRepoName: string;
  artifactsRemote: string;
  /** Refs currently in the Artifacts repo (from the live git protocol). */
  branches: Array<{ ref: string; sha: string; isDefault?: boolean }>;
  /** Refs we've handled via webhook sync (last synced time per ref). */
  syncedRefs: Array<{ ref: string; sha: string; syncedAt: number }>;
  content?: {
    defaultBranch: string;
    headSha: string;
    tree: TreeEntry[];
    readme?: { path: string; text: string };
    totalBytes: number;
  };
  error?: string;
}

// Rewrite relative README image paths to the Worker's own raw-blob proxy
// (/r/<name>/raw/<path>). Serving from the Artifacts mirror — rather than
// raw.githubusercontent.com — means images render for private repos too and
// keep working during a GitHub outage. The README lives at the repo root, so
// relative paths resolve from there.
function rewriteReadmeImages(md: string, artifactsRepoName: string): string {
  const base = `/r/${artifactsRepoName}/raw`;
  // ![alt](url) — handle markdown image syntax
  let out = md.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (m, alt, url) => {
    const u = String(url).trim();
    if (/^(https?|data):/i.test(u)) return m;
    const norm = u.replace(/^\.\//, "").replace(/^\//, "");
    return `![${alt}](${base}/${norm})`;
  });
  // <img src="..."> — handle raw HTML image tags
  out = out.replace(/<img\s+([^>]*?)src=["']([^"']+)["']([^>]*)>/gi, (m, pre, url, post) => {
    if (/^(https?|data):/i.test(url)) return m;
    const norm = url.replace(/^\.\//, "").replace(/^\//, "");
    return `<img ${pre}src="${base}/${norm}"${post}>`;
  });
  return out;
}

export const Home: FC<{ repos: HomeRepo[]; version: string }> = ({
  repos,
  version,
}) => (
  <Layout>
    <div class="wrap">
      <div class="hdr">
        <div class="brand">
          <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
          GitFlare
        </div>
        <div class="ver mono">v{version}</div>
      </div>

      <h1>Your mirrors</h1>
      <p class="muted">
        GitHub stays your source of truth. This Worker mirrors into your Artifacts repos.
      </p>

      {repos.length === 0 ? (
        <div class="empty" style="margin-top: 24px; text-align: left;">
          <div style="margin-bottom: 12px;">No repos mirrored on this Worker yet.</div>
          <pre style="margin: 0 0 12px; padding: 12px; background: var(--bg); border: 1px solid var(--border); border-radius: 6px; overflow-x: auto;"><code class="mono">npx gitflare init github.com/&lt;owner&gt;/&lt;repo&gt;</code></pre>
          <div class="muted">
            Runs on your machine, provisions into your own Cloudflare account, and sets{" "}
            <code>REPO_MAP</code> here.{" "}
            <a href="https://github.com/sinameraji/gitflare/blob/main/QUICKSTART.md">Full walkthrough →</a>
          </div>
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

      {repo.content ? <RepoContentSection repo={repo} content={repo.content} /> : null}
    </>
  );
};

const RepoContentSection: FC<{ repo: HomeRepo; content: NonNullable<HomeRepo["content"]> }> = ({
  repo,
  content,
}) => (
  <>
    <h2>Files on {content.defaultBranch}</h2>
    <div class="card" style="padding: 0; overflow: hidden;">
      <div class="muted mono" style="font-size: 12px; padding: 12px 16px; border-bottom: 1px solid var(--border);">
        HEAD {content.headSha.slice(0, 12)} · {content.tree.length} top-level entries · {formatBytes(content.totalBytes)}
      </div>
      <table class="refs" style="margin: 0;">
        <thead>
          <tr>
            <th style="width: 60px;">Type</th>
            <th>Name</th>
            <th style="text-align: right; width: 100px;">Size</th>
          </tr>
        </thead>
        <tbody>
          {content.tree.map((e) => {
            const href = e.type === "tree"
              ? `/r/${repo.artifactsRepoName}/tree/${e.path}`
              : `/r/${repo.artifactsRepoName}/blob/${e.path}`;
            return (
              <tr>
                <td class="mono" style="color: var(--muted);">{e.type === "tree" ? "dir" : "file"}</td>
                <td><a class="mono" href={href}>{e.path}{e.type === "tree" ? "/" : ""}</a></td>
                <td class="mono" style="text-align: right; color: var(--muted);">
                  {e.type === "blob" && e.size !== undefined ? formatBytes(e.size) : ""}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>

    {content.readme ? (
      <>
        <h2>{content.readme.path}</h2>
        <div class="card readme">
          <div
            dangerouslySetInnerHTML={{
              __html: renderMarkdown(
                rewriteReadmeImages(content.readme.text, repo.artifactsRepoName),
              ),
            }}
          />
        </div>
      </>
    ) : null}
  </>
);

function renderMarkdown(src: string): string {
  try {
    return marked.parse(src, { async: false }) as string;
  } catch {
    return `<pre>${escapeHtml(src)}</pre>`;
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function formatAgo(ms: number): string {
  const diff = Date.now() - ms;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}
