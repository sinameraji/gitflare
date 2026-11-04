import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { sliceRunLogs, isJobLine } from "../src/ci/logs";
import { ciLogsHandler } from "../src/control/ci-logs";
import type { Env } from "../src/env";

const L = (msg: string) => `2026-11-04T00:00:00.000Z  ${msg}`;

describe("sliceRunLogs", () => {
  const run = {
    logs: [L("ci run #1 started"), L("[build] started (run job)"), L("[test] started (run job)"), L("[build] ✓ success")],
    logSeq: 4,
  };

  it("returns everything with a cursor at the end", () => {
    expect(sliceRunLogs(run)).toEqual({ lines: run.logs, next: 4, truncated: false });
  });

  it("filters to one job's lines", () => {
    expect(sliceRunLogs(run, { job: "build" }).lines).toEqual([run.logs[1], run.logs[3]]);
    expect(isJobLine(L("[build-2] x"), "build")).toBe(false);
  });

  it("resumes after a cursor", () => {
    expect(sliceRunLogs(run, { after: 2 }).lines).toEqual(run.logs.slice(2));
    expect(sliceRunLogs(run, { after: 4 })).toEqual({ lines: [], next: 4, truncated: false });
  });

  it("maps cursors onto a buffer whose oldest lines were dropped", () => {
    // 10 lines logged, only the newest 3 kept (seq 8..10).
    const capped = { logs: [L("eight"), L("nine"), L("ten")], logSeq: 10 };
    expect(sliceRunLogs(capped, { after: 8 }).lines).toEqual([L("nine"), L("ten")]);
    expect(sliceRunLogs(capped, { after: 7 })).toMatchObject({ lines: capped.logs, truncated: false });
    expect(sliceRunLogs(capped, { after: 2 })).toMatchObject({ lines: capped.logs, truncated: true, next: 10 });
  });

  it("treats records without logSeq (pre-M10) as never truncated", () => {
    expect(sliceRunLogs({ logs: [L("a"), L("b")] }, { after: 1 }).lines).toEqual([L("b")]);
  });
});

describe("GET /control/ci/logs", () => {
  const env = {
    CONTROL_SECRET: "s3cret",
    REPO_MAP: JSON.stringify({ "owner/repo": { name: "owner--repo", remote: "https://x" } }),
  } as unknown as Env;

  function makeApp() {
    const calls: string[] = [];
    const app = new Hono<{ Bindings: Env }>();
    app.get(
      "/control/ci/logs",
      ciLogsHandler((_env, name) => ({
        fetch: async (url: string) => {
          calls.push(`${name} ${url}`);
          return Response.json({ run: { id: 1, status: "success" }, lines: [], next: 0, truncated: false, done: true });
        },
      })),
    );
    return { app, calls };
  }
  const auth = { Authorization: "Bearer s3cret" };

  it("rejects a missing or wrong bearer without touching the DO", async () => {
    const { app, calls } = makeApp();
    expect((await app.request("/control/ci/logs?repo=owner--repo", {}, env)).status).toBe(401);
    expect(
      (await app.request("/control/ci/logs?repo=owner--repo", { headers: { Authorization: "Bearer nope!!" } }, env)).status,
    ).toBe(401);
    expect(calls).toEqual([]);
  });

  it("rejects everything when no CONTROL_SECRET is configured", async () => {
    const { app } = makeApp();
    const res = await app.request("/control/ci/logs?repo=owner--repo", { headers: { Authorization: "Bearer " } }, {
      ...env,
      CONTROL_SECRET: undefined,
    } as Env);
    expect(res.status).toBe(401);
  });

  it("404s an unknown repo and 400s a bad run id / cursor", async () => {
    const { app } = makeApp();
    expect((await app.request("/control/ci/logs?repo=nope", { headers: auth }, env)).status).toBe(404);
    expect((await app.request("/control/ci/logs?repo=owner--repo&run=abc", { headers: auth }, env)).status).toBe(400);
    expect((await app.request("/control/ci/logs?repo=owner--repo&after=-1", { headers: auth }, env)).status).toBe(400);
  });

  it("forwards run/job/after to the repo's CiDO", async () => {
    const { app, calls } = makeApp();
    const res = await app.request("/control/ci/logs?repo=owner--repo&run=12&job=unit%20tests&after=5", { headers: auth }, env);
    expect(res.status).toBe(200);
    expect(calls).toEqual(["owner--repo https://ci-do/logs?run=12&after=5&job=unit+tests"]);
    const { app: app2, calls: calls2 } = makeApp();
    await app2.request("/control/ci/logs?repo=owner--repo", { headers: auth }, env);
    expect(calls2).toEqual(["owner--repo https://ci-do/logs?run=latest&after=0"]);
  });
});
