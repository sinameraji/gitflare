import { describe, it, expect } from "vitest";
import { findDuplicateDeploy, isPushLikeMode } from "../src/deploy/dedupe";

const SHA = "c".repeat(40);
const rec = (o: Partial<{ id: number; branch: string; sha: string; mode: string; status: string }>) => ({
  id: 1, branch: "main", sha: SHA, mode: "push", status: "success", ...o,
});

describe("isPushLikeMode", () => {
  it("push, artifacts-push, and undefined (defaults to push) are push-like; others are not", () => {
    expect(isPushLikeMode("push")).toBe(true);
    expect(isPushLikeMode("artifacts-push")).toBe(true);
    expect(isPushLikeMode(undefined)).toBe(true);
    expect(isPushLikeMode("manual")).toBe(false);
    expect(isPushLikeMode("ci")).toBe(false);
    expect(isPushLikeMode("rollback")).toBe(false);
  });
});

describe("findDuplicateDeploy", () => {
  it("finds a terminal push-like deploy for the same branch+sha (either trigger)", () => {
    expect(findDuplicateDeploy([rec({ mode: "push" })], "main", SHA)?.id).toBe(1);
    expect(findDuplicateDeploy([rec({ mode: "artifacts-push", status: "failed", id: 7 })], "main", SHA)?.id).toBe(7);
  });
  it("ignores other branches, other shas, non-terminal, skipped, and explicit modes", () => {
    expect(findDuplicateDeploy([rec({ branch: "dev" })], "main", SHA)).toBeUndefined();
    expect(findDuplicateDeploy([rec({ sha: "d".repeat(40) })], "main", SHA)).toBeUndefined();
    expect(findDuplicateDeploy([rec({ status: "running" })], "main", SHA)).toBeUndefined();
    expect(findDuplicateDeploy([rec({ status: "skipped" })], "main", SHA)).toBeUndefined();
    expect(findDuplicateDeploy([rec({ mode: "manual" })], "main", SHA)).toBeUndefined();
    expect(findDuplicateDeploy([rec({ mode: "ci" })], "main", SHA)).toBeUndefined();
    expect(findDuplicateDeploy([rec({ mode: "rollback" })], "main", SHA)).toBeUndefined();
  });
  it("never matches a non-sha (manual runs carry an empty sha)", () => {
    expect(findDuplicateDeploy([rec({ sha: "" })], "main", "")).toBeUndefined();
  });
});
