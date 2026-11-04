import { describe, it, expect } from "vitest";
import {
  allSecretValues,
  base64Variants,
  canonicalSecretName,
  missingSecretsMessage,
  resolveJobEnv,
  secretEnvName,
  secretLookupFromEnv,
  secretRefsIn,
  utf8Base64,
  validateSecretName,
} from "../src/ci/secrets";
import { parseCiWorkflow } from "../src/ci/workflow";
import { makeScrubber, runJobSteps, type ExecOptionsLike, type SandboxHandle } from "../src/ci/sandbox-runner";

const wf = (env: string, extra = "") => `on: push
jobs:
  test:
    env:
${env}
    steps:
      - run: npm test
${extra}`;

describe("secret names", () => {
  it("validates like GitHub (letters, digits, _; no leading digit)", () => {
    expect(validateSecretName("NPM_TOKEN")).toBeNull();
    expect(validateSecretName("_x1")).toBeNull();
    expect(validateSecretName("1ABC")).toMatch(/invalid/);
    expect(validateSecretName("BAD-NAME")).toMatch(/invalid/);
    expect(validateSecretName("")).toMatch(/empty/);
    expect(validateSecretName("A".repeat(101))).toMatch(/longer/);
  });
  it("is case-insensitive via upper-case canonical names + a Worker-secret prefix", () => {
    expect(canonicalSecretName("npm_Token")).toBe("NPM_TOKEN");
    expect(secretEnvName("npm_token")).toBe("CI_SECRET_NPM_TOKEN");
  });
});

describe("secretRefsIn", () => {
  it("finds whole and embedded references, canonical + de-duped", () => {
    expect(secretRefsIn("${{ secrets.NPM_TOKEN }}").names).toEqual(["NPM_TOKEN"]);
    expect(secretRefsIn("Bearer ${{secrets.api_key}}:${{ secrets.API_KEY }}").names).toEqual(["API_KEY"]);
    expect(secretRefsIn("${{ secrets.A }}-${{ secrets.B }}").names).toEqual(["A", "B"]);
  });
  it("leaves non-secret text and other expressions alone", () => {
    expect(secretRefsIn("plain")).toEqual({ names: [] });
    expect(secretRefsIn("${{ github.sha }}")).toEqual({ names: [] });
  });
  it("rejects malformed references instead of shipping them literally", () => {
    expect(secretRefsIn("${{ secrets.bad-name }}").error).toMatch(/bad secrets reference/);
    expect(secretRefsIn("${{ secrets. }}").error).toMatch(/empty/);
    expect(secretRefsIn("${{ secrets.X || 'd' }}").error).toMatch(/invalid secret name/);
    expect(secretRefsIn("${{ secrets.X").error).toMatch(/unterminated/);
  });
});

describe("parseCiWorkflow + secrets", () => {
  it("accepts ${{ secrets.NAME }} in job env (unquoted and quoted) and records the names", () => {
    const { workflow, error } = parseCiWorkflow(
      wf(`      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}
      AUTH: "Bearer \${{ secrets.api_key }}"
      PLAIN: hello`),
    );
    expect(error).toBeUndefined();
    const job = workflow!.jobs[0]!;
    expect(job.secrets).toEqual(["NPM_TOKEN", "API_KEY"]);
    // Raw templates are kept; resolution happens at run time.
    expect(job.env.NPM_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(job.env.AUTH).toBe("Bearer ${{ secrets.api_key }}");
    expect(job.env.PLAIN).toBe("hello");
  });
  it("jobs without secrets have an empty list", () => {
    const { workflow } = parseCiWorkflow(wf(`      A: b`));
    expect(workflow!.jobs[0]!.secrets).toEqual([]);
  });
  it("rejects a malformed secret reference at parse time", () => {
    const { error } = parseCiWorkflow(wf(`      T: \${{ secrets.bad-name }}`));
    expect(error).toMatch(/job "test": env T: bad secrets reference/);
  });
  it("rejects secrets spliced into run: (they would land in argv)", () => {
    const { error } = parseCiWorkflow(`on: push
jobs:
  test:
    steps:
      - run: npm publish --token \${{ secrets.NPM_TOKEN }}
`);
    expect(error).toMatch(/isn't allowed in run:/);
    expect(error).toMatch(/env:/);
  });
  it("rejects secrets in deploy jobs and deploy steps", () => {
    const deployEnv = parseCiWorkflow(`on: push
jobs:
  ship:
    env:
      T: \${{ secrets.T }}
    steps:
      - cloudflare/deploy:
          project: p
          kind: worker
          entry: dist/w.js
`);
    expect(deployEnv.error).toMatch(/only reach run jobs/);
    const deployStep = parseCiWorkflow(`on: push
jobs:
  ship:
    steps:
      - cloudflare/deploy:
          project: \${{ secrets.P }}
          kind: worker
          entry: dist/w.js
`);
    expect(deployStep.error).toMatch(/cloudflare\/deploy/);
  });
});

describe("resolveJobEnv", () => {
  const env = { CI_SECRET_NPM_TOKEN: "npm_abc123", CI_SECRET_API_KEY: "k-999", CI_ENABLED: "1" };
  const lookup = secretLookupFromEnv(env);

  it("substitutes whole and embedded references from CI_SECRET_* bindings", () => {
    const r = resolveJobEnv(
      { NPM_TOKEN: "${{ secrets.npm_token }}", AUTH: "Bearer ${{ secrets.API_KEY }}", X: "plain ${{ github.sha }}" },
      lookup,
    );
    expect(r.env).toEqual({ NPM_TOKEN: "npm_abc123", AUTH: "Bearer k-999", X: "plain ${{ github.sha }}" });
    expect(r.values.sort()).toEqual(["k-999", "npm_abc123"]);
  });
  it("is all-or-nothing: any unset secret → missing list, no env", () => {
    const r = resolveJobEnv({ A: "${{ secrets.NPM_TOKEN }}", B: "${{ secrets.NOPE }}", C: "${{ secrets.ALSO_NOPE }}" }, lookup);
    expect(r.env).toBeUndefined();
    expect(r.missing).toEqual(["NOPE", "ALSO_NOPE"]);
    expect(r.values).toEqual([]);
    expect(missingSecretsMessage(r.missing!)).toBe(
      "secrets not set: NOPE, ALSO_NOPE — run `gitflare secrets set NOPE`",
    );
  });
  it("does not resolve non-secret Worker bindings", () => {
    expect(secretLookupFromEnv({ CONTROL_SECRET: "c" })("CONTROL_SECRET")).toBeUndefined();
  });
  it("allSecretValues collects only non-empty CI_SECRET_* strings", () => {
    expect(allSecretValues({ ...env, CI_SECRET_EMPTY: "", CONTROL_SECRET: "c", CI_SECRET_OBJ: {} }).sort()).toEqual([
      "k-999",
      "npm_abc123",
    ]);
  });
});

describe("scrubbing CI secrets", () => {
  const SECRET = "ghp_SuperSecretValue1234";

  it("blanks the plain value and its base64 at every alignment", () => {
    const scrub = makeScrubber([SECRET]);
    expect(scrub(`token=${SECRET};`)).toBe("token=***;");
    // `echo -n $S | base64`
    expect(scrub(utf8Base64(SECRET))).not.toContain(utf8Base64(SECRET).slice(0, 20));
    // `echo $S | base64` (trailing newline changes the tail of the encoding)
    const withNl = utf8Base64(`${SECRET}\n`);
    expect(scrub(withNl)).toContain("***");
    // embedded at offsets 1 and 2 of a longer encoded blob
    for (const prefix of ["a", "ab", "abc", "user:"]) {
      const enc = utf8Base64(`${prefix}${SECRET}-tail`);
      const out = scrub(enc);
      expect(out, prefix).toContain("***");
      // what's left can't be decoded back to the secret
      expect(out.length).toBeLessThan(enc.length);
    }
  });
  it("base64Variants are substrings of the encoding at their alignment", () => {
    const v = base64Variants(SECRET);
    expect(v).toHaveLength(3);
    expect(utf8Base64(SECRET)).toContain(v[0]);
    expect(utf8Base64(`x${SECRET}`)).toContain(v[1]);
    expect(utf8Base64(`xy${SECRET}`)).toContain(v[2]);
  });
  it("handles non-Latin-1 secrets without throwing", () => {
    const s = "pässwörd-🔑-value";
    const scrub = makeScrubber([s]);
    expect(scrub(`p=${s}`)).toBe("p=***");
    expect(scrub(utf8Base64(s))).toContain("***");
  });
  it("matches a multi-line secret line by line", () => {
    const pem = "-----BEGIN KEY-----\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END KEY-----";
    const scrub = makeScrubber([pem]);
    expect(scrub("MIIBOgIBAAJBAKj34GkxFhD9")).toBe("***");
  });
  it("blanks a longer secret whole even when it contains a shorter one", () => {
    const scrub = makeScrubber(["abcd", "xxabcdxx"]);
    expect(scrub("v=xxabcdxx")).toBe("v=***");
  });
});

describe("runJobSteps env injection", () => {
  it("delivers resolved secrets via exec env only — never in the command", async () => {
    const seen: Array<{ command: string; options?: ExecOptionsLike }> = [];
    const sandbox: SandboxHandle = {
      async exec(command, options) {
        seen.push({ command, ...(options ? { options } : {}) });
        options?.onOutput?.("stdout", `leak ${options.env?.NPM_TOKEN}\n`);
        return { stdout: "", stderr: "", exitCode: 0, success: true };
      },
      async readFile() {
        throw new Error("nope");
      },
      async destroy() {},
    };
    const { workflow } = parseCiWorkflow(wf(`      NPM_TOKEN: \${{ secrets.NPM_TOKEN }}`));
    const job = workflow!.jobs[0]!;
    const resolved = resolveJobEnv(job.env, secretLookupFromEnv({ CI_SECRET_NPM_TOKEN: "npm_s3cr3t_value" }));
    const scrub = makeScrubber(resolved.values);
    const logs: string[] = [];
    const res = await runJobSteps(sandbox, {
      job,
      env: resolved.env!,
      meta: { repo: "o--r", branch: "main", sha: "a".repeat(40) },
      log: (l) => logs.push(scrub(l)),
    });
    expect(res.ok).toBe(true);
    expect(seen[0]!.command).toBe("npm test");
    expect(seen[0]!.options?.env?.NPM_TOKEN).toBe("npm_s3cr3t_value");
    expect(JSON.stringify(logs)).not.toContain("npm_s3cr3t_value");
    expect(logs).toContain("  leak ***");
  });
});
