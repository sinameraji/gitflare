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
    expect(workflow).toEqual({
      on: ["push"],
      branches: ["main"],
      steps: [
        { type: "cloudflare/deploy", project: "my-worker", kind: "worker", entry: "dist/worker.js" },
      ],
    });
  });

  it("defaults kind to worker and handles a block branch list", () => {
    const { workflow } = parseDeployWorkflow(
      `on: push\nbranches:\n  - main\n  - release\nsteps:\n  - cloudflare/deploy:\n      project: w\n      entry: a.js\n`,
    );
    expect(workflow?.branches).toEqual(["main", "release"]);
    expect(workflow?.steps[0]!.kind).toBe("worker");
  });

  it("ignores comments and blank lines", () => {
    const { workflow } = parseDeployWorkflow(
      `# deploy config\non: push  # trigger\nsteps:\n  - cloudflare/deploy:\n      project: w\n      entry: a.js\n`,
    );
    expect(workflow?.on).toEqual(["push"]);
  });

  it("errors on an unsupported step", () => {
    const { error } = parseDeployWorkflow(
      `on: push\nsteps:\n  - run: npm test\n`,
    );
    expect(error).toMatch(/cloudflare\/deploy/);
  });

  it("errors when a step lacks project/entry", () => {
    const { error } = parseDeployWorkflow(
      `on: push\nsteps:\n  - cloudflare/deploy:\n      kind: worker\n`,
    );
    expect(error).toMatch(/project/);
  });

  it("errors on missing on:", () => {
    const { error } = parseDeployWorkflow(
      `steps:\n  - cloudflare/deploy:\n      project: w\n      entry: a.js\n`,
    );
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
    const all = parseDeployWorkflow(
      `on: push\nsteps:\n  - cloudflare/deploy:\n      project: w\n      entry: a.js\n`,
    ).workflow!;
    expect(matchesPush(all, "refs/heads/anything")).toBe(true);
  });
  it("rejects non-push events", () => {
    expect(matchesPush(wf, "refs/tags/v1")).toBe(false);
  });
});
