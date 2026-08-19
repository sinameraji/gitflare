import { describe, it, expect, beforeEach } from "vitest";
import { probeGithub, resetGithubHealthCache } from "../src/github/health";

const okFetch = (status = 200) => (async () => new Response("{}", { status })) as unknown as typeof fetch;

describe("probeGithub", () => {
  beforeEach(() => resetGithubHealthCache());
  it("reports reachable on 2xx/4xx and unreachable on 5xx", async () => {
    expect((await probeGithub(okFetch(200), 1000)).ok).toBe(true);
    resetGithubHealthCache();
    expect((await probeGithub(okFetch(403), 1000)).ok).toBe(true); // rate-limited is still 'up'
    resetGithubHealthCache();
    const down = await probeGithub(okFetch(503), 1000);
    expect(down.ok).toBe(false);
    expect(down.status).toBe(503);
  });
  it("reports unreachable on network errors, with a detail", async () => {
    const failing = (async () => { throw new TypeError("fetch failed"); }) as unknown as typeof fetch;
    const r = await probeGithub(failing, 1000);
    expect(r.ok).toBe(false);
    expect(r.status).toBeNull();
    expect(r.detail).toContain("fetch failed");
  });
  it("caches for 30 s per isolate", async () => {
    let calls = 0;
    const counting = (async () => { calls++; return new Response("{}", { status: 200 }); }) as unknown as typeof fetch;
    await probeGithub(counting, 1000);
    await probeGithub(counting, 20_000);
    expect(calls).toBe(1);
    await probeGithub(counting, 40_000);
    expect(calls).toBe(2);
  });
});
