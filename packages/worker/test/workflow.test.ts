import { describe, it, expect } from "vitest";
import { parseDeployWorkflow, matchesPush } from "../src/deploy/workflow";

const CANONICAL = `
on: push
branches: [main]
steps:
  - cloudflare/deploy:
      project: my-worker
      kind: worker
      entry: dist/worker.js
`;

describe("parseDeployWorkflow", () => {
  it("parses the canonical shape", () => {
    const { workflow, error } = parseDeployWorkflow(CANONICAL);
    expect(error).toBeUndefined();
    expect(workflow!.on).toEqual(["push"]);
    expect(workflow!.branches).toEqual(["main"]);
    expect(workflow!.steps).toHaveLength(1);
    const s = workflow!.steps[0]!;
    expect(s).toMatchObject({ type: "cloudflare/deploy", project: "my-worker", kind: "worker", entry: "dist/worker.js" });
    expect(s.bindings).toEqual({ vars: {}, kv: [], r2: [], d1: [], durable_objects: [], services: [] });
  });

  it("parses worker bindings (vars, kv, r2, d1)", () => {
    const { workflow, error } = parseDeployWorkflow(`
on: push
steps:
  - cloudflare/deploy:
      project: api
      entry: dist/api.js
      vars:
        API_BASE: https://example.com
        DEBUG: "true"
      kv:
        - { binding: CACHE, id: kv123 }
      r2:
        - binding: BUCKET
          bucket_name: my-bucket
      d1:
        - binding: DB
          database_id: db456
`);
    expect(error).toBeUndefined();
    const b = workflow!.steps[0]!.bindings;
    expect(b.vars).toEqual({ API_BASE: "https://example.com", DEBUG: "true" });
    expect(b.kv).toEqual([{ binding: "CACHE", id: "kv123" }]);
    expect(b.r2).toEqual([{ binding: "BUCKET", bucket_name: "my-bucket" }]);
    expect(b.d1).toEqual([{ binding: "DB", database_id: "db456" }]);
  });

  it("parses migrations with the apply gate", () => {
    const { workflow } = parseDeployWorkflow(`
on: push
steps:
  - cloudflare/deploy:
      project: api
      entry: dist/api.js
      migrations:
        dir: migrations
        database_id: db456
        apply: true
`);
    expect(workflow!.steps[0]!.migrations).toEqual({ dir: "migrations", database_id: "db456", apply: true });
  });

  it("defaults migrations apply to false", () => {
    const { workflow } = parseDeployWorkflow(`
on: push
steps:
  - cloudflare/deploy:
      project: api
      entry: dist/api.js
      migrations:
        dir: migrations
        database_id: db456
`);
    expect(workflow!.steps[0]!.migrations!.apply).toBe(false);
  });

  it("accepts kind: pages with production_branch", () => {
    const { workflow } = parseDeployWorkflow(`
on: push
steps:
  - cloudflare/deploy:
      project: site
      kind: pages
      entry: dist
      production_branch: main
`);
    expect(workflow!.steps[0]!.kind).toBe("pages");
    expect(workflow!.steps[0]!.production_branch).toBe("main");
  });

  it("errors on an unsupported step", () => {
    const { error } = parseDeployWorkflow(`on: push\nsteps:\n  - run: npm test\n`);
    expect(error).toMatch(/cloudflare\/deploy/);
  });

  it("errors when a step lacks project/entry", () => {
    const { error } = parseDeployWorkflow(`on: push\nsteps:\n  - cloudflare/deploy:\n      kind: worker\n`);
    expect(error).toMatch(/project/);
  });

  it("errors on missing on:", () => {
    const { error } = parseDeployWorkflow(`steps:\n  - cloudflare/deploy:\n      project: w\n      entry: a.js\n`);
    expect(error).toMatch(/on:/);
  });
});

describe("matchesPush", () => {
  const wf = parseDeployWorkflow(CANONICAL).workflow!;
  it("matches the listed branch", () => {
    expect(matchesPush(wf, "refs/heads/main")).toBe(true);
  });
  it("rejects an unlisted branch", () => {
    expect(matchesPush(wf, "refs/heads/dev")).toBe(false);
  });
  it("matches any branch when none listed", () => {
    const all = parseDeployWorkflow(`on: push\nsteps:\n  - cloudflare/deploy:\n      project: w\n      entry: a.js\n`).workflow!;
    expect(matchesPush(all, "refs/heads/anything")).toBe(true);
  });
  it("rejects non-push events", () => {
    expect(matchesPush(wf, "refs/tags/v1")).toBe(false);
  });
});
