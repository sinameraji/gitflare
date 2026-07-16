import { describe, it, expect } from "vitest";
import { buildStatusRequest, postCommitStatus } from "../src/ci/github-status";

const BASE = {
  githubFullName: "owner/repo",
  sha: "a".repeat(40),
  state: "success" as const,
  description: "2 job(s) passed",
  token: "ghp_test",
};

describe("buildStatusRequest", () => {
  it("shapes the legacy Status API request", () => {
    const { url, init } = buildStatusRequest({ ...BASE, targetUrl: "https://x.dev/r/repo/ci" });
    expect(url).toBe(`https://api.github.com/repos/owner/repo/statuses/${"a".repeat(40)}`);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ghp_test");
    expect(headers["User-Agent"]).toBe("gitflare-worker"); // GitHub rejects UA-less requests
    expect(JSON.parse(init.body as string)).toEqual({
      state: "success",
      context: "gitflare/ci",
      description: "2 job(s) passed",
      target_url: "https://x.dev/r/repo/ci",
    });
  });

  it("omits target_url when absent and truncates long descriptions", () => {
    const { init } = buildStatusRequest({ ...BASE, description: "x".repeat(200) });
    const body = JSON.parse(init.body as string) as { description: string; target_url?: string };
    expect(body.target_url).toBeUndefined();
    expect(body.description.length).toBeLessThanOrEqual(140);
    expect(body.description.endsWith("…")).toBe(true);
  });
});

describe("postCommitStatus", () => {
  it("returns ok on 201", async () => {
    const res = await postCommitStatus({
      ...BASE,
      fetchImpl: async () => new Response("{}", { status: 201 }),
    });
    expect(res).toEqual({ ok: true, status: 201 });
  });

  it("soft-fails with detail on API errors", async () => {
    const res = await postCommitStatus({
      ...BASE,
      fetchImpl: async () => new Response('{"message":"Bad credentials"}', { status: 401 }),
    });
    expect(res.ok).toBe(false);
    expect(res.status).toBe(401);
    expect(res.detail).toMatch(/Bad credentials/);
  });

  it("soft-fails on network errors (GitHub down is the whole point)", async () => {
    const res = await postCommitStatus({
      ...BASE,
      fetchImpl: async () => {
        throw new Error("connect ETIMEDOUT");
      },
    });
    expect(res).toEqual({ ok: false, status: 0, detail: "connect ETIMEDOUT" });
  });
});
