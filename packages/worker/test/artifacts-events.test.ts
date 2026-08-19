import { describe, it, expect } from "vitest";
import { parseArtifactsEvent, classifyRef, isOwnPush, OUTBOUND_MARKER_TTL_MS } from "../src/events/artifacts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const ZERO = "0".repeat(40);

// Envelope shape as observed live on 2026-08-19 (spike S1).
const pushed = (payload: Partial<{ ref: string; before: string; after: string }>) => ({
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "gitflare", repoName: "sinameraji--kimiflare" },
  payload: { ref: "refs/heads/main", before: SHA_A, after: SHA_B, commits: [], totalCommitsCount: 1, commitsTruncated: false, ...payload },
  metadata: { accountId: "acct", eventSubscriptionId: "sub", eventSchemaVersion: 1, eventTimestamp: "2026-08-19T00:00:00Z" },
});

describe("parseArtifactsEvent", () => {
  it("accepts a well-formed pushed event (object or JSON string)", () => {
    const e = pushed({});
    expect(parseArtifactsEvent(e)?.payload.after).toBe(SHA_B);
    expect(parseArtifactsEvent(JSON.stringify(e))?.source.repoName).toBe("sinameraji--kimiflare");
  });
  it("rejects other event types, other sources, and malformed payloads", () => {
    expect(parseArtifactsEvent({ ...pushed({}), type: "cf.artifacts.repo.cloned" })).toBeNull();
    expect(parseArtifactsEvent({ ...pushed({}), source: { type: "kv" } })).toBeNull();
    expect(parseArtifactsEvent(pushed({ after: "nothex" }))).toBeNull();
    expect(parseArtifactsEvent("not json")).toBeNull();
    expect(parseArtifactsEvent(null)).toBeNull();
    expect(parseArtifactsEvent(42)).toBeNull();
  });
});

describe("classifyRef", () => {
  it("branch create / update / delete", () => {
    expect(classifyRef("refs/heads/main", ZERO, SHA_A)).toMatchObject({ kind: "branch", isCreate: true, isDelete: false, isNoop: false, branch: "main" });
    expect(classifyRef("refs/heads/feat/x", SHA_A, SHA_B)).toMatchObject({ kind: "branch", isCreate: false, isDelete: false, branch: "feat/x" });
    expect(classifyRef("refs/heads/main", SHA_A, ZERO)).toMatchObject({ kind: "branch", isDelete: true });
  });
  it("tags and other refs are not branches", () => {
    expect(classifyRef("refs/tags/v1", ZERO, SHA_A).kind).toBe("tag");
    expect(classifyRef("refs/notes/commits", ZERO, SHA_A).kind).toBe("other");
    expect(classifyRef("refs/tags/v1", ZERO, SHA_A).branch).toBeUndefined();
  });
  it("same-sha pushes are no-ops (Artifacts emits an event for them)", () => {
    expect(classifyRef("refs/heads/main", SHA_A, SHA_A).isNoop).toBe(true);
  });
});

describe("isOwnPush", () => {
  const now = 1_000_000;
  it("recognises the forward sync by its fresh outbound marker", () => {
    expect(isOwnPush({ after: SHA_B, outbound: { sha: SHA_B, startedAt: now - 1000 }, now })).toBe(true);
  });
  it("recognises a sha the ref state already records (completed forward sync or duplicate delivery)", () => {
    expect(isOwnPush({ after: SHA_B, refSha: SHA_B, now })).toBe(true);
  });
  it("ignores a stale marker and a different sha", () => {
    expect(isOwnPush({ after: SHA_B, outbound: { sha: SHA_B, startedAt: now - OUTBOUND_MARKER_TTL_MS - 1 }, now })).toBe(false);
    expect(isOwnPush({ after: SHA_B, outbound: { sha: SHA_A, startedAt: now }, refSha: SHA_A, now })).toBe(false);
    expect(isOwnPush({ after: SHA_B, now })).toBe(false);
  });
});
