import { describe, it, expect } from "vitest";
import {
  cloneIntoSandbox,
  runJobSteps,
  readArtifact,
  makeScrubber,
  makeLineBuffer,
  gitAuthEnv,
  validateCloneInputs,
  commandLabel,
  REPO_DIR,
  MAX_ARTIFACT_BYTES,
  type SandboxHandle,
  type ExecResultLike,
  type ExecOptionsLike,
} from "../src/ci/sandbox-runner";
import type { CiJob } from "../src/ci/workflow";

const SECRET = "s3cr3t-artifacts-token";
const REMOTE = "https://acct.artifacts.cloudflare.net/git/gitflare/owner--repo.git";
const SHA = "a".repeat(40);

interface Call {
  command: string;
  options?: ExecOptionsLike;
}

/** Scriptable fake sandbox: match commands by substring, in order of rules. */
function fakeSandbox(rules: Array<{
  match: string | RegExp;
  result?: Partial<ExecResultLike>;
  output?: string[];
  throwError?: string;
}> = []): { sandbox: SandboxHandle; calls: Call[]; destroyed: () => boolean; files: Map<string, string> } {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  let destroyed = false;
  const sandbox: SandboxHandle = {
    async exec(command, options) {
      calls.push({ command, ...(options ? { options } : {}) });
      const rule = rules.find((r) =>
        typeof r.match === "string" ? command.includes(r.match) : r.match.test(command),
      );
      if (rule?.throwError) throw new Error(rule.throwError);
      for (const line of rule?.output ?? []) options?.onOutput?.("stdout", line);
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        success: true,
        ...rule?.result,
      };
    },
    async readFile(path) {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return { content };
    },
    async destroy() {
      destroyed = true;
    },
  };
  return { sandbox, calls, destroyed: () => destroyed, files };
}

function runJob(steps: string[], overrides: Partial<CiJob> = {}): CiJob {
  return {
    name: "test",
    kind: "run",
    needs: [],
    steps: steps.map((command) => ({ type: "run" as const, command })),
    env: {},
    timeoutMinutes: 15,
    ...overrides,
  };
}

const META = { repo: "owner--repo", branch: "main", sha: SHA };

describe("validateCloneInputs", () => {
  it("accepts sane inputs", () => {
    expect(validateCloneInputs({ remote: REMOTE, branch: "main", sha: SHA })).toBeNull();
    expect(validateCloneInputs({ remote: REMOTE, branch: "feat/x_1.2-y", sha: SHA })).toBeNull();
  });
  it("rejects malformed shas", () => {
    expect(validateCloneInputs({ remote: REMOTE, branch: "main", sha: "HEAD" })).toMatch(/invalid sha/);
    expect(validateCloneInputs({ remote: REMOTE, branch: "main", sha: SHA.slice(1) })).toMatch(/invalid sha/);
  });
  it("rejects shell metacharacters and flag-shaped branches", () => {
    expect(validateCloneInputs({ remote: REMOTE, branch: "x;rm -rf /", sha: SHA })).toMatch(/invalid branch/);
    expect(validateCloneInputs({ remote: REMOTE, branch: "$(id)", sha: SHA })).toMatch(/invalid branch/);
    expect(validateCloneInputs({ remote: REMOTE, branch: "-upload-pack=x", sha: SHA })).toMatch(/invalid branch/);
  });
  it("rejects remotes with quotes/spaces or non-https scheme", () => {
    expect(validateCloneInputs({ remote: "http://x/y.git", branch: "main", sha: SHA })).toMatch(/invalid remote/);
    expect(validateCloneInputs({ remote: "https://x/`id`.git", branch: "main", sha: SHA })).toMatch(/invalid remote/);
    expect(validateCloneInputs({ remote: "https://x/a b.git", branch: "main", sha: SHA })).toMatch(/invalid remote/);
  });
});

describe("gitAuthEnv", () => {
  it("carries the token only in env-scoped git config, base64-encoded", () => {
    const env = gitAuthEnv(SECRET);
    expect(env.GIT_CONFIG_COUNT).toBe("1");
    expect(env.GIT_CONFIG_KEY_0).toBe("http.extraHeader");
    expect(env.GIT_CONFIG_VALUE_0).toBe(`Authorization: Basic ${btoa(`x:${SECRET}`)}`);
  });
});

describe("cloneIntoSandbox", () => {
  const params = { remote: REMOTE, branch: "main", sha: SHA, tokenSecret: SECRET };

  it("clones with auth env and checks out the sha", async () => {
    const { sandbox, calls } = fakeSandbox();
    const logs: string[] = [];
    const res = await cloneIntoSandbox(sandbox, { ...params, log: (l) => logs.push(l) });
    expect(res.ok).toBe(true);
    expect(calls[0]!.command).toBe(
      `git clone --quiet --depth 50 --single-branch --branch main -- ${REMOTE} ${REPO_DIR}`,
    );
    expect(calls[0]!.options?.env?.GIT_CONFIG_VALUE_0).toContain("Basic");
    expect(calls[1]!.command).toContain(`checkout --quiet ${SHA}`);
    // The checkout gets NO auth env — it's a local operation.
    expect(calls[1]!.options?.env).toBeUndefined();
    // The token never appears in any command line.
    for (const c of calls) {
      expect(c.command).not.toContain(SECRET);
      expect(c.command).not.toContain(btoa(`x:${SECRET}`));
    }
  });

  it("deepens once when the sha is missing, then succeeds", async () => {
    let checkouts = 0;
    const { sandbox, calls } = fakeSandbox([
      {
        match: /checkout/,
        result: { exitCode: 0 },
      },
    ]);
    // First checkout fails, second (after deepen) succeeds.
    const orig = sandbox.exec.bind(sandbox);
    sandbox.exec = async (cmd, opts) => {
      if (/checkout/.test(cmd) && checkouts++ === 0) {
        await orig(cmd, opts);
        return { stdout: "", stderr: "fatal: reference is not a tree", exitCode: 128, success: false };
      }
      return orig(cmd, opts);
    };
    const logs: string[] = [];
    const res = await cloneIntoSandbox(sandbox, { ...params, log: (l) => logs.push(l) });
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c.command.includes("fetch --quiet --depth 500 origin main"))).toBe(true);
    expect(logs.some((l) => l.includes("deepening"))).toBe(true);
  });

  it("fails with the git stderr tail when the clone fails", async () => {
    const { sandbox } = fakeSandbox([
      { match: "clone", result: { exitCode: 128, stderr: "fatal: could not read Username" } },
    ]);
    const res = await cloneIntoSandbox(sandbox, { ...params, log: () => {} });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/git clone failed: .*could not read Username/);
  });

  it("refuses invalid inputs before touching the sandbox", async () => {
    const { sandbox, calls } = fakeSandbox();
    const res = await cloneIntoSandbox(sandbox, {
      ...params,
      branch: "pwn`ed`",
      log: () => {},
    });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("runJobSteps", () => {
  it("runs steps in order with CI env, cwd, and job env merged", async () => {
    const { sandbox, calls } = fakeSandbox();
    const result = await runJobSteps(sandbox, {
      job: runJob(["npm ci", "npm test"], { env: { NODE_ENV: "test" } }),
      meta: META,
      log: () => {},
    });
    expect(result.ok).toBe(true);
    expect(result.steps).toEqual([
      { command: "npm ci", ok: true, exitCode: 0 },
      { command: "npm test", ok: true, exitCode: 0 },
    ]);
    const opts = calls[0]!.options!;
    expect(opts.cwd).toBe(REPO_DIR);
    expect(opts.env).toMatchObject({
      CI: "true",
      GITFLARE_REPO: "owner--repo",
      GITFLARE_BRANCH: "main",
      GITFLARE_SHA: SHA,
      NODE_ENV: "test",
    });
    expect(opts.stream).toBe(true);
    expect(typeof opts.timeout).toBe("number");
  });

  it("streams output lines through the log", async () => {
    const { sandbox } = fakeSandbox([
      { match: "npm test", output: ["> vitest run\n", "42 passed\npartial"] },
    ]);
    const logs: string[] = [];
    await runJobSteps(sandbox, { job: runJob(["npm test"]), meta: META, log: (l) => logs.push(l) });
    expect(logs).toContain("$ npm test");
    expect(logs).toContain("  > vitest run");
    expect(logs).toContain("  42 passed");
    expect(logs).toContain("  partial"); // flushed remainder
  });

  it("stops at the first failing step and reports the exit code", async () => {
    const { sandbox, calls } = fakeSandbox([
      { match: "npm test", result: { exitCode: 1, success: false } },
    ]);
    const result = await runJobSteps(sandbox, {
      job: runJob(["npm ci", "npm test", "npm run e2e"]),
      meta: META,
      log: () => {},
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('"npm test" exited 1');
    expect(result.steps).toHaveLength(2);
    expect(calls.map((c) => c.command)).toEqual(["npm ci", "npm test"]);
  });

  it("fails the job when the wall-clock budget is exhausted before a step", async () => {
    let t = 0;
    const { sandbox } = fakeSandbox();
    const result = await runJobSteps(sandbox, {
      job: runJob(["sleep", "never-runs"], { timeoutMinutes: 1 }),
      meta: META,
      log: () => {},
      now: () => {
        // First step consumes the whole budget.
        t += 61_000;
        return t;
      },
    });
    expect(result.ok).toBe(false);
    expect(result.steps.at(-1)!.detail).toMatch(/job timeout/);
  });

  it("maps an exec timeout error to a friendly outcome and warns about the leaked process", async () => {
    const { sandbox } = fakeSandbox([{ match: "hang", throwError: "Command timed out" }]);
    const logs: string[] = [];
    const result = await runJobSteps(sandbox, {
      job: runJob(["hang"]),
      meta: META,
      log: (l) => logs.push(l),
    });
    expect(result.ok).toBe(false);
    expect(result.message).toBe('"hang" timed out');
    expect(logs.some((l) => l.includes("may keep running"))).toBe(true);
  });

  it("labels multi-line commands by their first line", () => {
    expect(commandLabel("npm ci\nnpm test")).toBe("npm ci …");
    expect(commandLabel("npm test")).toBe("npm test");
  });
});

describe("makeScrubber", () => {
  it("scrubs the raw secret and its Basic-auth form from any line", () => {
    const scrub = makeScrubber([SECRET]);
    const b64 = btoa(`x:${SECRET}`);
    // The classic leak: git echoes the failing URL (had it held credentials)
    // or the header value into stderr.
    expect(scrub(`fatal: unable to access 'https://x:${SECRET}@host/repo.git'`)).not.toContain(SECRET);
    expect(scrub(`http.extraHeader: Authorization: Basic ${b64}`)).not.toContain(b64);
    expect(scrub("plain line")).toBe("plain line");
  });
  it("ignores empty secrets", () => {
    expect(makeScrubber([""])("anything")).toBe("anything");
  });
});

describe("makeLineBuffer", () => {
  it("splits chunks into lines, handles CRLF, flushes remainders", () => {
    const lines: string[] = [];
    const buf = makeLineBuffer((l) => lines.push(l));
    buf.push("a\r\nb");
    buf.push("c\nd");
    buf.flush();
    expect(lines).toEqual(["a", "bc", "d"]);
  });
});

describe("readArtifact", () => {
  it("reads a built entry from the workspace", async () => {
    const { sandbox, files } = fakeSandbox();
    files.set(`${REPO_DIR}/dist/worker.js`, "export default {}");
    const res = await readArtifact(sandbox, "dist/worker.js");
    expect(res).toEqual({ content: "export default {}" });
  });
  it("returns empty (not an error) when the file wasn't built", async () => {
    const { sandbox } = fakeSandbox();
    expect(await readArtifact(sandbox, "dist/worker.js")).toEqual({});
  });
  it("rejects path traversal and absolute paths", async () => {
    const { sandbox } = fakeSandbox();
    expect((await readArtifact(sandbox, "../../etc/passwd")).error).toMatch(/invalid entry path/);
    expect((await readArtifact(sandbox, "/etc/passwd")).error).toMatch(/invalid entry path/);
  });
  it("caps artifact size", async () => {
    const { sandbox, files } = fakeSandbox();
    files.set(`${REPO_DIR}/dist/worker.js`, "x".repeat(MAX_ARTIFACT_BYTES + 1));
    expect((await readArtifact(sandbox, "dist/worker.js")).error).toMatch(/exceeds/);
  });
});
