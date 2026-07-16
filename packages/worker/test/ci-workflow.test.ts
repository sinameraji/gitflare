import { describe, it, expect } from "vitest";
import { parseCiWorkflow, ciMatchesPush, deployStepsOf, deployJobsOf } from "../src/ci/workflow";

const CANONICAL = `
on: push
branches: [main]
jobs:
  test:
    steps:
      - run: npm ci
      - run: npm test
  deploy:
    needs: [test]
    steps:
      - cloudflare/deploy:
          project: my-worker
          kind: worker
          entry: dist/worker.js
`;

describe("parseCiWorkflow", () => {
  it("parses the canonical example", () => {
    const { workflow, error } = parseCiWorkflow(CANONICAL);
    expect(error).toBeUndefined();
    expect(workflow!.on).toEqual(["push"]);
    expect(workflow!.branches).toEqual(["main"]);
    expect(workflow!.jobs.map((j) => j.name)).toEqual(["test", "deploy"]);
    const test = workflow!.jobs[0]!;
    expect(test.kind).toBe("run");
    expect(test.steps).toEqual([
      { type: "run", command: "npm ci" },
      { type: "run", command: "npm test" },
    ]);
    const deploy = workflow!.jobs[1]!;
    expect(deploy.kind).toBe("deploy");
    expect(deploy.needs).toEqual(["test"]);
    expect(deploy.steps[0]).toMatchObject({
      type: "cloudflare/deploy",
      step: { project: "my-worker", kind: "worker", entry: "dist/worker.js" },
    });
  });

  it("topologically orders jobs (declaration order breaks ties)", () => {
    const { workflow } = parseCiWorkflow(`
on: push
jobs:
  deploy:
    needs: [b, a]
    steps:
      - cloudflare/deploy: { project: p, entry: e }
  a:
    steps:
      - run: echo a
  b:
    needs: [a]
    steps:
      - run: echo b
`);
    expect(workflow!.jobs.map((j) => j.name)).toEqual(["a", "b", "deploy"]);
  });

  it("rejects unknown needs", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  test:
    needs: [nope]
    steps:
      - run: npm test
`);
    expect(error).toMatch(/unknown job "nope"/);
  });

  it("rejects dependency cycles", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  a:
    needs: [b]
    steps:
      - run: echo a
  b:
    needs: [a]
    steps:
      - run: echo b
`);
    expect(error).toMatch(/cycle/);
  });

  it("rejects a self-need", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  a:
    needs: [a]
    steps:
      - run: echo a
`);
    expect(error).toMatch(/needs itself/);
  });

  it("rejects mixing run and deploy steps in one job", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  all:
    steps:
      - run: npm run build
      - cloudflare/deploy: { project: p, entry: e }
`);
    expect(error).toMatch(/mixes run and cloudflare\/deploy/);
  });

  it("rejects runtime: worker with an actionable message", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  test:
    runtime: worker
    steps:
      - run: npm test
`);
    expect(error).toMatch(/runtime "worker".*isn't available/);
  });

  it("accepts runtime: sandbox explicitly", () => {
    const { workflow, error } = parseCiWorkflow(`
on: push
jobs:
  test:
    runtime: sandbox
    steps:
      - run: npm test
`);
    expect(error).toBeUndefined();
    expect(workflow!.jobs[0]!.kind).toBe("run");
  });

  it("rejects per-job images", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  e2e:
    image: mcr.microsoft.com/playwright:latest
    steps:
      - run: npm run e2e
`);
    expect(error).toMatch(/per-job images aren't supported/);
  });

  it("parses env and timeout_minutes", () => {
    const { workflow } = parseCiWorkflow(`
on: push
jobs:
  test:
    timeout_minutes: 30
    env:
      NODE_ENV: test
      API_BASE: https://example.com
    steps:
      - run: npm test
`);
    const job = workflow!.jobs[0]!;
    expect(job.timeoutMinutes).toBe(30);
    expect(job.env).toEqual({ NODE_ENV: "test", API_BASE: "https://example.com" });
  });

  it("defaults timeout to 15m and rejects out-of-range values", () => {
    const { workflow } = parseCiWorkflow(`
on: push
jobs:
  a:
    steps:
      - run: x
`);
    expect(workflow!.jobs[0]!.timeoutMinutes).toBe(15);
    const { error } = parseCiWorkflow(`
on: push
jobs:
  a:
    timeout_minutes: 90
    steps:
      - run: x
`);
    expect(error).toMatch(/timeout_minutes must be 1–60/);
  });

  it("parses multi-line run commands via block scalars", () => {
    const { workflow, error } = parseCiWorkflow(`
on: push
jobs:
  test:
    steps:
      - run: |
          npm ci
          npm test -- --reporter=dot
`);
    expect(error).toBeUndefined();
    expect(workflow!.jobs[0]!.steps[0]).toEqual({
      type: "run",
      command: "npm ci\nnpm test -- --reporter=dot",
    });
  });

  it("rejects unsupported step keys, empty jobs, and missing jobs", () => {
    expect(parseCiWorkflow(`
on: push
jobs:
  a:
    steps:
      - uses: actions/checkout@v4
`).error).toMatch(/unsupported step "uses"/);
    expect(parseCiWorkflow("on: push\njobs:\n  a:\n").error).toMatch(/must be a mapping|no steps/);
    expect(parseCiWorkflow("on: push\n").error).toMatch(/missing `jobs:`/);
    expect(parseCiWorkflow("jobs:\n").error).toMatch(/missing `on:`/);
  });

  it("validates deploy steps with the shared parser (missing entry)", () => {
    const { error } = parseCiWorkflow(`
on: push
jobs:
  deploy:
    steps:
      - cloudflare/deploy:
          project: my-worker
`);
    expect(error).toMatch(/missing `entry`/);
  });
});

describe("ciMatchesPush", () => {
  const wf = parseCiWorkflow(CANONICAL).workflow!;
  it("matches configured branches only", () => {
    expect(ciMatchesPush(wf, "refs/heads/main")).toBe(true);
    expect(ciMatchesPush(wf, "refs/heads/feature")).toBe(false);
  });
  it("matches every branch when branches is empty", () => {
    const open = parseCiWorkflow("on: push\njobs:\n  a:\n    steps:\n      - run: x\n").workflow!;
    expect(ciMatchesPush(open, "refs/heads/anything")).toBe(true);
  });
});

describe("deployStepsOf", () => {
  const wf = parseCiWorkflow(CANONICAL).workflow!;
  it("extracts a named job's deploy steps", () => {
    const { steps } = deployStepsOf(wf, "deploy");
    expect(steps).toHaveLength(1);
    expect(steps![0]!.project).toBe("my-worker");
  });
  it("extracts all deploy jobs when job is omitted", () => {
    const { steps } = deployStepsOf(wf);
    expect(steps).toHaveLength(1);
  });
  it("errors on unknown job and on run-only workflows", () => {
    expect(deployStepsOf(wf, "nope").error).toMatch(/no job named "nope"/);
    const runOnly = parseCiWorkflow("on: push\njobs:\n  a:\n    steps:\n      - run: x\n").workflow!;
    expect(deployStepsOf(runOnly).error).toMatch(/no cloudflare\/deploy steps/);
    expect(deployJobsOf(runOnly)).toEqual([]);
  });
});
