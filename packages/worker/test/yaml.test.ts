import { describe, it, expect } from "vitest";
import { parseYaml } from "../src/deploy/yaml";

describe("parseYaml", () => {
  it("parses scalars, inline lists, and nested maps", () => {
    const v = parseYaml(`
on: push
branches: [main, release]
count: 3
flag: true
nested:
  a: 1
  b: hello
`) as Record<string, unknown>;
    expect(v.on).toBe("push");
    expect(v.branches).toEqual(["main", "release"]);
    expect(v.count).toBe(3);
    expect(v.flag).toBe(true);
    expect(v.nested).toEqual({ a: 1, b: "hello" });
  });

  it("parses a list of maps (inline and block)", () => {
    const v = parseYaml(`
kv:
  - { binding: CACHE, id: abc }
  - binding: OTHER
    id: def
`) as { kv: Array<Record<string, unknown>> };
    expect(v.kv).toEqual([
      { binding: "CACHE", id: "abc" },
      { binding: "OTHER", id: "def" },
    ]);
  });

  it("parses deeply nested structures (steps → map → list)", () => {
    const v = parseYaml(`
steps:
  - cloudflare/deploy:
      project: api
      vars:
        A: "1"
      d1:
        - binding: DB
          database_id: db1
`) as { steps: Array<Record<string, unknown>> };
    const cfg = v.steps[0]!["cloudflare/deploy"] as Record<string, unknown>;
    expect(cfg.project).toBe("api");
    expect(cfg.vars).toEqual({ A: "1" });
    expect(cfg.d1).toEqual([{ binding: "DB", database_id: "db1" }]);
  });

  it("ignores comments and blank lines", () => {
    const v = parseYaml(`# header\non: push  # inline\n\nkind: worker\n`) as Record<string, unknown>;
    expect(v).toEqual({ on: "push", kind: "worker" });
  });

  it("keeps '#' inside quoted strings", () => {
    const v = parseYaml(`color: "#F38020"\n`) as Record<string, unknown>;
    expect(v.color).toBe("#F38020");
  });
});
