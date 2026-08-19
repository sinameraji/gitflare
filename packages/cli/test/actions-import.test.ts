import { describe, it, expect } from "vitest";
import { importActionsWorkflows, deployFromWranglerCommand } from "../src/actions-import.js";
import { parseCiWorkflow } from "../../worker/src/ci/workflow";

const wf = (name: string, text: string) => ({ name, text });

const CI = `
name: CI
on:
  pull_request:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    timeout-minutes: 90
    env:
      NODE_ENV: test
      TOKEN: \${{ secrets.NPM_TOKEN }}
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - name: Test
        working-directory: packages/worker
        env: { CI: "1" }
        run: |
          pnpm test
          echo \${{ github.sha }}
      - uses: some/thirdparty@v1
`;

const PAGES = `
on:
  push:
    branches: [main]
    paths: ['docs/**']
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm install -g wrangler
      - run: wrangler pages deploy docs --project-name=kimiflare
        env:
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
`;

describe("importActionsWorkflows", () => {
  it("translates a typical CI workflow, dropping/annotating what GitFlare can't run", () => {
    const r = importActionsWorkflows([wf("ci.yml", CI)]);
    expect(r.jobCount).toBe(1);
    const y = r.ciYml;
    expect(y).toContain("branches: [main]");
    expect(y).toContain("timeout_minutes: 60"); // capped
    expect(y).toContain("NODE_ENV: test");
    expect(y).not.toContain("TOKEN"); // secret dropped
    expect(y).toContain("npm i -g pnpm@9"); // pnpm/action-setup → run
    expect(y).not.toContain("actions/checkout");
    expect(y).toContain("cd packages/worker");
    expect(y).toContain("export CI=1");
    expect(y).toContain("echo $GITFLARE_SHA"); // expression mapped
    const notes = r.report.warnings.map((w) => w.note).join("\n");
    expect(notes).toContain("secrets store");
    expect(notes).toContain("some/thirdparty@v1");
    expect(notes).toContain("timeout-minutes capped");
    expect(notes).toContain("other triggers ignored: pull_request");
    // Round trip through the Worker's parser.
    const parsed = parseCiWorkflow(y);
    expect(parsed.error).toBeUndefined();
    expect(parsed.workflow?.jobs.map((j) => j.name)).toEqual(["build"]);
    expect(parsed.workflow?.jobs[0]?.steps).toHaveLength(3); // pnpm install, pnpm install --frozen, test block
  });

  it("turns `wrangler pages deploy` into a cloudflare/deploy job and drops the wrangler install", () => {
    const r = importActionsWorkflows([wf("pages.yml", PAGES)]);
    const y = r.ciYml;
    expect(y).toContain("kind: pages");
    expect(y).toContain("project: kimiflare");
    expect(y).toContain("entry: docs");
    expect(y).not.toContain("npm install -g wrangler");
    expect(r.report.warnings.map((w) => w.note).join("\n")).toContain("`paths` / `paths-ignore`");
    const parsed = parseCiWorkflow(y);
    expect(parsed.error).toBeUndefined();
    expect(parsed.workflow?.jobs[0]?.kind).toBe("deploy");
  });

  it("drops non-push workflows, non-Linux jobs, and reusable workflows with reasons", () => {
    const r = importActionsWorkflows([
      wf("manual.yml", "on: workflow_dispatch\njobs:\n  x:\n    runs-on: ubuntu-latest\n    steps: [{ run: echo hi }]\n"),
      wf("win.yml", "on: push\njobs:\n  w:\n    runs-on: windows-latest\n    steps: [{ run: echo hi }]\n  reuse:\n    uses: org/repo/.github/workflows/x.yml@main\n  ok:\n    runs-on: ubuntu-22.04\n    steps: [{ run: echo hi }]\n"),
    ]);
    const reasons = r.report.dropped.map((d) => `${d.workflow}:${d.job ?? ""}:${d.reason}`).join("\n");
    expect(reasons).toContain("manual.yml::no `push` trigger");
    expect(reasons).toContain("win.yml:w:runs-on: windows-latest");
    expect(reasons).toContain("win.yml:reuse:reusable workflow");
    expect(r.jobCount).toBe(1);
  });

  it("splits mixed run + deploy jobs, prunes needs to kept jobs, and renames collisions across files", () => {
    const r = importActionsWorkflows([
      wf("a.yml", "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm run build\n      - run: wrangler deploy --name my-worker\n"),
      wf("b.yml", "on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    needs: [gone]\n    steps: [{ run: echo b }]\n"),
    ]);
    const y = r.ciYml;
    expect(y).toContain("  build:\n");
    expect(y).toContain("  build-deploy:\n    needs: [build]");
    expect(y).toContain("  b-build:\n"); // collision renamed
    expect(y).toContain("project: my-worker");
    expect(y).toContain('entry: "<path/to/built/worker.js>"');
    expect(r.report.warnings.some((w) => w.note.includes("removed from needs"))).toBe(true);
    const parsed = parseCiWorkflow(y.replace('"<path/to/built/worker.js>"', "dist/worker.js"));
    expect(parsed.error).toBeUndefined();
    expect(parsed.workflow?.jobs.map((j) => j.name).sort()).toEqual(["b-build", "build", "build-deploy"]);
  });

  it("reports unparseable YAML instead of throwing", () => {
    const r = importActionsWorkflows([wf("bad.yml", "on: [push\njobs: :")]);
    expect(r.jobCount).toBe(0);
    expect(r.report.dropped[0]?.reason).toContain("could not parse YAML");
  });
});

describe("deployFromWranglerCommand", () => {
  it("parses pages deploys with project/branch, and worker deploys with --name", () => {
    expect(deployFromWranglerCommand("npx wrangler pages deploy ./dist --project-name my-site --branch=main")?.step).toEqual({
      project: "my-site", kind: "pages", entry: "./dist", extra: { production_branch: "main" },
    });
    expect(deployFromWranglerCommand("wrangler deploy --name api", "svc")?.step.project).toBe("api");
    expect(deployFromWranglerCommand("wrangler pages deploy out", "web")?.step.entry).toBe("web/out");
    expect(deployFromWranglerCommand("wrangler tail")).toBeNull();
    expect(deployFromWranglerCommand("echo hi")).toBeNull();
  });
});
