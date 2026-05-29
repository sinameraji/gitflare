import { describe, it, expect, beforeEach } from "vitest";
import { verifyAccessJwt, _clearJwksCache, type Jwks } from "../src/access/jwt";

const TEAM = "myteam.cloudflareaccess.com";
const AUD = "test-aud-tag";
const ISS = `https://${TEAM}`;
const KID = "key-1";

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlJson(obj: unknown): string {
  return b64url(new TextEncoder().encode(JSON.stringify(obj)));
}

interface Keypair {
  privateKey: CryptoKey;
  jwks: Jwks;
}

async function makeKeypair(kid = KID): Promise<Keypair> {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as {
    n: string;
    e: string;
  };
  return {
    privateKey: pair.privateKey,
    jwks: { keys: [{ kid, kty: "RSA", alg: "RS256", n: jwk.n, e: jwk.e }] },
  };
}

async function signJwt(
  privateKey: CryptoKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: KID, typ: "JWT" },
): Promise<string> {
  const headerB64 = b64urlJson(header);
  const payloadB64 = b64urlJson(payload);
  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sig = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    signed,
  );
  return `${headerB64}.${payloadB64}.${b64url(new Uint8Array(sig))}`;
}

const NOW = 1_700_000_000;
function validPayload(over: Record<string, unknown> = {}) {
  return {
    aud: [AUD],
    iss: ISS,
    sub: "user-123",
    email: "sina@example.com",
    exp: NOW + 3600,
    nbf: NOW - 60,
    ...over,
  };
}

describe("verifyAccessJwt", () => {
  beforeEach(() => _clearJwksCache());

  it("accepts a valid token", async () => {
    const { privateKey, jwks } = await makeKeypair();
    const token = await signJwt(privateKey, validPayload());
    const claims = await verifyAccessJwt(token, {
      aud: AUD,
      teamDomain: TEAM,
      nowSeconds: NOW,
      fetchJwks: async () => jwks,
    });
    expect(claims).toEqual({ sub: "user-123", email: "sina@example.com" });
  });

  it("rejects an expired token", async () => {
    const { privateKey, jwks } = await makeKeypair();
    const token = await signJwt(privateKey, validPayload({ exp: NOW - 1 }));
    expect(
      await verifyAccessJwt(token, {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => jwks,
      }),
    ).toBeNull();
  });

  it("rejects the wrong aud", async () => {
    const { privateKey, jwks } = await makeKeypair();
    const token = await signJwt(privateKey, validPayload({ aud: ["other"] }));
    expect(
      await verifyAccessJwt(token, {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => jwks,
      }),
    ).toBeNull();
  });

  it("rejects the wrong issuer", async () => {
    const { privateKey, jwks } = await makeKeypair();
    const token = await signJwt(
      privateKey,
      validPayload({ iss: "https://evil.cloudflareaccess.com" }),
    );
    expect(
      await verifyAccessJwt(token, {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => jwks,
      }),
    ).toBeNull();
  });

  it("rejects a token signed by a different key", async () => {
    const signer = await makeKeypair();
    // Verifier is handed an unrelated public key under the same kid.
    const other = await makeKeypair();
    const token = await signJwt(signer.privateKey, validPayload());
    expect(
      await verifyAccessJwt(token, {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => other.jwks,
      }),
    ).toBeNull();
  });

  it("rejects an unknown kid", async () => {
    const { privateKey, jwks } = await makeKeypair();
    const token = await signJwt(privateKey, validPayload(), {
      alg: "RS256",
      kid: "unknown-kid",
      typ: "JWT",
    });
    expect(
      await verifyAccessJwt(token, {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => jwks,
      }),
    ).toBeNull();
  });

  it("rejects a non-RS256 alg", async () => {
    const { privateKey, jwks } = await makeKeypair();
    const token = await signJwt(privateKey, validPayload(), {
      alg: "none",
      kid: KID,
      typ: "JWT",
    });
    expect(
      await verifyAccessJwt(token, {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => jwks,
      }),
    ).toBeNull();
  });

  it("rejects a malformed token", async () => {
    const { jwks } = await makeKeypair();
    expect(
      await verifyAccessJwt("not.a.jwt.really", {
        aud: AUD,
        teamDomain: TEAM,
        nowSeconds: NOW,
        fetchJwks: async () => jwks,
      }),
    ).toBeNull();
  });
});
