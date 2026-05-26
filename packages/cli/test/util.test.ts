import { describe, it, expect } from "vitest";
import { parseGithubUrl, artifactsRepoNameFor, randomHex } from "../src/util";

describe("parseGithubUrl", () => {
  it("handles plain owner/repo", () => {
    expect(parseGithubUrl("sina/kimiflare")).toEqual({ owner: "sina", repo: "kimiflare" });
  });
  it("handles github.com prefix", () => {
    expect(parseGithubUrl("github.com/sina/kimiflare")).toEqual({ owner: "sina", repo: "kimiflare" });
  });
  it("handles https URL", () => {
    expect(parseGithubUrl("https://github.com/sina/kimiflare")).toEqual({ owner: "sina", repo: "kimiflare" });
  });
  it("handles SSH URL with .git suffix", () => {
    expect(parseGithubUrl("git@github.com:sina/kimiflare.git")).toEqual({ owner: "sina", repo: "kimiflare" });
  });
  it("rejects bad input", () => {
    expect(() => parseGithubUrl("just-a-name")).toThrow();
  });
});

describe("artifactsRepoNameFor", () => {
  it("joins owner and repo with --", () => {
    expect(artifactsRepoNameFor("sina", "kimiflare")).toBe("sina--kimiflare");
  });
  it("lowercases", () => {
    expect(artifactsRepoNameFor("Sina", "KimiFlare")).toBe("sina--kimiflare");
  });
  it("sanitizes weird chars", () => {
    expect(artifactsRepoNameFor("foo.bar", "baz_qux")).toBe("foo-bar--baz-qux");
  });
});

describe("randomHex", () => {
  it("produces 2n hex chars", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{32}$/);
  });
  it("is non-deterministic", () => {
    expect(randomHex(16)).not.toBe(randomHex(16));
  });
});
