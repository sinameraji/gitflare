import { describe, it, expect, beforeAll } from "vitest";
import { Hono } from "hono";
import * as git from "isomorphic-git";
import { MemFs } from "../src/sync/memfs";
import { collectFileHistory } from "../src/blame/history";
import { computeBlame } from "../src/blame/algorithm";
import { registerBlameRoutes, parseBlamePath, type BlameDeps } from "../src/routes/blame";
import { accessGuard, type AccessVariables } from "../src/access/middleware";
import type { Env } from "../src/env";

// A real git history built in memory with isomorphic-git — the same object
// layer the Worker reads from its Artifacts clone.
const dir = "/repo";
const fs = new MemFs();
const shas: string[] = [];

async function commit(files: Record<string, string | Uint8Array | null>, message: string, t: number): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    if (content === null) {
      await fs.promises.unlink(`${dir}/${path}`);
      await git.remove({ fs, dir, filepath: path });
    } else {
      const parent = path.includes("/") ? `${dir}/${path.slice(0, path.lastIndexOf("/"))}` : dir;
      await fs.promises.mkdir(parent, { recursive: true });
      await fs.promises.writeFile(`${dir}/${path}`, content);
      await git.add({ fs, dir, filepath: path });
    }
  }
  const author = { name: `dev${t}`, email: `dev${t}@example.com`, timestamp: 1_700_000_000 + t * 3600, timezoneOffset: 0 };
  const sha = await git.commit({ fs, dir, message: `${message}\n\nbody ${t}`, author, committer: author });
  shas.push(sha);
  return sha;
}

beforeAll(async () => {
  await git.init({ fs, dir, defaultBranch: "main" });
  await commit({ "README.md": "hello\n" }, "init", 0); // 0: file under test doesn't exist yet
  await commit({ "src/app.ts": "const a = 1;\nconst b = 2;\nconst c = 3;\n" }, "feat: add app", 1); // 1: creation
  await commit({ "README.md": "hello world\n" }, "docs: readme", 2); // 2: doesn't touch app.ts
  await commit({ "src/app.ts": "const a = 1;\nconst b = 20;\nconst c = 3;\nconst d = 4;\n" }, "fix: b and add <d>", 3);
  await commit({ "src/app.ts": "const a = 1;\nconst c = 3;\nconst d = 4;\n" }, "refactor: drop b", 4);
  await commit({ "bin.dat": new Uint8Array([0, 1, 2, 0, 255]) }, "add binary", 5);
  await commit({ "big.txt": "x\n".repeat(50) }, "add big", 6);
});

const head = () => shas[shas.length - 1]!;
const blameOf = async (path: string, maxCommits = 100) =>
  collectFileHistory({ fs, dir, headSha: head(), path, limits: { maxCommits } });

describe("collectFileHistory + computeBlame over a real history", () => {
  it("attributes lines across creation, modification, deletion and untouched commits", async () => {
    const h = await blameOf("src/app.ts");
    expect(h.kind).toBe("ok");
    if (h.kind !== "ok") return;
    expect(h.truncated).toBeNull();
    // Versions are only the commits that changed the file.
    expect(h.versions.map((v) => v.commit.sha)).toEqual([shas[4], shas[3], shas[1]]);
    expect(h.versions[0]!.commit.subject).toBe("refactor: drop b");
    const r = computeBlame(h.versions);
    expect(r.lines.map((l) => r.commits[l.commit]!.sha)).toEqual([shas[1], shas[1], shas[3]]);
  });

  it("truncates at the commit cap and marks boundary lines", async () => {
    const h = await blameOf("src/app.ts", 2);
    expect(h.kind).toBe("ok");
    if (h.kind !== "ok") return;
    expect(h.truncated).toEqual({ kind: "depth", commits: 2 });
    const r = computeBlame(h.versions, { truncated: true });
    expect(r.lines.every((l) => l.boundary)).toBe(true);
  });

  it("reports missing paths, directories, binaries and oversize files", async () => {
    expect((await blameOf("nope.ts")).kind).toBe("missing");
    expect((await blameOf("src")).kind).toBe("directory");
    expect(await blameOf("bin.dat")).toEqual({ kind: "binary", size: 5 });
    const big = await collectFileHistory({ fs, dir, headSha: head(), path: "big.txt", limits: { maxLines: 10 } });
    expect(big).toMatchObject({ kind: "too-large", lines: 50 });
  });

  it("stops at an older version over the size cap and marks the rest boundary", async () => {
    // app.ts at head is 39 bytes; its version before commit 4 is 51.
    const h = await collectFileHistory({ fs, dir, headSha: head(), path: "src/app.ts", limits: { maxBytes: 45 } });
    expect(h.kind).toBe("ok");
    if (h.kind !== "ok") return;
    expect(h.truncated).toMatchObject({ kind: "size", sha: shas[3] });
    expect(h.versions.map((v) => v.commit.sha)).toEqual([shas[4]]);
  });
});

describe("parseBlamePath", () => {
  it("splits ref (one encoded segment) from path", () => {
    expect(parseBlamePath("/r/x/blame/main/src/a.ts", "x")).toEqual({ ref: "main", path: "src/a.ts" });
    expect(parseBlamePath("/r/x/blame/feat%2Fy/a%20b.ts", "x")).toEqual({ ref: "feat/y", path: "a b.ts" });
    expect(parseBlamePath("/r/x/blame/main", "x")).toBeNull();
    expect(parseBlamePath("/r/x/blame/main/", "x")).toBeNull();
  });
});

describe("GET /r/:name/blame/:ref/*", () => {
  const env = {
    REPO_MAP: JSON.stringify({ "o/r": { name: "o--r", remote: "https://artifacts.example/o--r.git" } }),
    GITFLARE_VERSION: "0.0.0-test",
    ARTIFACTS: { get: async () => ({}) },
  } as unknown as Env;
  const clonedDepths: number[] = [];
  const deps: BlameDeps = {
    listBranches: async () => ["main", "feat/y"],
    cloneBranch: async (_repo, _remote, branch, depth) => {
      clonedDepths.push(depth);
      return { fs, dir, headSha: head(), branchName: branch };
    },
  };
  const app = new Hono<{ Bindings: Env; Variables: AccessVariables }>();
  app.use("/r/*", accessGuard);
  registerBlameRoutes(app, deps);
  const get = (path: string, e: Env = env) => app.request(path, {}, e);

  it("renders hunks with sha, author, subject links and highlighted code", async () => {
    const res = await get("/r/o--r/blame/main/src/app.ts");
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="https://github.com/o/r/commit/${shas[1]}"`);
    expect(html).toContain(shas[3]!.slice(0, 7));
    expect(html).toContain("feat: add app");
    expect(html).toContain("dev3");
    expect(html).toContain("add &lt;d&gt;"); // subjects are escaped
    expect(html).not.toContain("<d>");
    expect(html).toContain("hljs-keyword"); // highlighting kept
    expect((html.match(/<tr class="hs">/g) ?? []).length).toBe(2); // two hunks: c1 x2, c3 x1
    expect(html).toContain('id="L3"');
    expect(html).not.toContain("blame-truncated");
    expect(clonedDepths.at(-1)).toBe(100);
  });

  it("shows the truncated banner with a deeper link, and clamps ?depth", async () => {
    const res = await get("/r/o--r/blame/main/src/app.ts?depth=2");
    const html = await res.text();
    expect(html).toContain("blame-truncated");
    expect(html).toContain("Blame truncated at 2 commits");
    expect(html).toContain(">^");
    expect(html).toContain("/r/o--r/blame/main/src/app.ts?depth=6");
    await get("/r/o--r/blame/main/src/app.ts?depth=99999");
    expect(clonedDepths.at(-1)).toBe(500);
  });

  it("binary files render a clear state instead of breaking", async () => {
    const res = await get("/r/o--r/blame/main/bin.dat");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Binary file");
  });

  it("accepts an encoded branch with a slash", async () => {
    const res = await get("/r/o--r/blame/feat%2Fy/src/app.ts");
    expect(res.status).toBe(200);
  });

  it("404s unknown repos, branches and paths", async () => {
    expect((await get("/r/nope/blame/main/a.ts")).status).toBe(404);
    expect((await get("/r/o--r/blame/dev/src/app.ts")).status).toBe(404);
    expect((await get("/r/o--r/blame/main/missing.ts")).status).toBe(404);
    expect((await get("/r/o--r/blame/main/src")).status).toBe(404);
  });

  it("sits behind the Access guard", async () => {
    const guarded = { ...env, ACCESS_AUD: "aud", ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com" } as Env;
    const res = await get("/r/o--r/blame/main/src/app.ts", guarded);
    expect(res.status).toBe(403);
  });
});
