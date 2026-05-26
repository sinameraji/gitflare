import type { FC } from "hono/jsx";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import type { TreeEntry, BlobAtPath } from "../artifacts/content";

interface BrowseProps {
  githubFullName: string;
  artifactsRepoName: string;
  branchName: string;
  headSha: string;
  path: string;          // "" for root
  entries?: TreeEntry[]; // tree view
  blob?: BlobAtPath;     // blob view
  version: string;
}

export const Browse: FC<BrowseProps> = (p) => (
  <Layout title={`${p.path || "/"} · ${p.githubFullName}`}>
    <div class="wrap">
      <div class="hdr">
        <div class="brand">
          <a href="/" style="display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none;">
            <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
            GitFlare
          </a>
        </div>
        <div class="ver mono">v{p.version}</div>
      </div>

      <div style="margin: 24px 0 12px;">
        <Breadcrumbs repoName={p.artifactsRepoName} branch={p.branchName} path={p.path} isBlob={!!p.blob} />
      </div>

      <div class="muted mono" style="font-size: 12px; margin-bottom: 16px;">
        {p.githubFullName} · {p.branchName} · {p.headSha.slice(0, 12)}
      </div>

      {p.entries ? <TreeView repoName={p.artifactsRepoName} basePath={p.path} entries={p.entries} /> : null}
      {p.blob ? <BlobView blob={p.blob} /> : null}
    </div>
  </Layout>
);

const Breadcrumbs: FC<{ repoName: string; branch: string; path: string; isBlob: boolean }> = ({
  repoName,
  path,
  isBlob,
}) => {
  const segments = path.split("/").filter(Boolean);
  const crumbs = [
    { label: repoName, href: `/r/${repoName}/tree/`, isCurrent: segments.length === 0 },
    ...segments.map((seg, i) => {
      const subPath = segments.slice(0, i + 1).join("/");
      const isLast = i === segments.length - 1;
      return {
        label: seg,
        href: isLast && isBlob ? `/r/${repoName}/blob/${subPath}` : `/r/${repoName}/tree/${subPath}`,
        isCurrent: isLast,
      };
    }),
  ];
  return (
    <h1 style="font-size: 18px; margin: 0; font-family: 'JetBrains Mono', ui-monospace, monospace; font-weight: 500;">
      {crumbs.map((c, i) => (
        <>
          {i > 0 ? <span class="muted"> / </span> : null}
          {c.isCurrent ? (
            <span>{c.label}</span>
          ) : (
            <a href={c.href}>{c.label}</a>
          )}
        </>
      ))}
    </h1>
  );
};

const TreeView: FC<{ repoName: string; basePath: string; entries: TreeEntry[] }> = ({
  repoName,
  basePath,
  entries,
}) => (
  <div class="card" style="padding: 0; overflow: hidden;">
    <table class="refs" style="margin: 0;">
      <thead>
        <tr>
          <th style="width: 60px;">Type</th>
          <th>Name</th>
          <th style="text-align: right; width: 100px;">Size</th>
        </tr>
      </thead>
      <tbody>
        {basePath ? (
          <tr>
            <td class="mono muted">..</td>
            <td>
              <a class="mono" href={`/r/${repoName}/tree/${parentPath(basePath)}`}>../</a>
            </td>
            <td></td>
          </tr>
        ) : null}
        {entries.map((e) => {
          const fullPath = basePath ? `${basePath}/${e.path}` : e.path;
          const href = e.type === "tree" ? `/r/${repoName}/tree/${fullPath}` : `/r/${repoName}/blob/${fullPath}`;
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
);

const BlobView: FC<{ blob: BlobAtPath }> = ({ blob }) => (
  <div class="card">
    <div class="muted mono" style="font-size: 12px; margin-bottom: 12px;">
      {formatBytes(blob.size)}{blob.isBinary ? " · binary" : ""}
    </div>
    {blob.isBinary ? (
      <div class="empty">Binary file — preview not shown.</div>
    ) : (
      <pre style="margin: 0; padding: 12px; background: var(--bg); border-radius: 6px; border: 1px solid var(--border); overflow-x: auto; max-height: 70vh;"><code class="mono">{blob.text ?? ""}</code></pre>
    )}
  </div>
);

function parentPath(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? "" : p.slice(0, i);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
