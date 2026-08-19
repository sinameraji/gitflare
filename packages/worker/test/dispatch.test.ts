import { describe, it, expect } from "vitest";
import { dispatchPush } from "../src/pipeline/dispatch";
import type { Env } from "../src/env";

function fakeNamespace(calls: Array<{ ns: string; url: string; body: unknown }>, ns: string) {
  return {
    idFromName: (name: string) => ({ name }),
    get: () => ({
      fetch: async (url: string, init?: { body?: string }) => {
        calls.push({ ns, url, body: init?.body ? JSON.parse(init.body) : undefined });
        return new Response(JSON.stringify({ accepted: true }), { status: 202 });
      },
    }),
  } as unknown as DurableObjectNamespace;
}

const input = {
  githubFullName: "o/r",
  artifactsRepoName: "o--r",
  remote: "https://acct.artifacts.cloudflare.net/git/gitflare/o--r.git",
  ref: "refs/heads/main",
  sha: "e".repeat(40),
  origin: "https://w.example.workers.dev",
} as const;

describe("dispatchPush", () => {
  it("routes to CiDO when CI is enabled, carrying the mode and status URL", async () => {
    const calls: Array<{ ns: string; url: string; body: any }> = [];
    const env = { CI_ENABLED: "1", CI: fakeNamespace(calls, "CI"), DEPLOY: fakeNamespace(calls, "DEPLOY") } as unknown as Env;
    await dispatchPush(env, { ...input, mode: "artifacts-push" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ns).toBe("CI");
    expect(calls[0]!.url).toBe("https://ci-do/run");
    expect(calls[0]!.body.mode).toBe("artifacts-push");
    expect(calls[0]!.body.statusTargetUrl).toBe("https://w.example.workers.dev/r/o--r/ci");
    expect(calls[0]!.body.githubFullName).toBe("o/r");
  });
  it("routes to DeployDO otherwise, carrying the mode", async () => {
    const calls: Array<{ ns: string; url: string; body: any }> = [];
    const env = { CI: fakeNamespace(calls, "CI"), DEPLOY: fakeNamespace(calls, "DEPLOY") } as unknown as Env;
    await dispatchPush(env, { ...input, mode: "push" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.ns).toBe("DEPLOY");
    expect(calls[0]!.url).toBe("https://deploy-do/deploy");
    expect(calls[0]!.body.mode).toBe("push");
    expect(calls[0]!.body.sha).toBe(input.sha);
  });
});
