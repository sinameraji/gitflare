// Artifacts → Queues event subscriptions. Shapes verified live on 2026-08-19
// (spike S1): a `pushed` event fires for branch pushes, tag pushes, deletes
// (`after` = all zeros) AND same-sha pushes (`before` === `after`); the
// event's `source` uses camelCase `repoName` even though the subscription is
// created with snake_case `repo_name`. Commits are truncated at 20.

export interface ArtifactsPushedEvent {
  type: "cf.artifacts.repo.pushed";
  source: { type: "artifacts.repo"; namespace: string; repoName: string };
  payload: {
    ref: string;
    before: string;
    after: string;
    commits?: unknown[];
    totalCommitsCount?: number;
    commitsTruncated?: boolean;
  };
  metadata?: {
    accountId?: string;
    eventSubscriptionId?: string;
    eventSchemaVersion?: number;
    eventTimestamp?: string;
  };
}

const ZERO_SHA = "0".repeat(40);
const SHA_RE = /^[0-9a-f]{40}$/;

/** Parse a queue message body into a pushed event, or null for anything else. */
export function parseArtifactsEvent(body: unknown): ArtifactsPushedEvent | null {
  let b = body;
  if (typeof b === "string") {
    try {
      b = JSON.parse(b);
    } catch {
      return null;
    }
  }
  if (!b || typeof b !== "object") return null;
  const e = b as Partial<ArtifactsPushedEvent>;
  if (e.type !== "cf.artifacts.repo.pushed") return null;
  const src = e.source as Partial<ArtifactsPushedEvent["source"]> | undefined;
  const p = e.payload as Partial<ArtifactsPushedEvent["payload"]> | undefined;
  if (!src || src.type !== "artifacts.repo" || typeof src.namespace !== "string" || typeof src.repoName !== "string") {
    return null;
  }
  if (!p || typeof p.ref !== "string" || typeof p.before !== "string" || typeof p.after !== "string") return null;
  if (!SHA_RE.test(p.before) || !SHA_RE.test(p.after)) return null;
  return e as ArtifactsPushedEvent;
}

export type RefKind = "branch" | "tag" | "other";

export interface RefClassification {
  kind: RefKind;
  /** all-zero `after` */
  isDelete: boolean;
  /** `before` === `after` — nothing moved (isomorphic-git same-sha pushes emit these) */
  isNoop: boolean;
  /** all-zero `before` */
  isCreate: boolean;
  branch?: string | undefined;
}

export function classifyRef(ref: string, before: string, after: string): RefClassification {
  const kind: RefKind = ref.startsWith("refs/heads/") ? "branch" : ref.startsWith("refs/tags/") ? "tag" : "other";
  return {
    kind,
    isDelete: after === ZERO_SHA,
    isNoop: before === after,
    isCreate: before === ZERO_SHA,
    ...(kind === "branch" ? { branch: ref.slice("refs/heads/".length) } : {}),
  };
}

/** How long an `outbound:` marker is trusted before it's assumed orphaned by an eviction. */
export const OUTBOUND_MARKER_TTL_MS = 10 * 60_000;

/**
 * Was this Artifacts push our own (the forward GitHub→Artifacts sync)?
 * Two signals, either suffices:
 *  - an `outbound:<ref>` marker for this sha, written BEFORE the forward push
 *    started (so it can never lose the race with the event), still fresh;
 *  - the ref's persisted state already records this sha (the forward sync
 *    completed — or an earlier delivery of this same external push did).
 */
export function isOwnPush(input: {
  after: string;
  outbound?: { sha: string; startedAt: number } | undefined;
  refSha?: string | undefined;
  now: number;
}): boolean {
  const { after, outbound, refSha, now } = input;
  if (refSha === after) return true;
  if (outbound && outbound.sha === after && now - outbound.startedAt <= OUTBOUND_MARKER_TTL_MS) return true;
  return false;
}
