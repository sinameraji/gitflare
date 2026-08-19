import * as git from "isomorphic-git";
import http from "isomorphic-git/http/web";
import { cloneBranchReaching, mintReadPassword } from "../artifacts/content";
import type { ArtifactsRepo } from "../types";

// Reverse sync: Artifacts (the mirror) → GitHub. This is the second half of the
// mirror-forever invariant (PLAN.md §5): a ref pushed to the mirror while
// GitHub was down is pushed back to GitHub once GitHub is reachable again.
//
// Rules, in priority order:
//   1. Never force. Never delete. Fast-forward or nothing.
//   2. Idempotent: look at both tips first; equal → nothing to do.
//   3. Push the mirror's CURRENT tip, not whatever sha the triggering event
//      carried — out-of-order or duplicate deliveries then converge.

export type ReverseStatus =
  | "noop" // GitHub already has it, or the ref is gone from the mirror
  | "synced" // pushed
  | "conflict" // GitHub's tip is not an ancestor of the mirror's tip
  | "rejected" // GitHub refused (protected branch, permissions) — retry won't help
  | "auth" // 401/403 — token problem; retry after the user fixes it
  | "error"; // network / transient — retry with backoff

export interface ReverseSyncParams {
  githubFullName: string;
  githubToken: string;
  ref: string; // "refs/heads/<branch>"
  artifactsRepo: ArtifactsRepo;
  remote: string; // the Artifacts clone URL, from REPO_MAP
}

export interface ReverseSyncResult {
  status: ReverseStatus;
  githubSha: string | null;
  mirrorSha: string | null;
  detail?: string | undefined;
  durationMs: number;
}

export async function syncArtifactsToGithub(p: ReverseSyncParams): Promise<ReverseSyncResult> {
  const start = Date.now();
  const done = (
    status: ReverseStatus,
    githubSha: string | null,
    mirrorSha: string | null,
    detail?: string,
  ): ReverseSyncResult => ({ status, githubSha, mirrorSha, detail, durationMs: Date.now() - start });

  const githubUrl = `https://github.com/${p.githubFullName}.git`;
  const githubAuth = (): { username: string; password: string } => ({
    username: "x-access-token",
    password: p.githubToken,
  });
  const branch = p.ref.replace(/^refs\/heads\//, "");

  // 1. GitHub's tip for this ref (also proves GitHub is reachable + auth works).
  let githubSha: string | null;
  try {
    const refs = await git.listServerRefs({ http, url: githubUrl, prefix: p.ref, onAuth: githubAuth });
    githubSha = refs.find((r) => r.ref === p.ref)?.oid ?? null;
  } catch (err) {
    const c = classifyPushError(err);
    return done(c.status === "conflict" || c.status === "rejected" ? "error" : c.status, null, null, c.detail);
  }

  // 2. The mirror's tip.
  let mirrorSha: string | null;
  try {
    const password = await mintReadPassword(p.artifactsRepo, 120);
    const refs = await git.listServerRefs({
      http,
      url: p.remote,
      prefix: p.ref,
      onAuth: () => ({ username: "x", password }),
    });
    mirrorSha = refs.find((r) => r.ref === p.ref)?.oid ?? null;
  } catch (err) {
    return done("error", githubSha, null, `mirror refs: ${(err as Error).message}`);
  }

  const decision = decideReverse({ githubSha, mirrorSha });
  if (decision === "noop-missing") return done("noop", githubSha, mirrorSha, "ref no longer on the mirror");
  if (decision === "noop-equal") return done("noop", githubSha, mirrorSha);

  // 3. Clone the mirror's branch deep enough to contain GitHub's tip, so the
  //    fast-forward check is meaningful. Not reachable at full depth means
  //    GitHub's tip is genuinely not an ancestor → conflict, and we stop.
  let cloned: Awaited<ReturnType<typeof cloneBranchReaching>>;
  try {
    cloned = await cloneBranchReaching(p.artifactsRepo, p.remote, branch, githubSha ? [githubSha] : []);
  } catch (err) {
    return done("error", githubSha, mirrorSha, `mirror clone: ${(err as Error).message}`);
  }
  if (githubSha && cloned.reached !== githubSha) {
    return done(
      "conflict",
      githubSha,
      mirrorSha,
      `GitHub is at ${githubSha.slice(0, 8)}, which is not an ancestor of the mirror's ${mirrorSha!.slice(0, 8)} — not fast-forward; resolve by merging both and pushing to both`,
    );
  }

  // 4. Push. force:false — isomorphic-git re-checks fast-forward locally.
  try {
    const res = await git.push({
      fs: cloned.fs,
      http,
      dir: cloned.dir,
      url: githubUrl,
      ref: p.ref,
      remoteRef: p.ref,
      force: false,
      onAuth: githubAuth,
    });
    const refResult = res.refs?.[p.ref];
    if (refResult && refResult.ok === false) {
      const c = classifyPushError(new Error(refResult.error ?? "push rejected"));
      return done(c.status === "error" ? "rejected" : c.status, githubSha, mirrorSha, c.detail);
    }
    return done("synced", githubSha, cloned.headSha);
  } catch (err) {
    const c = classifyPushError(err);
    return done(c.status, githubSha, mirrorSha, c.detail);
  }
}

// ---- pure helpers (unit-tested) ------------------------------------------

export function decideReverse(tips: {
  githubSha: string | null;
  mirrorSha: string | null;
}): "noop-missing" | "noop-equal" | "push" {
  if (!tips.mirrorSha) return "noop-missing";
  if (tips.githubSha === tips.mirrorSha) return "noop-equal";
  return "push";
}

/**
 * Map an isomorphic-git / fetch error onto a reverse-sync status.
 *   PushRejectedError (not-fast-forward)      → conflict
 *   protected-branch / permission text        → rejected
 *   HTTP 401/403                              → auth
 *   anything else (network, 5xx, timeouts)    → error
 */
export function classifyPushError(err: unknown): { status: ReverseStatus; detail: string } {
  const e = (err ?? {}) as { code?: string; name?: string; message?: string; data?: { statusCode?: number } };
  const msg = String(e.message ?? err ?? "unknown error");
  const code = e.code ?? e.name ?? "";
  const statusCode = e.data?.statusCode;
  const lower = msg.toLowerCase();

  if (code === "PushRejectedError" || lower.includes("not a simple fast-forward")) {
    return { status: "conflict", detail: "not fast-forward: GitHub has commits the mirror does not" };
  }
  if (
    lower.includes("protected branch") ||
    lower.includes("gh006") ||
    lower.includes("gh013") ||
    lower.includes("permission to") ||
    lower.includes("write access to repository not granted")
  ) {
    return { status: "rejected", detail: msg.slice(0, 300) };
  }
  if (statusCode === 401 || statusCode === 403 || /\b40[13]\b/.test(msg) || lower.includes("bad credentials")) {
    return { status: "auth", detail: `GitHub refused the token (${msg.slice(0, 200)}) — check GITHUB_TOKEN` };
  }
  return { status: "error", detail: msg.slice(0, 300) };
}

/** 30 s · 2^attempts, capped at 1 h, ±10 % jitter (jitter injectable for tests). */
export function nextRetryDelayMs(attempts: number, rand: () => number = Math.random): number {
  const base = Math.min(30_000 * Math.pow(2, Math.max(0, attempts)), 3_600_000);
  const jitter = (rand() * 2 - 1) * 0.1 * base;
  return Math.round(base + jitter);
}

export const REVERSE_STALL_AFTER_MS = 7 * 24 * 3_600_000;

export interface ReverseState {
  ref: string;
  /** The mirror sha this entry was created for (informational; we always push the current tip). */
  sha: string;
  status: "pending" | "synced" | "conflict" | "rejected" | "auth" | "error" | "stalled";
  attempts: number;
  createdAt: number;
  /** Set when the entry came from an explicit `gitflare sync now` rather than an event. */
  manual?: boolean | undefined;
  lastAttemptAt?: number | undefined;
  nextAttemptAt?: number | undefined;
  lastError?: string | undefined;
  syncedAt?: number | undefined;
  githubSha?: string | undefined;
}

/** Fold one attempt's result into the persisted per-ref reverse state. */
export function applyReverseResult(
  prev: ReverseState,
  result: Pick<ReverseSyncResult, "status" | "detail" | "githubSha" | "mirrorSha">,
  now: number,
  rand: () => number = Math.random,
): ReverseState {
  const base: ReverseState = { ...prev, lastAttemptAt: now };
  switch (result.status) {
    case "noop":
    case "synced":
      return {
        ...base,
        status: "synced",
        syncedAt: now,
        githubSha: result.mirrorSha ?? result.githubSha ?? prev.githubSha,
        lastError: undefined,
        nextAttemptAt: undefined,
      };
    case "conflict":
    case "rejected":
      // Terminal until the ref changes or the user re-queues it (`sync now`).
      return {
        ...base,
        status: result.status,
        attempts: prev.attempts + 1,
        lastError: result.detail,
        githubSha: result.githubSha ?? prev.githubSha,
        nextAttemptAt: undefined,
      };
    case "auth":
    case "error": {
      const attempts = prev.attempts + 1;
      if (now - prev.createdAt > REVERSE_STALL_AFTER_MS) {
        return { ...base, status: "stalled", attempts, lastError: result.detail, nextAttemptAt: undefined };
      }
      return {
        ...base,
        status: result.status,
        attempts,
        lastError: result.detail,
        githubSha: result.githubSha ?? prev.githubSha,
        nextAttemptAt: now + nextRetryDelayMs(attempts, rand),
      };
    }
  }
}

/** Is this entry waiting for an attempt at or before `now`? */
export function isDue(entry: ReverseState, now: number): boolean {
  if (
    entry.status === "synced" ||
    entry.status === "conflict" ||
    entry.status === "rejected" ||
    entry.status === "stalled"
  ) {
    return false;
  }
  return (entry.nextAttemptAt ?? 0) <= now;
}
