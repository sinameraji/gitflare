import { describe, it, expect } from "vitest";
import { buildScriptUploadForm, uploadWorkerScript } from "../src/deploy/cf-deploy";

describe("buildScriptUploadForm", () => {
  it("includes metadata referencing the module and the module file", async () => {
    const form = buildScriptUploadForm({
      scriptName: "my-worker",
      moduleFileName: "worker.js",
      code: "export default { fetch(){return new Response('hi')} }",
    });
    const metaBlob = form.get("metadata") as Blob;
    const meta = JSON.parse(await metaBlob.text());
    expect(meta.main_module).toBe("worker.js");
    expect(meta.compatibility_date).toBeTruthy();

    const mod = form.get("worker.js") as File;
    expect(await mod.text()).toContain("export default");
  });
});

describe("uploadWorkerScript", () => {
  it("PUTs to the scripts API with bearer auth and reports success", async () => {
    let seenUrl = "";
    let seenAuth = "";
    let seenMethod = "";
    const fakeFetch = (async (url: string, init: RequestInit) => {
      seenUrl = url;
      seenMethod = init.method ?? "";
      seenAuth = (init.headers as Record<string, string>).Authorization ?? "";
      return new Response(JSON.stringify({ success: true, errors: [] }), { status: 200 });
    }) as unknown as typeof fetch;

    const r = await uploadWorkerScript({
      accountId: "acc123",
      apiToken: "tok456",
      upload: { scriptName: "w", moduleFileName: "worker.js", code: "x" },
      fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(true);
    expect(seenMethod).toBe("PUT");
    expect(seenUrl).toContain("/accounts/acc123/workers/scripts/w");
    expect(seenAuth).toBe("Bearer tok456");
  });

  it("surfaces API errors", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ success: false, errors: [{ code: 10001, message: "bad" }] }), {
        status: 400,
      })) as unknown as typeof fetch;
    const r = await uploadWorkerScript({
      accountId: "a",
      apiToken: "t",
      upload: { scriptName: "w", moduleFileName: "worker.js", code: "x" },
      fetchImpl: fakeFetch,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("bad");
  });
});
