import { describe, it, expect } from "vitest";
import { computeBlame, mapLines, splitLines, toHunks, type BlameCommit, type BlameVersion } from "../src/blame/algorithm";
import { splitHighlightedLines, highlightCode } from "../src/ui/highlight";

const C = (n: number): BlameCommit => ({
  sha: n.toString(16).padStart(40, "0"),
  subject: `commit ${n}`,
  authorName: `A${n}`,
  authorEmail: `a${n}@x`,
  timestamp: n * 1000,
});
const V = (n: number, lines: string[]): BlameVersion => ({ commit: C(n), text: lines.map((l) => l + "\n").join("") });
/** sha-number per final line ("^" prefix for boundary). */
const who = (versions: BlameVersion[], truncated = false): string[] => {
  const r = computeBlame(versions, { truncated });
  return r.lines.map((l) => (l.boundary ? "^" : "") + r.commits[l.commit]!.subject.replace("commit ", ""));
};

describe("splitLines", () => {
  it("counts a trailing newline as ending the last line", () => {
    expect(splitLines("")).toEqual([]);
    expect(splitLines("a")).toEqual(["a"]);
    expect(splitLines("a\n")).toEqual(["a"]);
    expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
  });
});

describe("computeBlame", () => {
  it("file creation: every line belongs to the creating commit", () => {
    expect(who([V(1, ["a", "b", "c"])])).toEqual(["1", "1", "1"]);
  });

  it("additions are blamed on the commit that added them", () => {
    const v = [V(3, ["a", "x", "b", "c", "y"]), V(2, ["a", "b", "c", "y"]), V(1, ["a", "b", "c"])];
    expect(who(v)).toEqual(["1", "3", "1", "1", "2"]);
  });

  it("deletions leave the surviving lines with their origin", () => {
    const v = [V(2, ["a", "c"]), V(1, ["a", "b", "c"])];
    expect(who(v)).toEqual(["1", "1"]);
    expect(computeBlame(v).lines.map((l) => l.origLine)).toEqual([1, 3]);
  });

  it("a modified line is blamed on the modifying commit", () => {
    const v = [V(2, ["a", "B", "c"]), V(1, ["a", "b", "c"])];
    expect(who(v)).toEqual(["1", "2", "1"]);
  });

  it("a moved block keeps its origin (git blame -M style)", () => {
    const fn1 = ["function alpha() {", "  return computeSomething(1);", "}"];
    const fn2 = ["function beta() {", "  return computeSomethingElse(2);", "}"];
    const v = [V(2, [...fn2, ...fn1]), V(1, [...fn1, ...fn2])];
    const r = who(v);
    // Every line with real content keeps commit 1. A bare "}" carries too little
    // content to count as moved on its own (same threshold as git's -M), so the
    // diff may pair it with either function's brace.
    expect([r[0], r[1], r[3], r[4]]).toEqual(["1", "1", "1", "1"]);
    expect(r.filter((x) => x === "2").length).toBeLessThanOrEqual(1);
  });

  it("a tiny moved line (below the content threshold) counts as new", () => {
    const v = [V(2, ["}", "a long line with plenty of content here", "x"]), V(1, ["a long line with plenty of content here", "x", "}"])];
    expect(who(v)).toEqual(["2", "1", "1"]);
  });

  it("re-adding a deleted line attributes it to the re-adding commit", () => {
    const v = [V(3, ["a", "b"]), V(2, ["a"]), V(1, ["a", "b"])];
    expect(who(v)).toEqual(["1", "3"]);
  });

  it("truncated history marks surviving lines as boundary", () => {
    const v = [V(5, ["a", "new"]), V(4, ["a"])];
    expect(who(v, true)).toEqual(["^4", "5"]);
    expect(who(v, false)).toEqual(["4", "5"]);
  });

  it("an empty file blames nothing", () => {
    expect(computeBlame([V(1, [])]).lines).toEqual([]);
    expect(computeBlame([]).lines).toEqual([]);
  });

  it("commits are listed once, in first-appearance order", () => {
    const v = [V(2, ["x", "a", "y"]), V(1, ["a"])];
    const r = computeBlame(v);
    expect(r.commits.map((c) => c.subject)).toEqual(["commit 2", "commit 1"]);
  });

  it("past the edit-distance budget a rewrite is new, but identical blocks still trace back", () => {
    const old = Array.from({ length: 50 }, (_, i) => `old line number ${i} with some text`);
    const kept = old.slice(10, 20);
    const cur = [...Array.from({ length: 30 }, (_, i) => `brand new ${i}`), ...kept];
    const v = [V(2, cur), V(1, old)];
    const r = who(v);
    expect(r.slice(0, 30).every((x) => x === "2")).toBe(true);
    expect(r.slice(30).every((x) => x === "1")).toBe(true);
    // Same answer with a tiny budget: the move pass recovers the kept block.
    const tight = computeBlame(v, { maxEditDistance: 2 });
    expect(tight.lines.slice(30).every((l) => tight.commits[l.commit]!.sha === C(1).sha)).toBe(true);
  });

  it("handles a long linear history", () => {
    const versions: BlameVersion[] = [];
    let lines: string[] = [];
    const snaps: string[][] = [];
    for (let i = 1; i <= 60; i++) {
      lines = [...lines, `line from ${i}`];
      snaps.push(lines);
    }
    for (let i = 60; i >= 1; i--) versions.push(V(i, snaps[i - 1]!));
    expect(who(versions)).toEqual(Array.from({ length: 60 }, (_, i) => String(i + 1)));
  });
});

describe("mapLines", () => {
  it("matches an LCS through interleaved edits", () => {
    const m = Array.from(mapLines(["a", "x", "b", "y", "c"], ["a", "b", "c"]));
    expect(m).toEqual([0, -1, 1, -1, 2]);
  });
  it("handles empty sides", () => {
    expect(Array.from(mapLines([], ["a"]))).toEqual([]);
    expect(Array.from(mapLines(["a"], []))).toEqual([-1]);
  });
});

describe("toHunks", () => {
  it("groups consecutive lines from the same commit", () => {
    const r = computeBlame([V(2, ["a", "b", "x", "y", "c"]), V(1, ["a", "b", "c"])]);
    expect(toHunks(r.lines).map((h) => [h.start, h.length])).toEqual([
      [0, 2],
      [2, 2],
      [4, 1],
    ]);
  });
});

describe("splitHighlightedLines", () => {
  it("closes and reopens spans across newlines", () => {
    const out = splitHighlightedLines('<span class="c">/* a\nb */</span>\nx');
    expect(out).toEqual(['<span class="c">/* a</span>', '<span class="c">b */</span>', "x"]);
  });
  it("yields one fragment per source line for real hljs output", () => {
    const src = "const a = `x\ny`;\n/* c\nd */\nlet b = 1;\n";
    const hl = highlightCode(src, "f.ts")!;
    const frags = splitHighlightedLines(hl.html);
    expect(frags.length).toBe(src.split("\n").length);
    for (const f of frags) {
      expect((f.match(/<span/g) ?? []).length).toBe((f.match(/<\/span>/g) ?? []).length);
    }
  });
});
