import type { FC } from "hono/jsx";
import { raw } from "hono/html";
import { Layout } from "./layout";
import { LOGO_PNG_DATA_URL } from "./logo-data";
import { formatAgo } from "./commits";
import { highlightCode, splitHighlightedLines } from "./highlight";
import { splitLines, toHunks, type BlameResult } from "../blame/algorithm";
import type { FileHistory, TruncatedReason } from "../blame/history";

export interface BlameProps {
  githubFullName: string;
  artifactsRepoName: string;
  branch: string;
  headSha: string;
  path: string;
  /** Text of the file at headSha (only for kind "ok"). */
  text?: string;
  result?: BlameResult;
  /** Non-ok outcome of the history walk: binary / too-large. */
  unavailable?: Exclude<FileHistory["kind"], "ok" | "missing" | "directory">;
  size?: number;
  limits: { maxCommits: number; maxBytes: number; maxLines: number; maxDepth: number };
  commitsWalked?: number;
  truncated?: TruncatedReason | null;
}

const css = `
.blame { width: 100%; border-collapse: collapse; font-size: 12px; table-layout: fixed; }
.blame td { padding: 0 8px; vertical-align: top; line-height: 1.6; }
.blame tr.hs td { border-top: 1px solid var(--border); }
.blame td.bm { width: 290px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; padding-top: 2px; }
.blame td.bm .sha { margin-right: 6px; }
.blame td.bm .subj { color: var(--fg); }
.blame td.ln { width: 52px; text-align: right; color: var(--muted); user-select: none; }
.blame td.cd { white-space: pre; overflow-x: auto; }
.blame td.cd code { font-size: 12px; }
.blame .age { float: right; margin-left: 8px; }
`;

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function blameHref(repoName: string, ref: string, path: string, depth?: number): string {
  const base = `/r/${repoName}/blame/${encodeURIComponent(ref)}/${path.split("/").map(encodeURIComponent).join("/")}`;
  return depth ? `${base}?depth=${depth}` : base;
}

export const BlameView: FC<BlameProps> = (p) => {
  const commitUrl = (sha: string) => `https://github.com/${p.githubFullName}/commit/${sha}`;
  const lines = p.text !== undefined ? splitLines(p.text) : [];
  const hl = p.text !== undefined ? highlightCode(p.text, p.path) : null;
  const htmlLines = hl ? splitHighlightedLines(hl.html) : null;
  const hunks = p.result ? toHunks(p.result.lines) : [];
  const deeper = Math.min(p.limits.maxDepth, p.limits.maxCommits * 3);

  return (
    <Layout title={`Blame ${p.path} · ${p.githubFullName}`}>
      <style dangerouslySetInnerHTML={{ __html: css }} />
      <div class="wrap" style="max-width: 1200px;">
        <div class="hdr">
          <div class="brand">
            <a href="/" style="display: flex; align-items: center; gap: 10px; color: var(--fg); text-decoration: none;">
              <img class="logo" src={LOGO_PNG_DATA_URL} alt="GitFlare" />
              GitFlare
            </a>
          </div>
        </div>

        <h1 class="mono" style="font-size: 18px; font-weight: 500;">
          <span class="muted">blame </span>
          {p.path}
        </h1>
        <p class="muted mono" style="font-size: 12px; margin-bottom: 12px;">
          {p.githubFullName} · {p.branch} · {p.headSha.slice(0, 12)} ·{" "}
          <a href={`/r/${p.artifactsRepoName}/blob/${p.path}`}>view file</a> ·{" "}
          <a href={`/r/${p.artifactsRepoName}/commits?ref=${encodeURIComponent(p.branch)}`}>commits</a> ·{" "}
          <a href={`https://github.com/${p.githubFullName}/blame/${encodeURIComponent(p.branch)}/${p.path}`}>on GitHub ↗</a>
        </p>

        {p.unavailable === "binary" ? (
          <div class="empty">Binary file{p.size !== undefined ? ` (${fmtBytes(p.size)})` : ""} — no line blame.</div>
        ) : p.unavailable === "too-large" ? (
          <div class="empty">
            File too large to blame here{p.size !== undefined ? ` (${fmtBytes(p.size)})` : ""} — the mirror blames files up to{" "}
            {fmtBytes(p.limits.maxBytes)} / {p.limits.maxLines.toLocaleString("en")} lines.
          </div>
        ) : p.result ? (
          <>
            {p.truncated ? (
              <div class="banner" data-testid="blame-truncated">
                {p.truncated.kind === "depth" ? (
                  <>
                    Blame truncated at {p.truncated.commits} commits: lines marked <span class="mono">^</span> are at
                    least as old as that commit; their true origin is further back.
                    {p.limits.maxCommits < p.limits.maxDepth ? (
                      <>
                        {" "}
                        <a href={blameHref(p.artifactsRepoName, p.branch, p.path, deeper)}>Look back {deeper} commits</a>.
                      </>
                    ) : null}
                  </>
                ) : (
                  <>
                    Blame stopped at {p.truncated.sha.slice(0, 8)} after {p.truncated.commits} commits: an older version is
                    over the {fmtBytes(p.limits.maxBytes)} / {p.limits.maxLines.toLocaleString("en")}-line cap. Lines
                    marked <span class="mono">^</span> date from that point or earlier.
                  </>
                )}
              </div>
            ) : null}
            <div class="muted" style="font-size: 12px; margin-bottom: 8px;">
              {lines.length} lines · {p.result.commits.length} commits · walked {p.commitsWalked ?? 0} of up to{" "}
              {p.limits.maxCommits} (first-parent)
              {hl ? ` · ${hl.lang}` : ""}
            </div>
            {lines.length === 0 ? (
              <div class="empty">Empty file.</div>
            ) : (
              <div class="card" style="padding: 0; overflow-x: auto;">
                <table class="blame mono">
                  <tbody>
                    {hunks.flatMap((h) => {
                      const c = p.result!.commits[h.commit]!;
                      const rows = [];
                      for (let k = h.start; k < h.start + h.length; k++) {
                        const first = k === h.start;
                        rows.push(
                          <tr class={first ? "hs" : undefined}>
                            <td class="bm">
                              {first ? (
                                <>
                                  <a class="sha" href={commitUrl(c.sha)} title={c.sha}>
                                    {h.boundary ? "^" : ""}
                                    {c.sha.slice(0, 7)}
                                  </a>
                                  <span class="age" title={new Date(c.timestamp).toISOString()}>
                                    {formatAgo(c.timestamp)}
                                  </span>
                                  <span title={c.authorEmail}>{c.authorName}</span>{" "}
                                  <a class="subj" href={commitUrl(c.sha)} title={c.subject}>
                                    {c.subject}
                                  </a>
                                </>
                              ) : null}
                            </td>
                            <td class="ln" id={`L${k + 1}`}>
                              {k + 1}
                            </td>
                            <td class="cd">
                              <code class="hljs">{htmlLines ? raw(htmlLines[k] ?? "") : lines[k]}</code>
                            </td>
                          </tr>,
                        );
                      }
                      return rows;
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Layout>
  );
};
