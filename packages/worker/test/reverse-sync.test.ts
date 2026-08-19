import { describe, it, expect } from "vitest";
import {
  applyReverseResult,
  classifyPushError,
  decideReverse,
  isDue,
  nextRetryDelayMs,
  REVERSE_STALL_AFTER_MS,
  type ReverseState,
} from "../src/sync/reverse-sync";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const mid = () => 0.5; // no jitter

describe("decideReverse", () => {
  it("noop when the mirror no longer has the ref (never delete on GitHub)", () => {
    expect(decideReverse({ githubSha: SHA_A, mirrorSha: null })).toBe("noop-missing");
  });
  it("noop when both tips are equal", () => {
    expect(decideReverse({ githubSha: SHA_A, mirrorSha: SHA_A })).toBe("noop-equal");
  });
  it("push when the mirror is ahead or the branch is new on GitHub", () => {
    expect(decideReverse({ githubSha: SHA_A, mirrorSha: SHA_B })).toBe("push");
    expect(decideReverse({ githubSha: null, mirrorSha: SHA_B })).toBe("push");
  });
});

describe("classifyPushError", () => {
  it("not-fast-forward → conflict", () => {
    const e = Object.assign(new Error('Push rejected because it was not a simple fast-forward. Use "force: true" to override.'), { code: "PushRejectedError" });
    expect(classifyPushError(e).status).toBe("conflict");
    expect(classifyPushError(new Error("not a simple fast-forward")).status).toBe("conflict");
  });
  it("protected branch / permission text → rejected", () => {
    expect(classifyPushError(new Error("GH006: Protected branch update failed for refs/heads/main.")).status).toBe("rejected");
    expect(classifyPushError(new Error("remote: Permission to o/r.git denied to user.")).status).toBe("rejected");
  });
  it("401/403 → auth", () => {
    expect(classifyPushError(Object.assign(new Error("HTTP Error: 401 Unauthorized"), { data: { statusCode: 401 } })).status).toBe("auth");
    expect(classifyPushError(new Error("HTTP Error: 403 Forbidden")).status).toBe("auth");
    expect(classifyPushError(new Error("Bad credentials")).status).toBe("auth");
  });
  it("everything else → error (retryable), with a truncated detail", () => {
    expect(classifyPushError(new TypeError("fetch failed")).status).toBe("error");
    expect(classifyPushError("x".repeat(1000)).detail.length).toBeLessThanOrEqual(300);
    expect(classifyPushError(undefined).status).toBe("error");
  });
});

describe("nextRetryDelayMs", () => {
  it("doubles from 30 s and caps at 1 h", () => {
    expect(nextRetryDelayMs(0, mid)).toBe(30_000);
    expect(nextRetryDelayMs(1, mid)).toBe(60_000);
    expect(nextRetryDelayMs(3, mid)).toBe(240_000);
    expect(nextRetryDelayMs(20, mid)).toBe(3_600_000);
  });
  it("jitter stays within ±10 %", () => {
    expect(nextRetryDelayMs(0, () => 0)).toBe(27_000);
    expect(nextRetryDelayMs(0, () => 1)).toBe(33_000);
  });
});

describe("applyReverseResult", () => {
  const now = 10_000_000;
  const pending: ReverseState = { ref: "refs/heads/main", sha: SHA_B, status: "pending", attempts: 0, createdAt: now - 5000, nextAttemptAt: now };

  it("synced/noop → synced, clears retry + error, records GitHub's sha", () => {
    const s = applyReverseResult(pending, { status: "synced", githubSha: SHA_A, mirrorSha: SHA_B }, now);
    expect(s.status).toBe("synced");
    expect(s.syncedAt).toBe(now);
    expect(s.githubSha).toBe(SHA_B);
    expect(s.nextAttemptAt).toBeUndefined();
    const n = applyReverseResult({ ...pending, lastError: "x" }, { status: "noop", githubSha: SHA_B, mirrorSha: SHA_B }, now);
    expect(n.status).toBe("synced");
    expect(n.lastError).toBeUndefined();
  });
  it("conflict / rejected are terminal: no next attempt, error kept", () => {
    const c = applyReverseResult(pending, { status: "conflict", detail: "diverged", githubSha: SHA_A, mirrorSha: SHA_B }, now);
    expect(c.status).toBe("conflict");
    expect(c.nextAttemptAt).toBeUndefined();
    expect(c.lastError).toBe("diverged");
    expect(c.attempts).toBe(1);
    expect(isDue(c, now + 1e9)).toBe(false);
  });
  it("auth / error schedule a backoff retry and count attempts", () => {
    const e1 = applyReverseResult(pending, { status: "error", detail: "fetch failed", githubSha: null, mirrorSha: null }, now, mid);
    expect(e1.status).toBe("error");
    expect(e1.attempts).toBe(1);
    expect(e1.nextAttemptAt).toBe(now + 60_000);
    expect(isDue(e1, now)).toBe(false);
    expect(isDue(e1, now + 60_000)).toBe(true);
    const e2 = applyReverseResult(e1, { status: "auth", detail: "401", githubSha: null, mirrorSha: null }, now + 60_000, mid);
    expect(e2.status).toBe("auth");
    expect(e2.attempts).toBe(2);
    expect(e2.nextAttemptAt).toBe(now + 60_000 + 120_000);
  });
  it("gives up as stalled after 7 days of failures", () => {
    const old: ReverseState = { ...pending, createdAt: now - REVERSE_STALL_AFTER_MS - 1 };
    const s = applyReverseResult(old, { status: "error", detail: "still down", githubSha: null, mirrorSha: null }, now, mid);
    expect(s.status).toBe("stalled");
    expect(s.nextAttemptAt).toBeUndefined();
    expect(isDue(s, now + 1e9)).toBe(false);
  });
});

describe("isDue", () => {
  it("pending with no nextAttemptAt is due immediately; synced never is", () => {
    const p: ReverseState = { ref: "r", sha: SHA_A, status: "pending", attempts: 0, createdAt: 0 };
    expect(isDue(p, 1)).toBe(true);
    expect(isDue({ ...p, status: "synced" }, 1e12)).toBe(false);
  });
});
