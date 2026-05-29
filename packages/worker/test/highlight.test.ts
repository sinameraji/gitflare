import { describe, it, expect } from "vitest";
import { highlightCode } from "../src/ui/highlight";

describe("highlightCode", () => {
  it("highlights a known extension", () => {
    const r = highlightCode("const x: number = 1;", "src/index.ts");
    expect(r).not.toBeNull();
    expect(r!.lang).toBe("typescript");
    expect(r!.html).toContain("hljs-");
  });

  it("maps by full filename (Dockerfile)", () => {
    const r = highlightCode("FROM node:20\nRUN npm ci", "Dockerfile");
    expect(r?.lang).toBe("dockerfile");
  });

  it("returns null for an unknown extension", () => {
    expect(highlightCode("whatever", "notes.xyz")).toBeNull();
  });

  it("returns null for a file with no extension", () => {
    expect(highlightCode("plain text", "LICENSE")).toBeNull();
  });

  it("returns null for very large input", () => {
    const big = "a".repeat(512 * 1024 + 1);
    expect(highlightCode(big, "big.js")).toBeNull();
  });

  it("escapes HTML so output is injection-safe", () => {
    const r = highlightCode("const s = '<script>';", "x.js");
    expect(r).not.toBeNull();
    expect(r!.html).not.toContain("<script>");
    expect(r!.html).toContain("&lt;script&gt;");
  });
});
