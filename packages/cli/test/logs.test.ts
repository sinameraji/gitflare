import { describe, it, expect } from "vitest";
import kleur from "kleur";
import { parseLogsArgs, logsPath, formatLogLine, formatRunHeader, formatRunFooter, type LogsRun } from "../src/logs";

describe("parseLogsArgs", () => {
  it("defaults to the latest run, no job, no follow", () => {
    expect(parseLogsArgs(undefined, {})).toEqual({ args: { run: "latest", follow: false } });
    expect(parseLogsArgs("latest", {})).toEqual({ args: { run: "latest", follow: false } });
  });
  it("accepts a run id, with or without #", () => {
    expect(parseLogsArgs("12", { follow: true })).toEqual({ args: { run: 12, follow: true } });
    expect(parseLogsArgs("#12", {}).args?.run).toBe(12);
  });
  it("rejects non-numeric / zero / negative run ids", () => {
    for (const bad of ["abc", "0", "-3", "1.5", "12abc"]) {
      expect(parseLogsArgs(bad, {}).error).toMatch(/run id/);
    }
  });
  it("trims --job and rejects an empty one", () => {
    expect(parseLogsArgs(undefined, { job: " test " }).args).toEqual({ run: "latest", job: "test", follow: false });
    expect(parseLogsArgs(undefined, { job: "  " }).error).toMatch(/--job/);
  });
});

describe("logsPath", () => {
  it("builds the control endpoint query", () => {
    expect(logsPath("owner--repo", { run: "latest" })).toBe("/control/ci/logs?repo=owner--repo&run=latest&after=0");
    expect(logsPath("owner--repo", { run: 7, job: "unit tests" }, 42)).toBe(
      "/control/ci/logs?repo=owner--repo&run=7&after=42&job=unit+tests",
    );
  });
});

describe("formatLogLine", () => {
  const line = "2026-11-04T01:02:03.456Z  [test] $ npm test";
  it("shortens the timestamp and keeps the job tag", () => {
    expect(formatLogLine(line)).toBe("01:02:03 [test] $ npm test");
  });
  it("drops the tag when following that job", () => {
    expect(formatLogLine(line, { job: "test" })).toBe("01:02:03 $ npm test");
  });
  it("handles run-level lines and passes unknown shapes through", () => {
    expect(formatLogLine("2026-11-04T01:02:03.000Z  ci run #3 started")).toBe("01:02:03 ci run #3 started");
    expect(formatLogLine("plain text")).toBe("plain text");
  });
  it("colors only when asked", () => {
    kleur.enabled = true; // kleur turns itself off when the test runner isn't a TTY
    expect(formatLogLine(line, { color: true })).not.toBe(formatLogLine(line));
  });
});

describe("run header/footer", () => {
  const run: LogsRun = {
    id: 3,
    branch: "main",
    sha: "abcdef0123456789",
    mode: "push",
    status: "failed",
    message: undefined,
    jobs: [
      { name: "test", status: "failed", message: "step 1 exited 1" },
      { name: "deploy", status: "skipped" },
    ],
  };
  it("summarizes the run", () => {
    expect(formatRunHeader(run)).toBe("run #3 · main @ abcdef01 · push · failed · test:failed deploy:skipped");
    expect(formatRunHeader(run, "test")).toBe("run #3 · main @ abcdef01 · push · failed · job test");
  });
  it("reports the selected job's outcome", () => {
    expect(formatRunFooter(run, "test")).toBe("job test failed — step 1 exited 1 (run #3 failed)");
    expect(formatRunFooter(run)).toBe("run #3 failed");
  });
});
