import { describe, it, expect } from "vitest";
import {
  issueFromGithub, pullFromGithub, commentFromGithub, reviewFromGithub, releaseFromGithub,
  issueKey, pullKey, commentKey, releaseKey, linkifyReferences, numberFromIssueUrl, MAX_BODY_CHARS,
} from "../src/meta/map";

const ghIssue = {
  number: 42, title: "Bug", state: "open", user: { login: "alice", avatar_url: "https://a/x.png" },
  labels: [{ name: "bug", color: "d73a4a" }, { name: "p1", color: "fbca04" }], body: "See #7 and `#8` and\n```\n#9\n```",
  created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-02T00:00:00Z", closed_at: null, comments: 3,
  html_url: "https://github.com/o/r/issues/42", milestone: { title: "v1" },
};

describe("issueFromGithub / pullFromGithub", () => {
  it("maps an issue and flags PR-shaped issues", () => {
    const i = issueFromGithub(ghIssue)!;
    expect(i.number).toBe(42);
    expect(i.state).toBe("open");
    expect(i.labels.map((l) => l.name)).toEqual(["bug", "p1"]);
    expect(i.milestone).toBe("v1");
    expect(i.isPull).toBe(false);
    expect(issueFromGithub({ ...ghIssue, pull_request: { url: "x" } })!.isPull).toBe(true);
    expect(issueFromGithub({})).toBeNull();
  });
  it("maps a PR incl. merged/draft/head/base and derives merged from merged_at", () => {
    const p = pullFromGithub({ ...ghIssue, number: 43, merged_at: "2026-08-03T00:00:00Z", draft: false, head: { ref: "feat", sha: "a".repeat(40), repo: { full_name: "o/r" } }, base: { ref: "main" }, additions: 10, deletions: 2, changed_files: 3, comments: 1 })!;
    expect(p.isPull).toBe(true);
    expect(p.merged).toBe(true);
    expect(p.head).toEqual({ ref: "feat", sha: "a".repeat(40), repo: "o/r" });
    expect(p.base.ref).toBe("main");
    expect(p.additions).toBe(10);
    expect(p.commentsCount).toBe(1);
  });
  it("caps very long bodies", () => {
    const i = issueFromGithub({ ...ghIssue, body: "x".repeat(MAX_BODY_CHARS + 5) })!;
    expect(i.body.length).toBe(MAX_BODY_CHARS);
    expect(i.bodyTruncated).toBe(true);
  });
});

describe("comments / reviews / releases", () => {
  it("maps a comment (issue number from arg or issue_url)", () => {
    const c = commentFromGithub({ id: 9, user: { login: "bob" }, body: "hi", created_at: "2026-08-01T00:00:00Z", updated_at: "2026-08-01T00:00:00Z", html_url: "u", issue_url: "https://api.github.com/repos/o/r/issues/42" })!;
    expect(c.issueNumber).toBe(42);
    expect(c.kind).toBe("comment");
    expect(commentFromGithub({ id: 9, body: "x" }, 5)!.issueNumber).toBe(5);
    expect(commentFromGithub({ id: 9, body: "x" })).toBeNull();
  });
  it("maps a review with its verdict", () => {
    const r = reviewFromGithub({ id: 3, user: { login: "carol" }, body: "", state: "APPROVED", submitted_at: "2026-08-01T00:00:00Z", commit_id: "b".repeat(40), html_url: "u" }, 43)!;
    expect(r.kind).toBe("review");
    expect(r.reviewState).toBe("approved");
    expect(r.issueNumber).toBe(43);
  });
  it("maps a release with assets", () => {
    const r = releaseFromGithub({ id: 1, tag_name: "v1.0.0", name: "", body: "notes", draft: false, prerelease: true, created_at: "2026-08-01T00:00:00Z", published_at: "2026-08-01T01:00:00Z", html_url: "u", author: { login: "alice" }, assets: [{ name: "a.zip", size: 2048, browser_download_url: "d" }] })!;
    expect(r.name).toBe("v1.0.0"); // falls back to tag
    expect(r.prerelease).toBe(true);
    expect(r.assets).toEqual([{ name: "a.zip", size: 2048, downloadUrl: "d" }]);
  });
});

describe("keys + helpers", () => {
  it("zero-pads keys so prefix listing is ordered", () => {
    expect(issueKey(7)).toBe("issue:00000007");
    expect(pullKey(123)).toBe("pull:00000123");
    expect(commentKey(7, 5, 9)).toBe("comment:00000007:000000000000005:9");
    expect(releaseKey(5, 9)).toBe("release:000000000000005:9");
    expect(issueKey(7) < issueKey(10)).toBe(true);
  });
  it("numberFromIssueUrl handles issues and pulls", () => {
    expect(numberFromIssueUrl("https://api.github.com/repos/o/r/issues/12")).toBe(12);
    expect(numberFromIssueUrl("https://api.github.com/repos/o/r/pulls/13")).toBe(13);
    expect(numberFromIssueUrl("nope")).toBeUndefined();
  });
  it("linkifyReferences links #N outside code, choosing issues vs pulls", () => {
    const out = linkifyReferences("See #7 and `#8` and\n```\n#9\n```\n(#10)", "/r/x", (n) => n === 10);
    expect(out).toContain("[#7](/r/x/issues/7)");
    expect(out).toContain("`#8`");
    expect(out).toContain("\n#9\n");
    expect(out).toContain("([#10](/r/x/pulls/10))");
  });
});
