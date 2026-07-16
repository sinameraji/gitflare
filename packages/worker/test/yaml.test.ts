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

describe("parseYaml block scalars", () => {
  it("parses `key: |` with a trailing newline kept", () => {
    const v = parseYaml(`
script: |
  npm ci
  npm test
after: done
`) as Record<string, unknown>;
    expect(v.script).toBe("npm ci\nnpm test\n");
    expect(v.after).toBe("done");
  });

  it("parses `key: |-` chomping trailing newlines", () => {
    const v = parseYaml(`script: |-\n  echo hi\n\n\nafter: 1\n`) as Record<string, unknown>;
    expect(v.script).toBe("echo hi");
    expect(v.after).toBe(1);
  });

  it("works on list-item maps (`- run: |`) and stops at sibling keys", () => {
    const v = parseYaml(`
steps:
  - run: |
      npm ci
      npm test
    name: tests
  - run: echo ok
`) as { steps: Array<Record<string, unknown>> };
    expect(v.steps[0]!.run).toBe("npm ci\nnpm test\n");
    expect(v.steps[0]!.name).toBe("tests");
    expect(v.steps[1]!.run).toBe("echo ok");
  });

  it("preserves inner indentation, blank lines, and # characters verbatim", () => {
    const v = parseYaml(`
script: |
  if true; then
    echo "#not a comment"
  fi

  echo after-blank
`) as Record<string, unknown>;
    expect(v.script).toBe('if true; then\n  echo "#not a comment"\nfi\n\necho after-blank\n');
  });

  it("rejects folded scalars with a hint", () => {
    expect(() => parseYaml("script: >\n  a\n  b\n")).toThrow(/folded.*use \|/);
  });
});
