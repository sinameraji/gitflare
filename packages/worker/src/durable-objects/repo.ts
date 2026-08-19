import type { Env } from "../env";
import { syncGithubToArtifacts } from "../sync/git-sync";
import {
  applyReverseResult,
  isDue,
  syncArtifactsToGithub,
  type ReverseState,
} from "../sync/reverse-sync";
import { classifyRef, isOwnPush } from "../events/artifacts";
import { listArtifactsRefs } from "../artifacts/refs";
import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";

export interface RefState {
  ref: string;
  sha: string;
  syncedAt: number;
  /** Where the sha came from: a GitHub webhook (forward sync) or a push to the mirror. */
  source?: "github" | "artifacts" | undefined;
  /** Last forward-sync failure for this ref, cleared on the next success. */
  forwardError?: string | undefined;
}

interface OutboundMarker {
  sha: string;
  startedAt: number;
}

interface SyncRequest {
  githubFullName: string;
  artifactsRepoName: string;
  remote: string;
  ref: string;
  beforeSha: string;
  afterSha: string;
}

export interface SyncResponse {
  ok: boolean;
  /** false when the caller should NOT dispatch CI/CD (already mirrored, or failed). */
  dispatch: boolean;
  skipped?: string | undefined;
  error?: string | undefined;
}

interface ArtifactsPushRequest {
  githubFullName: string;
  artifactsRepoName: string;
  remote: string;
  ref: string;
  before: string;
  after: string;
}

export interface ArtifactsPushResponse {
  own: boolean;
  dispatch: boolean;
  reason: string;
}

interface ReverseNowRequest {
  githubFullName: string;
  artifactsRepoName: string;
  remote: string;
  ref?: string | undefined;
  reconcile?: boolean | undefined;
}

/**
 * Per-repo Durable Object.
 *
 * Forward: holds the last-synced SHA per ref and serializes GitHub→Artifacts
 * syncs so concurrent webhooks for the same repo don't race.
 *
 * Reverse (M9): records pushes made directly to the mirror and pushes them
 * back to GitHub (fast-forward only) from an alarm with exponential backoff,
 * so a push made while GitHub was down reaches GitHub when it's back.
 *
 * Storage keys:
 *   ref:<ref>       RefState        — last known mirror sha per ref
 *   outbound:<ref>  OutboundMarker  — "we are pushing this sha to the mirror
 *                                     right now" (loop guard for our own events)
 *   reverse:<ref>   ReverseState    — pending/synced/… state per ref
 */
export class RepoDO {
  private state: DurableObjectState;
  private env: Env;
  private inFlight: Promise<unknown> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/sync") {
      const body = (await request.json()) as SyncRequest;
      return this.handleSync(body);
    }
    if (request.method === "POST" && url.pathname === "/artifacts-push") {
      const body = (await request.json()) as ArtifactsPushRequest;
      return Response.json(await this.handleArtifactsPush(body));
    }
    if (request.method === "POST" && url.pathname === "/reverse/now") {
      const body = (await request.json()) as ReverseNowRequest;
      return Response.json(await this.handleReverseNow(body));
    }
    if (request.method === "GET" && url.pathname === "/state") {
      const [refs, reverse] = await Promise.all([this.allRefs(), this.allReverse()]);
      return Response.json({ refs, reverse });
    }
    return new Response("not found", { status: 404 });
  }

  /** Run `fn` after whatever is in flight; the chain never rejects. */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const prior = this.inFlight ?? Promise.resolve();
    const run = prior.then(fn);
    this.inFlight = run.catch(() => undefined);
    return run;
  }

  // -- forward: GitHub → Artifacts --------------------------------------------

  private async handleSync(req: SyncRequest): Promise<Response> {
    try {
      const result = await this.serialize(() => this.runSync(req));
      return Response.json(result);
    } catch (err) {
      const body: SyncResponse = { ok: false, dispatch: false, error: (err as Error).message };
      return Response.json(body, { status: 500 });
    }
  }

  private async runSync(req: SyncRequest): Promise<SyncResponse> {
    const key = `ref:${req.ref}`;
    const existing = await this.state.storage.get<RefState>(key);

    // Already mirrored at this sha — typically the webhook echo of our own
    // reverse push (Artifacts → GitHub → webhook → here). Nothing to sync and
    // nothing to dispatch: the pipeline already ran when the mirror got it.
    if (existing?.sha === req.afterSha) {
      // If a reverse entry was waiting for exactly this sha to reach GitHub,
      // the webhook proves it has — close it out without a network round trip.
      const rev = await this.state.storage.get<ReverseState>(`reverse:${req.ref}`);
      if (rev && rev.status !== "synced" && rev.sha === req.afterSha) {
        await this.state.storage.put<ReverseState>(`reverse:${req.ref}`, {
          ...rev,
          status: "synced",
          syncedAt: Date.now(),
          githubSha: req.afterSha,
          lastError: undefined,
          nextAttemptAt: undefined,
        });
      }
      return { ok: true, dispatch: false, skipped: "already-mirrored" };
    }

    // Loop guard: mark what we're about to push BEFORE pushing, so the
    // Artifacts `pushed` event this push emits can never arrive without it.
    await this.state.storage.put<OutboundMarker>(`outbound:${req.ref}`, {
      sha: req.afterSha,
      startedAt: Date.now(),
    });
    try {
      const artifactsRepo = await this.env.ARTIFACTS.get(req.artifactsRepoName);
      await syncGithubToArtifacts({
        githubFullName: req.githubFullName,
        githubToken: this.env.GITHUB_TOKEN,
        ref: req.ref,
        artifactsRepo,
        remote: req.remote,
        beforeSha: req.beforeSha,
        afterSha: req.afterSha,
      });
      await this.state.storage.put<RefState>(key, {
        ref: req.ref,
        sha: req.afterSha,
        syncedAt: Date.now(),
        source: "github",
      });
      return { ok: true, dispatch: true };
    } catch (err) {
      // Keep the last good sha; surface the failure on the ref row.
      if (existing) {
        await this.state.storage.put<RefState>(key, { ...existing, forwardError: (err as Error).message });
      } else {
        await this.state.storage.put<RefState>(key, {
          ref: req.ref,
          sha: "",
          syncedAt: 0,
          forwardError: (err as Error).message,
        });
      }
      throw err;
    } finally {
      await this.state.storage.delete(`outbound:${req.ref}`);
    }
  }

  // -- reverse: Artifacts → GitHub --------------------------------------------

  /** A `pushed` event arrived from the mirror. Classify and record it. */
  private async handleArtifactsPush(req: ArtifactsPushRequest): Promise<ArtifactsPushResponse> {
    const cls = classifyRef(req.ref, req.before, req.after);
    if (cls.isNoop) return { own: true, dispatch: false, reason: "no-op push (before == after)" };
    if (cls.kind !== "branch") return { own: false, dispatch: false, reason: `${cls.kind} refs are not synced yet` };
    if (cls.isDelete) {
      // Deletes are never propagated in either direction; just forget the ref.
      await Promise.all([
        this.state.storage.delete(`ref:${req.ref}`),
        this.state.storage.delete(`reverse:${req.ref}`),
        this.state.storage.delete(`outbound:${req.ref}`),
      ]);
      return { own: false, dispatch: false, reason: "branch deleted on the mirror (not propagated)" };
    }

    const now = Date.now();
    const [outbound, refState] = await Promise.all([
      this.state.storage.get<OutboundMarker>(`outbound:${req.ref}`),
      this.state.storage.get<RefState>(`ref:${req.ref}`),
    ]);
    if (isOwnPush({ after: req.after, outbound, refSha: refState?.sha, now })) {
      return { own: true, dispatch: false, reason: "own push (forward sync) or duplicate delivery" };
    }

    // External push to the mirror: record it, queue the reverse sync, dispatch.
    await this.state.storage.put<RefState>(`ref:${req.ref}`, {
      ref: req.ref,
      sha: req.after,
      syncedAt: now,
      source: "artifacts",
    });
    await this.state.storage.put<ReverseState>(`reverse:${req.ref}`, {
      ref: req.ref,
      sha: req.after,
      status: "pending",
      attempts: 0,
      createdAt: now,
      nextAttemptAt: now,
    });
    if (this.env.SYNC_ENABLED === "1") await this.armAlarm(now);
    return { own: false, dispatch: true, reason: "external push to the mirror" };
  }

  /** `gitflare sync now`: re-queue failed/pending refs (optionally reconcile all branches). */
  private async handleReverseNow(req: ReverseNowRequest): Promise<{ queued: string[] }> {
    const now = Date.now();
    const queued: string[] = [];
    const existing = await this.allReverse();

    if (req.reconcile) {
      // Every mirror branch whose tip differs from GitHub's gets an entry.
      const [mirrorRefs, githubRefs] = await Promise.all([
        listArtifactsRefs(await this.env.ARTIFACTS.get(req.artifactsRepoName), req.remote),
        git.listServerRefs({
          http,
          url: `https://github.com/${req.githubFullName}.git`,
          prefix: "refs/heads/",
          onAuth: () => ({ username: "x-access-token", password: this.env.GITHUB_TOKEN }),
        }),
      ]);
      const gh = new Map(githubRefs.map((r) => [r.ref, r.oid]));
      for (const m of mirrorRefs) {
        if (!m.ref.startsWith("refs/heads/")) continue;
        if (req.ref && m.ref !== req.ref) continue;
        if (gh.get(m.ref) === m.sha) continue;
        const prev = existing.find((e) => e.ref === m.ref);
        await this.state.storage.put<ReverseState>(`reverse:${m.ref}`, {
          ref: m.ref,
          sha: m.sha,
          status: "pending",
          attempts: 0,
          createdAt: prev?.createdAt ?? now,
          manual: true,
          nextAttemptAt: now,
          githubSha: gh.get(m.ref),
        });
        queued.push(m.ref);
      }
    }

    for (const e of existing) {
      if (req.ref && e.ref !== req.ref) continue;
      if (e.status === "synced" || queued.includes(e.ref)) continue;
      await this.state.storage.put<ReverseState>(`reverse:${e.ref}`, {
        ...e,
        status: "pending",
        attempts: 0,
        manual: true,
        nextAttemptAt: now,
        lastError: undefined,
      });
      queued.push(e.ref);
    }
    if (queued.length) await this.armAlarm(now);
    return { queued };
  }

  async alarm(): Promise<void> {
    await this.serialize(() => this.runDueReverseSyncs());
  }

  private async runDueReverseSyncs(): Promise<void> {
    const now = Date.now();
    const entries = await this.allReverse();
    const enabled = this.env.SYNC_ENABLED === "1";
    const repoInfo = this.repoInfo();
    for (const entry of entries) {
      if (!isDue(entry, now)) continue;
      // Reverse pushes are opt-in (`gitflare sync enable`); explicit `sync now`
      // requests run regardless — the user asked for exactly this.
      if (!enabled && !entry.manual) continue;
      if (!repoInfo) {
        await this.state.storage.put<ReverseState>(`reverse:${entry.ref}`, {
          ...entry,
          status: "error",
          lastError: "this repo is not in REPO_MAP",
          nextAttemptAt: undefined,
        });
        continue;
      }
      let next: ReverseState;
      try {
        const artifactsRepo = await this.env.ARTIFACTS.get(repoInfo.artifactsRepoName);
        const result = await syncArtifactsToGithub({
          githubFullName: repoInfo.githubFullName,
          githubToken: this.env.GITHUB_TOKEN,
          ref: entry.ref,
          artifactsRepo,
          remote: repoInfo.remote,
        });
        next = applyReverseResult(entry, result, Date.now());
      } catch (err) {
        next = applyReverseResult(entry, { status: "error", detail: (err as Error).message, githubSha: null, mirrorSha: null }, Date.now());
      }
      await this.state.storage.put<ReverseState>(`reverse:${entry.ref}`, next);
    }
    await this.rearm();
  }

  /** Arm the alarm for `at` unless one is already set earlier. */
  private async armAlarm(at: number): Promise<void> {
    const current = await this.state.storage.getAlarm();
    if (current === null || current > at) await this.state.storage.setAlarm(at);
  }

  /**
   * After a pass: alarm at the earliest retry we would actually run, or none.
   * Entries the pass would skip (sync disabled + not manual) must NOT re-arm,
   * or a disabled Worker with leftover entries would spin on its alarm.
   */
  private async rearm(): Promise<void> {
    const entries = await this.allReverse();
    const enabled = this.env.SYNC_ENABLED === "1";
    let min: number | null = null;
    for (const e of entries) {
      if (e.status === "synced" || e.status === "conflict" || e.status === "rejected" || e.status === "stalled") continue;
      if (!enabled && !e.manual) continue;
      if (e.nextAttemptAt === undefined) continue;
      if (min === null || e.nextAttemptAt < min) min = e.nextAttemptAt;
    }
    if (min !== null) await this.state.storage.setAlarm(Math.max(min, Date.now() + 1000));
  }

  /** This DO is named by the Artifacts repo name; find its REPO_MAP entry. */
  private repoInfo(): { githubFullName: string; artifactsRepoName: string; remote: string } | null {
    let map: Record<string, { name: string; remote: string }> = {};
    try {
      map = JSON.parse(this.env.REPO_MAP) as Record<string, { name: string; remote: string }>;
    } catch {
      return null;
    }
    const mine = this.state.id.name;
    for (const [githubFullName, entry] of Object.entries(map)) {
      if (entry.name === mine) return { githubFullName, artifactsRepoName: entry.name, remote: entry.remote };
    }
    return null;
  }

  private async allRefs(): Promise<RefState[]> {
    const map = await this.state.storage.list<RefState>({ prefix: "ref:" });
    return [...map.values()];
  }

  private async allReverse(): Promise<ReverseState[]> {
    const map = await this.state.storage.list<ReverseState>({ prefix: "reverse:" });
    return [...map.values()];
  }
}

export function repoStubFor(env: Env, artifactsRepoName: string): DurableObjectStub {
  const id = env.REPO.idFromName(artifactsRepoName);
  return env.REPO.get(id);
}
