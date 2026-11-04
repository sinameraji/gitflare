import { describe, it, expect } from "vitest";
import { jobCommitStatus, jobStatusContext, jobLogsUrl } from "../src/ci/job-status";
import { buildStatusRequest } from "../src/ci/github-status";

const BASE = "https://gf.example.dev/r/owner--repo/ci";

describe("jobStatusContext", () => {
  it("namespaces under gitflare/ci", () => {
    expect(jobStatusContext("test")).toBe("gitflare/ci/test");
    expect(jobStatusContext("build-and-lint")).toBe("gitflare/ci/build-and-lint");
  });
  it("collapses whitespace/control characters and trims dashes", () => {
    expect(jobStatusContext("  unit tests\t(node)\n")).toBe("gitflare/ci/unit-tests-(node)");
    expect(jobStatusContext("   ")).toBe("gitflare/ci/job");
  });
  it("caps very long names", () => {
    const ctx = jobStatusContext("x".repeat(500));
    expect(ctx.startsWith("gitflare/ci/x")).toBe(true);
    expect(ctx.length).toBe(100);
  });
});

describe("jobLogsUrl", () => {
  it("links to the run filtered to the job, URL-encoding the name", () => {
    expect(jobLogsUrl(BASE, 7, "e2e tests/chrome")).toBe(`${BASE}?run=7&job=e2e%20tests%2Fchrome#logs`);
  });
});

describe("jobCommitStatus", () => {
  it("does not post a job still queued", () => {
    expect(jobCommitStatus({ name: "test", status: "pending" }, 3, BASE)).toBeNull();
  });

  it("running → pending", () => {
    expect(jobCommitStatus({ name: "test", status: "running" }, 3, BASE)).toEqual({
      context: "gitflare/ci/test",
      state: "pending",
      description: "run #3: running",
      targetUrl: `${BASE}?run=3&job=test#logs`,
    });
  });

  it("success → success", () => {
    const s = jobCommitStatus({ name: "build", status: "success" }, 3, BASE)!;
    expect(s.state).toBe("success");
    expect(s.description).toBe("run #3: passed");
  });

  it("failed → failure with the job's message", () => {
    const s = jobCommitStatus({ name: "test", status: "failed", message: "step 2 exited 1" }, 3, BASE)!;
    expect(s.state).toBe("failure");
    expect(s.description).toBe("run #3: failed — step 2 exited 1");
  });

  it("skipped → error (never green) with why it was skipped", () => {
    const dep = jobCommitStatus({ name: "deploy", status: "skipped", message: 'dependency "test" failed' }, 3, BASE)!;
    expect(dep.state).toBe("error");
    expect(dep.description).toBe('run #3: skipped — dependency "test" failed');
    const bare = jobCommitStatus({ name: "deploy", status: "skipped" }, 3)!;
    expect(bare.description).toBe("run #3: skipped — not run");
    expect(bare.targetUrl).toBeUndefined();
  });

  it("keeps descriptions single-line and within GitHub's 140 chars", () => {
    const s = jobCommitStatus({ name: "test", status: "failed", message: `boom\n${"x".repeat(300)}` }, 12345, BASE)!;
    expect(s.description.length).toBeLessThanOrEqual(140);
    expect(s.description).not.toMatch(/\n/);
    expect(s.description.endsWith("…")).toBe(true);
  });

  it("flows into the Status API request with its own context", () => {
    const s = jobCommitStatus({ name: "test", status: "success" }, 1, BASE)!;
    const { init } = buildStatusRequest({
      githubFullName: "owner/repo",
      sha: "a".repeat(40),
      state: s.state,
      description: s.description,
      context: s.context,
      ...(s.targetUrl ? { targetUrl: s.targetUrl } : {}),
      token: "t",
    });
    expect(JSON.parse(init.body as string)).toEqual({
      state: "success",
      context: "gitflare/ci/test",
      description: "run #1: passed",
      target_url: `${BASE}?run=1&job=test#logs`,
    });
  });
});
