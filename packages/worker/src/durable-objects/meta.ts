import type { Env } from "../env";
import {
  commentFromGithub,
  commentKey,
  issueFromGithub,
  issueKey,
  pullFromGithub,
  pullKey,
  releaseFromGithub,
  releaseKey,
  reviewFromGithub,
  type CommentRecord,
  type IssueRecord,
  type PullRecord,
  type ReleaseRecord,
} from "../meta/map";

// Read-only metadata mirror (Stage 1 scope, PLAN §4): issues, pull requests,
// their comments/reviews, and releases — fed by the webhook events GitFlare
// already subscribes to, backfilled once from the GitHub API. Nothing here
// writes to GitHub; every page links out for actions.

export interface MetaState {
  backfill?: {
    status: "running" | "done" | "failed";
    startedAt: number;
    /** which collection is in progress (for the UI / tail) */
    phase?: string | undefined;
    githubFullName?: string | undefined;
    finishedAt?: number | undefined;
    issues?: number | undefined;
    pulls?: number | undefined;
    comments?: number | undefined;
    releases?: number | undefined;
    error?: string | undefined;
    /** true when a page cap was hit (very large repos) */
    truncated?: boolean | undefined;
  } | undefined;
  lastEventAt?: number | undefined;
}

interface EventRequest {
  event: string; // github event name
  action?: string | undefined;
  payload: unknown; // the raw webhook payload (already HMAC-verified by the caller)
}

interface BackfillRequest {
  githubFullName: string;
  /** Force a re-run even if one completed. */
  force?: boolean | undefined;
}

const PAGE_CAP = 30; // × 100 items per collection — 3 000 issues/PRs/comments/releases before we stop
const STALE_RUNNING_MS = 30 * 60_000;

export class MetaDO {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const seg = url.pathname.split("/").filter(Boolean);
    try {
      if (request.method === "POST" && url.pathname === "/event") {
        const body = (await request.json()) as EventRequest;
        return Response.json(await this.handleEvent(body));
      }
      if (request.method === "POST" && url.pathname === "/backfill") {
        const body = (await request.json()) as BackfillRequest;
        const meta = await this.meta();
        // "running" is trusted only for alarm-driven runs (they carry a phase) and only for 30 min.
        const running =
          meta.backfill?.status === "running" && meta.backfill.phase !== undefined && Date.now() - meta.backfill.startedAt < STALE_RUNNING_MS;
        if (running) return Response.json({ accepted: false, reason: "already running" }, { status: 202 });
        if (meta.backfill?.status === "done" && !body.force) return Response.json({ accepted: false, reason: "already backfilled" });
        // The alarm drives the work: alarms are guaranteed to run and keep the DO
        // alive, unlike a promise detached from a request (which stalled live).
        await this.putMeta({ ...meta, backfill: { status: "running", startedAt: Date.now(), phase: "queued", githubFullName: body.githubFullName } });
        await this.state.storage.setAlarm(Date.now() + 50);
        return Response.json({ accepted: true }, { status: 202 });
      }
      if (request.method === "GET" && url.pathname === "/meta") {
        return Response.json(await this.meta());
      }
      if (request.method === "GET" && url.pathname === "/counts") {
        const [issues, pulls, releases, meta] = await Promise.all([
          this.listAll<IssueRecord>("issue:"),
          this.listAll<PullRecord>("pull:"),
          this.listAll<ReleaseRecord>("release:"),
          this.meta(),
        ]);
        return Response.json({
          openIssues: issues.filter((i) => i.state === "open").length,
          issues: issues.length,
          openPulls: pulls.filter((p) => p.state === "open").length,
          pulls: pulls.length,
          releases: releases.length,
          backfill: meta.backfill ?? null,
        });
      }
      if (request.method === "GET" && seg[0] === "issues" && seg.length === 1) {
        return Response.json({ items: await this.listAll<IssueRecord>("issue:") });
      }
      if (request.method === "GET" && seg[0] === "pulls" && seg.length === 1) {
        return Response.json({ items: await this.listAll<PullRecord>("pull:") });
      }
      if (request.method === "GET" && seg[0] === "releases" && seg.length === 1) {
        return Response.json({ items: (await this.listAll<ReleaseRecord>("release:")).reverse() });
      }
      if (request.method === "GET" && (seg[0] === "issues" || seg[0] === "pulls") && seg.length === 2) {
        const n = Number(seg[1]);
        if (!Number.isInteger(n)) return new Response("bad number", { status: 400 });
        const item = await this.state.storage.get<IssueRecord | PullRecord>(seg[0] === "pulls" ? pullKey(n) : issueKey(n));
        if (!item) return Response.json({ item: null, comments: [] }, { status: 404 });
        const comments = await this.listAll<CommentRecord>(`comment:${String(n).padStart(8, "0")}:`);
        return Response.json({ item, comments });
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      return Response.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  // -- webhook events ---------------------------------------------------------

  private async handleEvent(req: EventRequest): Promise<{ stored: string | null }> {
    const p = (req.payload ?? {}) as Record<string, unknown>;
    let stored: string | null = null;
    switch (req.event) {
      case "issues": {
        const rec = issueFromGithub(p.issue);
        if (rec) {
          if (req.action === "deleted" || req.action === "transferred") await this.state.storage.delete(issueKey(rec.number));
          else await this.state.storage.put(issueKey(rec.number), rec);
          stored = `issue #${rec.number}`;
        }
        break;
      }
      case "pull_request": {
        const rec = pullFromGithub(p.pull_request);
        if (rec) {
          await this.state.storage.put(pullKey(rec.number), rec);
          stored = `pull #${rec.number}`;
        }
        break;
      }
      case "issue_comment": {
        const issue = (p.issue ?? {}) as Record<string, unknown>;
        const n = typeof issue.number === "number" ? issue.number : undefined;
        const rec = commentFromGithub(p.comment, n);
        if (rec) {
          const key = commentKey(rec.issueNumber, rec.createdAt, rec.id);
          if (req.action === "deleted") await this.state.storage.delete(key);
          else await this.state.storage.put(key, rec);
          stored = `comment ${rec.id} on #${rec.issueNumber}`;
          // Keep the parent's comment count + updatedAt fresh (the issue payload rides along).
          const parent = issue.pull_request ? pullFromGithub(issue) : issueFromGithub(issue);
          if (parent) await this.state.storage.put(parent.isPull ? pullKey(parent.number) : issueKey(parent.number), parent);
        }
        break;
      }
      case "pull_request_review": {
        const pr = (p.pull_request ?? {}) as Record<string, unknown>;
        const n = typeof pr.number === "number" ? pr.number : undefined;
        if (n) {
          const rec = reviewFromGithub(p.review, n);
          if (rec) {
            const key = commentKey(n, rec.createdAt, rec.id);
            if (req.action === "dismissed") await this.state.storage.put(key, { ...rec, reviewState: "dismissed" });
            else await this.state.storage.put(key, rec);
            stored = `review ${rec.id} on #${n}`;
          }
        }
        break;
      }
      case "release": {
        const rec = releaseFromGithub(p.release);
        if (rec) {
          const key = releaseKey(rec.createdAt, rec.id);
          if (req.action === "deleted") await this.state.storage.delete(key);
          else await this.state.storage.put(key, rec);
          stored = `release ${rec.tagName}`;
        }
        break;
      }
      default:
        break;
    }
    if (stored) {
      const meta = await this.meta();
      await this.putMeta({ ...meta, lastEventAt: Date.now() });
    }
    return { stored };
  }

  // -- backfill from the GitHub API --------------------------------------------

  async alarm(): Promise<void> {
    const meta = await this.meta();
    const b = meta.backfill;
    if (!b || b.status !== "running" || !b.githubFullName) return;
    if (b.phase && b.phase !== "queued") return; // a previous alarm is (or was) mid-flight; let staleness handle it
    await this.runBackfill(b.githubFullName, b.startedAt);
  }

  private async setPhase(phase: string, extra: Record<string, unknown> = {}): Promise<void> {
    const meta = await this.meta();
    if (!meta.backfill) return;
    await this.putMeta({ ...meta, backfill: { ...meta.backfill, phase, ...extra } });
    console.log(`meta backfill: ${phase}`, JSON.stringify(extra));
  }

  private async runBackfill(githubFullName: string, startedAt = Date.now()): Promise<void> {
    const counts = { issues: 0, pulls: 0, comments: 0, releases: 0 };
    let truncated = false;
    try {
      const gh = this.githubClient();
      await this.setPhase("issues");
      // Issues (includes PRs as issue-shaped items — used for numbering/labels; PRs get their own pass).
      const issues = await gh.paged<Record<string, unknown>>(`/repos/${githubFullName}/issues?state=all&per_page=100&sort=updated&direction=desc`);
      truncated ||= issues.truncated;
      for (const raw of issues.items) {
        const rec = issueFromGithub(raw);
        if (!rec || rec.isPull) continue;
        await this.state.storage.put(issueKey(rec.number), rec);
        counts.issues++;
      }
      await this.setPhase("pulls", { issues: counts.issues });
      const pulls = await gh.paged<Record<string, unknown>>(`/repos/${githubFullName}/pulls?state=all&per_page=100&sort=updated&direction=desc`);
      truncated ||= pulls.truncated;
      for (const raw of pulls.items) {
        const rec = pullFromGithub(raw);
        if (!rec) continue;
        await this.state.storage.put(pullKey(rec.number), rec);
        counts.pulls++;
      }
      await this.setPhase("comments", { pulls: counts.pulls });
      const comments = await gh.paged<Record<string, unknown>>(`/repos/${githubFullName}/issues/comments?per_page=100&sort=created&direction=desc`);
      truncated ||= comments.truncated;
      for (const raw of comments.items) {
        const rec = commentFromGithub(raw);
        if (!rec) continue;
        await this.state.storage.put(commentKey(rec.issueNumber, rec.createdAt, rec.id), rec);
        counts.comments++;
      }
      await this.setPhase("releases", { comments: counts.comments });
      const releases = await gh.paged<Record<string, unknown>>(`/repos/${githubFullName}/releases?per_page=100`);
      truncated ||= releases.truncated;
      for (const raw of releases.items) {
        const rec = releaseFromGithub(raw);
        if (!rec) continue;
        await this.state.storage.put(releaseKey(rec.createdAt, rec.id), rec);
        counts.releases++;
      }
      const meta = await this.meta();
      await this.putMeta({ ...meta, backfill: { status: "done", startedAt, finishedAt: Date.now(), githubFullName, ...counts, truncated } });
      console.log("meta backfill: done", JSON.stringify(counts));
    } catch (err) {
      const meta = await this.meta();
      await this.putMeta({
        ...meta,
        backfill: { status: "failed", startedAt, finishedAt: Date.now(), githubFullName, ...counts, error: (err as Error).message.slice(0, 300) },
      });
      console.error("meta backfill: failed", (err as Error).message);
    }
  }

  private githubClient(): { paged: <T>(path: string) => Promise<{ items: T[]; truncated: boolean }> } {
    const token = this.env.GITHUB_TOKEN;
    return {
      paged: async <T>(path: string) => {
        const items: T[] = [];
        let page = 1;
        for (;;) {
          const sep = path.includes("?") ? "&" : "?";
          const res = await fetch(`https://api.github.com${path}${sep}page=${page}`, {
            signal: AbortSignal.timeout(20_000),
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/vnd.github+json",
              "X-GitHub-Api-Version": "2022-11-28",
              "User-Agent": "gitflare-worker",
            },
          });
          if (!res.ok) throw new Error(`GitHub ${path} page ${page} → ${res.status}: ${(await res.text()).slice(0, 200)}`);
          const batch = (await res.json()) as T[];
          items.push(...batch);
          if (batch.length < 100) return { items, truncated: false };
          page++;
          if (page > PAGE_CAP) return { items, truncated: true };
        }
      },
    };
  }

  // -- storage helpers -----------------------------------------------------------

  private async listAll<T>(prefix: string): Promise<T[]> {
    const out: T[] = [];
    let start: string | undefined;
    for (;;) {
      const map = await this.state.storage.list<T>({ prefix, limit: 1000, ...(start ? { startAfter: start } : {}) });
      if (map.size === 0) return out;
      for (const [k, v] of map) {
        out.push(v);
        start = k;
      }
      if (map.size < 1000) return out;
    }
  }

  private async meta(): Promise<MetaState> {
    return (await this.state.storage.get<MetaState>("meta")) ?? {};
  }
  private async putMeta(m: MetaState): Promise<void> {
    await this.state.storage.put("meta", m);
  }
}

export function metaStubFor(env: Env, artifactsRepoName: string): DurableObjectStub {
  const id = env.META.idFromName(artifactsRepoName);
  return env.META.get(id);
}
