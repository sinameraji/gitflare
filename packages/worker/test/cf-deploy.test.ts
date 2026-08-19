import { describe, it, expect } from "vitest";
import {
  buildScriptUploadForm,
  bindingsArray,
  uploadWorkerScript,
  hashPagesFiles,
} from "../src/deploy/cf-deploy";
import type { WorkerBindings } from "../src/deploy/workflow";

function bindings(over: Partial<WorkerBindings> = {}): WorkerBindings {
  return { vars: {}, kv: [], r2: [], d1: [], durable_objects: [], services: [], ...over };
}

describe("bindingsArray", () => {
  it("maps each binding kind to its Workers metadata shape", () => {
    const arr = bindingsArray(
      bindings({
        vars: { API: "x" },
        kv: [{ binding: "CACHE", id: "k1" }],
        r2: [{ binding: "B", bucket_name: "bk" }],
        d1: [{ binding: "DB", database_id: "d1" }],
        durable_objects: [{ name: "DO", class_name: "MyDO" }],
        services: [{ binding: "SVC", service: "other" }],
      }),
    );
    expect(arr).toContainEqual({ type: "plain_text", name: "API", text: "x" });
    expect(arr).toContainEqual({ type: "kv_namespace", name: "CACHE", namespace_id: "k1" });
    expect(arr).toContainEqual({ type: "r2_bucket", name: "B", bucket_name: "bk" });
    expect(arr).toContainEqual({ type: "d1", name: "DB", id: "d1" });
    expect(arr).toContainEqual({ type: "durable_object_namespace", name: "DO", class_name: "MyDO" });
    expect(arr).toContainEqual({ type: "service", name: "SVC", service: "other" });
  });
});

describe("buildScriptUploadForm", () => {
  it("includes metadata with main_module + bindings and the module file", async () => {
    const form = buildScriptUploadForm({
      scriptName: "w",
      moduleFileName: "worker.js",
      code: "export default {}",
      bindings: bindings({ vars: { A: "1" } }),
    });
    const meta = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(meta.main_module).toBe("worker.js");
    expect(meta.bindings).toContainEqual({ type: "plain_text", name: "A", text: "1" });
    expect(await (form.get("worker.js") as File).text()).toContain("export default");
  });
});

describe("uploadWorkerScript", () => {
  it("PUTs the script, enables the workers.dev subdomain, and returns the URL", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fakeFetch = (async (u: string, init: RequestInit = {}) => {
      calls.push({ url: u, method: init.method ?? "GET", body: typeof init.body === "string" ? init.body : undefined });
      if (u.endsWith("/subdomain") && (init.method ?? "GET") === "GET") {
        // account subdomain lookup
        return new Response(JSON.stringify({ success: true, result: { subdomain: "myacct" } }), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await uploadWorkerScript({
      accountId: "acc",
      apiToken: "tok",
      upload: { scriptName: "w", moduleFileName: "worker.js", code: "x" },
      fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(true);
    // 1. the PUT upload
    const put = calls.find((c) => c.method === "PUT")!;
    expect(put.url).toContain("/accounts/acc/workers/scripts/w");
    // 2. the subdomain-enable POST (without it the worker 404s)
    const enable = calls.find((c) => c.method === "POST" && c.url.endsWith("/scripts/w/subdomain"))!;
    expect(enable).toBeTruthy();
    expect(JSON.parse(enable.body!)).toMatchObject({ enabled: true });
    // 3. the URL resolved from the account subdomain
    expect(r.url).toBe("https://w.myacct.workers.dev");
  });

  it("surfaces API errors and does NOT try to enable the subdomain on a failed upload", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (u: string, init: RequestInit = {}) => {
      calls.push(`${init.method ?? "GET"} ${u}`);
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: "bad" }] }), { status: 400 });
    }) as unknown as typeof fetch;
    const r = await uploadWorkerScript({
      accountId: "a",
      apiToken: "t",
      upload: { scriptName: "w", moduleFileName: "worker.js", code: "x" },
      fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("bad");
    // Only the PUT ran — no subdomain calls after a failed upload.
    expect(calls).toEqual(["PUT https://api.cloudflare.com/client/v4/accounts/a/workers/scripts/w"]);
  });
});

describe("hashPagesFiles", () => {
  it("builds a manifest of site path → content digest", async () => {
    const enc = new TextEncoder();
    const { manifest, byHash } = await hashPagesFiles([
      { path: "index.html", bytes: enc.encode("<h1>hi</h1>"), contentType: "text/html" },
      { path: "assets/app.js", bytes: enc.encode("console.log(1)"), contentType: "application/javascript" },
    ]);
    expect(Object.keys(manifest)).toEqual(["/index.html", "/assets/app.js"]);
    // Each manifest hash resolves back to a file.
    for (const hash of Object.values(manifest)) {
      expect(byHash.has(hash)).toBe(true);
    }
    // Identical content → identical digest (dedup works).
    const same = await hashPagesFiles([
      { path: "a.txt", bytes: enc.encode("dup"), contentType: "text/plain" },
      { path: "b.txt", bytes: enc.encode("dup"), contentType: "text/plain" },
    ]);
    expect(same.manifest["/a.txt"]).toBe(same.manifest["/b.txt"]);
  });
  it("emits 32-hex asset keys that depend on the extension (Pages serves 500 on any other key length — verified live)", async () => {
    const enc = new TextEncoder();
    const bytes = enc.encode("<h1>hi</h1>");
    const { manifest } = await hashPagesFiles([
      { path: "index.html", bytes, contentType: "text/html" },
      { path: "index.txt", bytes, contentType: "text/plain" },
    ]);
    for (const k of Object.values(manifest)) expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(manifest["/index.html"]).not.toBe(manifest["/index.txt"]);
  });
});
