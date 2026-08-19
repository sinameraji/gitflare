// GitHub payload → the trimmed records the metadata mirror stores. Pure so
// the webhook path and the API backfill share one shape and it's testable.
// Bodies are capped (a DO storage value is limited; issue bodies rarely
// approach it, but a 10 MB paste shouldn't take the mirror down).

export const MAX_BODY_CHARS = 64 * 1024;

export interface UserRef {
  login: string;
  avatarUrl?: string | undefined;
}

export interface LabelRef {
  name: string;
  color?: string | undefined;
}

export interface IssueRecord {
  number: number;
  title: string;
  state: "open" | "closed";
  stateReason?: string | undefined; // completed / not_planned / reopened
  user: UserRef;
  labels: LabelRef[];
  body: string;
  bodyTruncated: boolean;
  createdAt: number;
  updatedAt: number;
  closedAt?: number | undefined;
  commentsCount: number;
  htmlUrl: string;
  milestone?: string | undefined;
  /** true when this issue number is actually a pull request (GitHub shares the number space) */
  isPull: boolean;
}

export interface PullRecord extends IssueRecord {
  isPull: true;
  draft: boolean;
  merged: boolean;
  mergedAt?: number | undefined;
  head: { ref: string; sha: string; repo?: string | undefined };
  base: { ref: string; sha?: string | undefined };
  additions?: number | undefined;
  deletions?: number | undefined;
  changedFiles?: number | undefined;
  mergeableState?: string | undefined;
}

export interface CommentRecord {
  id: number;
  issueNumber: number;
  kind: "comment" | "review";
  user: UserRef;
  body: string;
  bodyTruncated: boolean;
  createdAt: number;
  updatedAt: number;
  htmlUrl: string;
  /** reviews only */
  reviewState?: string | undefined; // approved / changes_requested / commented / dismissed
  commitSha?: string | undefined;
}

export interface ReleaseRecord {
  id: number;
  tagName: string;
  name: string;
  body: string;
  bodyTruncated: boolean;
  draft: boolean;
  prerelease: boolean;
  createdAt: number;
  publishedAt?: number | undefined;
  htmlUrl: string;
  author: UserRef;
  assets: Array<{ name: string; size: number; downloadUrl: string }>;
}

type Any = Record<string, unknown>;

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}
function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function ts(v: unknown): number | undefined {
  if (typeof v !== "string" || !v) return undefined;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
}
function user(v: unknown): UserRef {
  const u = (v ?? {}) as Any;
  return { login: str(u.login, "ghost"), avatarUrl: typeof u.avatar_url === "string" ? u.avatar_url : undefined };
}
function body(v: unknown): { body: string; bodyTruncated: boolean } {
  const b = str(v);
  return b.length > MAX_BODY_CHARS ? { body: b.slice(0, MAX_BODY_CHARS), bodyTruncated: true } : { body: b, bodyTruncated: false };
}
function labels(v: unknown): LabelRef[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((l) => (typeof l === "string" ? { name: l } : l && typeof l === "object" ? { name: str((l as Any).name), color: typeof (l as Any).color === "string" ? ((l as Any).color as string) : undefined } : null))
    .filter((l): l is LabelRef => !!l && !!l.name);
}

/** From an `issues` webhook payload's `issue`, or a `GET /repos/:o/:r/issues` item. */
export function issueFromGithub(raw: unknown): IssueRecord | null {
  const i = raw as Any;
  const number = num(i?.number);
  if (!number) return null;
  const b = body(i.body);
  return {
    number,
    title: str(i.title),
    state: i.state === "closed" ? "closed" : "open",
    stateReason: typeof i.state_reason === "string" ? i.state_reason : undefined,
    user: user(i.user),
    labels: labels(i.labels),
    body: b.body,
    bodyTruncated: b.bodyTruncated,
    createdAt: ts(i.created_at) ?? 0,
    updatedAt: ts(i.updated_at) ?? ts(i.created_at) ?? 0,
    closedAt: ts(i.closed_at),
    commentsCount: num(i.comments) ?? 0,
    htmlUrl: str(i.html_url),
    milestone: (i.milestone as Any | null)?.title as string | undefined,
    isPull: !!i.pull_request,
  };
}

/** From a `pull_request` webhook payload's `pull_request`, or a `GET /pulls` item. */
export function pullFromGithub(raw: unknown): PullRecord | null {
  const p = raw as Any;
  const base = issueFromGithub(raw);
  if (!base) return null;
  const head = (p.head ?? {}) as Any;
  const baseRef = (p.base ?? {}) as Any;
  const mergedAt = ts(p.merged_at);
  return {
    ...base,
    isPull: true,
    // GET /pulls items and webhook payloads carry `merged`; the /issues listing does not.
    merged: p.merged === true || !!mergedAt,
    mergedAt,
    draft: p.draft === true,
    head: { ref: str(head.ref), sha: str(head.sha), repo: ((head.repo as Any | null)?.full_name as string | undefined) ?? undefined },
    base: { ref: str(baseRef.ref), sha: typeof baseRef.sha === "string" ? baseRef.sha : undefined },
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changed_files),
    mergeableState: typeof p.mergeable_state === "string" ? p.mergeable_state : undefined,
    // PR "comments" on the issue timeline + review comments are separate on GitHub; keep the issue count.
    commentsCount: num(p.comments) ?? base.commentsCount,
  };
}

/** From an `issue_comment` payload's `comment` (+ the issue number), or `GET /issues/comments` items. */
export function commentFromGithub(raw: unknown, issueNumber?: number): CommentRecord | null {
  const c = raw as Any;
  const id = num(c?.id);
  if (!id) return null;
  const n = issueNumber ?? numberFromIssueUrl(str(c.issue_url));
  if (!n) return null;
  const b = body(c.body);
  return {
    id,
    issueNumber: n,
    kind: "comment",
    user: user(c.user),
    body: b.body,
    bodyTruncated: b.bodyTruncated,
    createdAt: ts(c.created_at) ?? 0,
    updatedAt: ts(c.updated_at) ?? ts(c.created_at) ?? 0,
    htmlUrl: str(c.html_url),
  };
}

/** From a `pull_request_review` payload's `review` (+ the PR number). Reviews without a body still record the verdict. */
export function reviewFromGithub(raw: unknown, pullNumber: number): CommentRecord | null {
  const r = raw as Any;
  const id = num(r?.id);
  if (!id) return null;
  const b = body(r.body);
  return {
    id,
    issueNumber: pullNumber,
    kind: "review",
    user: user(r.user),
    body: b.body,
    bodyTruncated: b.bodyTruncated,
    createdAt: ts(r.submitted_at) ?? 0,
    updatedAt: ts(r.submitted_at) ?? 0,
    htmlUrl: str(r.html_url),
    reviewState: typeof r.state === "string" ? r.state.toLowerCase() : undefined,
    commitSha: typeof r.commit_id === "string" ? r.commit_id : undefined,
  };
}

/** From a `release` payload's `release`, or `GET /releases` items. */
export function releaseFromGithub(raw: unknown): ReleaseRecord | null {
  const r = raw as Any;
  const id = num(r?.id);
  if (!id) return null;
  const b = body(r.body);
  const assets = Array.isArray(r.assets)
    ? (r.assets as Any[]).map((a) => ({ name: str(a.name), size: num(a.size) ?? 0, downloadUrl: str(a.browser_download_url) })).filter((a) => a.name)
    : [];
  return {
    id,
    tagName: str(r.tag_name),
    name: str(r.name) || str(r.tag_name),
    body: b.body,
    bodyTruncated: b.bodyTruncated,
    draft: r.draft === true,
    prerelease: r.prerelease === true,
    createdAt: ts(r.created_at) ?? 0,
    publishedAt: ts(r.published_at),
    htmlUrl: str(r.html_url),
    author: user(r.author),
    assets,
  };
}

export function numberFromIssueUrl(url: string): number | undefined {
  const m = /\/issues\/(\d+)$/.exec(url) ?? /\/pulls\/(\d+)$/.exec(url);
  return m ? Number(m[1]) : undefined;
}

/** Storage keys: zero-padded so prefix listing yields numeric order. */
export function issueKey(n: number): string {
  return `issue:${String(n).padStart(8, "0")}`;
}
export function pullKey(n: number): string {
  return `pull:${String(n).padStart(8, "0")}`;
}
export function commentKey(issueNumber: number, createdAt: number, id: number): string {
  return `comment:${String(issueNumber).padStart(8, "0")}:${String(createdAt).padStart(15, "0")}:${id}`;
}
export function releaseKey(createdAt: number, id: number): string {
  // Newest first when listed with reverse:true.
  return `release:${String(createdAt).padStart(15, "0")}:${id}`;
}

/**
 * Turn `#123` / `owner/repo#123` mentions into links to the mirror's own pages
 * (issue or PR — the caller passes which numbers are PRs), leaving fenced and
 * inline code untouched. Applied to markdown BEFORE rendering.
 */
export function linkifyReferences(md: string, base: string, isPull: (n: number) => boolean): string {
  const parts = md.split(/(```[\s\S]*?```|`[^`\n]*`)/g);
  return parts
    .map((part, i) => {
      if (i % 2 === 1) return part; // code
      return part.replace(/(^|[\s(])#(\d+)\b/g, (_m, pre: string, n: string) => {
        const num = Number(n);
        return `${pre}[#${n}](${base}/${isPull(num) ? "pulls" : "issues"}/${n})`;
      });
    })
    .join("");
}
