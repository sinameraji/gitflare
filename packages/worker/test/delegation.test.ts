import { describe, it, expect } from "vitest";
import { interpretDeployResponse } from "../src/ci/delegation";

const record = (over: Record<string, unknown> = {}) => ({
  id: 7,
  ref: "refs/heads/main",
  branch: "main",
  sha: "a".repeat(40),
  mode: "ci",
  startedAt: 0,
  status: "success",
  steps: [{ project: "my-worker", kind: "worker", ok: true }],
  logs: [],
  ...over,
});

describe("interpretDeployResponse — the four shapes a CI deploy job sees", () => {
  it("200 + status success → green job", () => {
    const out = interpretDeployResponse(true, 200, record());
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual([{ label: "worker: my-worker", ok: true }]);
    expect(out.message).toBeUndefined();
  });

  it('200 + status "skipped" → RED (a needs-gated deploy must actually ship)', () => {
    const out = interpretDeployResponse(true, 200, record({ status: "skipped", message: "CD not enabled — run `gitflare deploy enable`" }));
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/deploy skipped: .*CD not enabled/);
    // Steps still surface for context.
    expect(out.steps).toHaveLength(1);
  });

  it("200 + status failed → red with the record message", () => {
    const out = interpretDeployResponse(
      true,
      200,
      record({ status: "failed", message: "entry not found", steps: [{ project: "my-worker", kind: "worker", ok: false, detail: "entry not found" }] }),
    );
    expect(out.ok).toBe(false);
    expect(out.message).toMatch(/deploy #7 failed: entry not found/);
    expect(out.steps[0]).toEqual({ label: "worker: my-worker", ok: false, detail: "entry not found" });
  });

  it("non-200 (DeployDO threw) → red with the error string, no steps", () => {
    const out = interpretDeployResponse(false, 500, { ok: false, error: "boom" });
    expect(out.ok).toBe(false);
    expect(out.message).toBe("deploy failed: boom");
    expect(out.steps).toEqual([]);
  });

  it("non-200 with no error body falls back to the status code", () => {
    const out = interpretDeployResponse(false, 502, {});
    expect(out.message).toBe("deploy failed: 502");
  });
});
