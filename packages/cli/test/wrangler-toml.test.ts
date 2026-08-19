import { describe, it, expect } from "vitest";
import { tomlFor, queueNameFor, type DeployParams } from "../src/wrangler.js";

const base: DeployParams = {
  cloudflareApiToken: "t",
  accountId: "acct",
  workerName: "gitflare-o--r",
  artifactsNamespace: "gitflare",
  repoMap: { "o/r": { name: "o--r", remote: "https://acct.artifacts.cloudflare.net/git/gitflare/o--r.git" } },
};

describe("queueNameFor", () => {
  it("derives the events queue from the worker name (queue names accept --)", () => {
    expect(queueNameFor("gitflare-o--r")).toBe("gitflare-o--r-events");
  });
});

describe("tomlFor — sync (M9)", () => {
  it("emits no consumer block and no SYNC_ENABLED by default", () => {
    const t = tomlFor("worker.js", base, "0.4.0");
    expect(t).not.toContain("[[queues.consumers]]");
    expect(t).not.toContain("SYNC_ENABLED");
    expect(t).not.toContain("WORKER_URL");
  });
  it("emits the consumer block once provisioned, and SYNC_ENABLED only when enabled", () => {
    const provisioned = tomlFor("worker.js", { ...base, sync: { provisioned: true, enabled: false, queueName: "gitflare-o--r-events" } }, "0.4.0");
    expect(provisioned).toContain('[[queues.consumers]]\nqueue = "gitflare-o--r-events"');
    expect(provisioned).not.toContain("SYNC_ENABLED");
    const enabled = tomlFor("worker.js", { ...base, sync: { provisioned: true, enabled: true, queueName: "gitflare-o--r-events" } }, "0.4.0");
    expect(enabled).toContain('SYNC_ENABLED = "1"');
  });
  it("emits WORKER_URL when known", () => {
    const t = tomlFor("worker.js", { ...base, workerUrl: "https://gitflare-o--r.sub.workers.dev" }, "0.4.0");
    expect(t).toContain('WORKER_URL = "https://gitflare-o--r.sub.workers.dev"');
  });
  it("keeps the four DO migrations and core bindings regardless of sync", () => {
    const t = tomlFor("worker.js", { ...base, sync: { provisioned: true, enabled: true, queueName: "q" } }, "0.4.0");
    for (const cls of ["RepoDO", "DeployDO", "CiDO", "Sandbox"]) expect(t).toContain(`new_sqlite_classes = ["${cls}"]`);
    expect(t).toContain('binding = "ARTIFACTS"');
    expect(t).toContain('name = "REPO"');
    expect(t).not.toContain("[[containers]]"); // CI not provisioned here
  });
  it("orders the consumer block before migrations so the TOML stays valid", () => {
    const t = tomlFor("worker.js", { ...base, sync: { provisioned: true, enabled: true, queueName: "q" }, ci: { provisioned: true, enabled: true, instanceType: "standard-1" } }, "0.4.0");
    expect(t.indexOf("[[containers]]")).toBeLessThan(t.indexOf("[[queues.consumers]]"));
    expect(t.indexOf("[[queues.consumers]]")).toBeLessThan(t.indexOf("[[migrations]]"));
  });
});
