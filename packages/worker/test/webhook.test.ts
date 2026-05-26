import { describe, it, expect } from "vitest";
import { verifyGithubSignature } from "../src/github/webhook";

const SECRET = "shhh";

async function signGithub(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  let hex = "";
  for (const b of new Uint8Array(mac)) hex += b.toString(16).padStart(2, "0");
  return `sha256=${hex}`;
}

describe("verifyGithubSignature", () => {
  it("accepts a valid signature", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signGithub(body, SECRET);
    expect(await verifyGithubSignature(body, sig, SECRET)).toBe(true);
  });

  it("rejects a tampered body", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signGithub(body, SECRET);
    expect(await verifyGithubSignature(body + "x", sig, SECRET)).toBe(false);
  });

  it("rejects the wrong secret", async () => {
    const body = JSON.stringify({ hello: "world" });
    const sig = await signGithub(body, "other");
    expect(await verifyGithubSignature(body, sig, SECRET)).toBe(false);
  });

  it("rejects malformed signature header", async () => {
    expect(await verifyGithubSignature("body", "not-sha256-prefixed", SECRET)).toBe(
      false,
    );
  });

  it("rejects empty signature", async () => {
    expect(await verifyGithubSignature("body", "", SECRET)).toBe(false);
  });
});
