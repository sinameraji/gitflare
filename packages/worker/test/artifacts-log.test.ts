import { describe, it, expect } from "vitest";
import { parseArtifactsLog } from "../src/artifacts/content";

const entry = { hash: "a".repeat(40), treeHash: "b".repeat(40), message: "feat: x\n\nbody", author: { name: "A", email: "a@x" }, committer: { name: "C", email: "c@x" }, parents: ["c".repeat(40)], authoredAt: 1700000000, committedAt: 1700000001 };

describe("parseArtifactsLog", () => {
  it("accepts a bare array (binding) and an envelope (REST result)", () => {
    expect(parseArtifactsLog([entry])?.[0]?.hash).toBe(entry.hash);
    expect(parseArtifactsLog({ result: [entry] })?.[0]?.author.name).toBe("A");
    expect(parseArtifactsLog({ commits: [entry] })?.length).toBe(1);
  });
  it("rejects shapes it can't trust", () => {
    expect(parseArtifactsLog(null)).toBeNull();
    expect(parseArtifactsLog("[object JsRpcProperty]")).toBeNull();
    expect(parseArtifactsLog([{ nope: 1 }])).toBeNull();
    expect(parseArtifactsLog({ result: "x" })).toBeNull();
  });
  it("normalises optional fields", () => {
    const e = parseArtifactsLog([{ hash: entry.hash, message: "m", parents: undefined, committedAt: 5 }])![0]!;
    expect(e.parents).toEqual([]);
    expect(e.author).toEqual({ name: "", email: "" });
    expect(e.authoredAt).toBe(5);
  });
});
