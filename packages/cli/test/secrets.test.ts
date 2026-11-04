import { describe, it, expect, vi, afterEach } from "vitest";
import { Readable } from "node:stream";
import {
  CI_SECRET_PREFIX,
  MAX_SECRET_BYTES,
  ciSecretNames,
  normalizeSecretName,
  readAll,
  validateSecretValue,
  valueFromStdin,
  workerSecretName,
} from "../src/secrets.js";
import { CloudflareClient } from "../src/cloudflare.js";
import {
  CI_SECRET_PREFIX as WORKER_PREFIX,
  secretEnvName,
  secretLookupFromEnv,
  validateSecretName,
} from "../../worker/src/ci/secrets";

describe("secret names", () => {
  it("canonicalises to upper case and rejects bad names", () => {
    expect(normalizeSecretName(" npm_token ")).toEqual({ name: "NPM_TOKEN" });
    expect(normalizeSecretName("9LIVES").error).toMatch(/invalid/);
    expect(normalizeSecretName("A-B").error).toMatch(/invalid/);
    expect(normalizeSecretName("").error).toMatch(/empty/);
  });
  it("agrees with the Worker on prefix, storage name and validity", () => {
    expect(CI_SECRET_PREFIX).toBe(WORKER_PREFIX);
    for (const n of ["NPM_TOKEN", "npm_token", "_X", "A1", "1A", "A-B", "A B", "A".repeat(100), "A".repeat(101)]) {
      expect(normalizeSecretName(n).error === undefined, n).toBe(validateSecretName(n) === null);
      if (!normalizeSecretName(n).error) expect(workerSecretName(n)).toBe(secretEnvName(n));
    }
    // What the CLI stores is exactly what the Worker's runner looks up.
    const env = { [workerSecretName("npm_token")]: "v" };
    expect(secretLookupFromEnv(env)("NPM_TOKEN")).toBe("v");
  });
  it("lists only CI secrets, prefix stripped, sorted", () => {
    expect(
      ciSecretNames([
        { name: "CONTROL_SECRET" },
        { name: "CI_SECRET_ZED" },
        { name: "GITHUB_TOKEN" },
        { name: "CI_SECRET_ALPHA" },
        { name: "CI_SECRET_" },
      ]),
    ).toEqual(["ALPHA", "ZED"]);
  });
});

describe("secret values", () => {
  it("strips exactly one trailing newline from stdin", () => {
    expect(valueFromStdin("abc\n")).toBe("abc");
    expect(valueFromStdin("abc\r\n")).toBe("abc");
    expect(valueFromStdin("abc\n\n")).toBe("abc\n");
    expect(valueFromStdin(" abc ")).toBe(" abc ");
    expect(valueFromStdin("-----BEGIN-----\nk\n-----END-----\n")).toBe("-----BEGIN-----\nk\n-----END-----");
  });
  it("rejects empty and oversize values (byte length, not chars)", () => {
    expect(validateSecretValue("")).toMatch(/empty/);
    expect(validateSecretValue("x")).toBeNull();
    expect(validateSecretValue("x".repeat(MAX_SECRET_BYTES))).toBeNull();
    expect(validateSecretValue("é".repeat(MAX_SECRET_BYTES / 2 + 1))).toMatch(/limit/);
  });
  it("reads a piped stream fully", async () => {
    expect(await readAll(Readable.from([Buffer.from("ab"), "c\n"]))).toBe("abc\n");
  });
});

describe("CloudflareClient Worker Secrets", () => {
  afterEach(() => vi.unstubAllGlobals());

  function stubFetch(result: unknown) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, errors: [], result }), { status: 200 });
    });
    return calls;
  }

  it("puts the value in the JSON body (never the URL) as secret_text", async () => {
    const calls = stubFetch({});
    await new CloudflareClient("tok").putWorkerSecret("acct", "owner--repo", "CI_SECRET_NPM_TOKEN", "s3cr3t");
    expect(calls[0]!.url).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/owner--repo/secrets");
    expect(calls[0]!.url).not.toContain("s3cr3t");
    expect(calls[0]!.init.method).toBe("PUT");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ name: "CI_SECRET_NPM_TOKEN", text: "s3cr3t", type: "secret_text" });
  });
  it("lists and deletes by name", async () => {
    const calls = stubFetch([{ name: "CI_SECRET_A", type: "secret_text" }]);
    const c = new CloudflareClient("tok");
    expect(await c.listWorkerSecrets("acct", "w")).toEqual([{ name: "CI_SECRET_A", type: "secret_text" }]);
    await c.deleteWorkerSecret("acct", "w", "CI_SECRET_A");
    expect(calls[1]!.init.method).toBe("DELETE");
    expect(calls[1]!.url).toMatch(/\/workers\/scripts\/w\/secrets\/CI_SECRET_A$/);
  });
});
