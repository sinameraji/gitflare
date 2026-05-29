// Verifies a Cloudflare Access application token (the `Cf-Access-Jwt-Assertion`
// header Access injects after a successful login). Access tokens are RS256-signed
// JWTs; we verify them with WebCrypto only — no `jose`, to keep the bundle small
// (this worker is esbuild-bundled into the CLI's dist/). Mirrors the crypto.subtle
// idiom in ../github/webhook.ts.

export interface AccessClaims {
  /** Subject — the Access user id. */
  sub: string;
  /** Email of the authenticated identity, when present. */
  email?: string;
}

export interface VerifyOptions {
  /** The Access application AUD tag(s) this worker accepts. */
  aud: string;
  /** Team auth domain, e.g. "myteam.cloudflareaccess.com" (no scheme). */
  teamDomain: string;
  /** Current time in seconds; injectable for tests. Defaults to now. */
  nowSeconds?: number;
  /** Override the JWKS fetch; injectable for tests. */
  fetchJwks?: (certsUrl: string) => Promise<Jwks>;
}

interface JwtHeader {
  alg: string;
  kid?: string;
}

interface JwtPayload {
  aud?: string | string[];
  iss?: string;
  exp?: number;
  nbf?: number;
  sub?: string;
  email?: string;
}

export interface Jwk {
  kid: string;
  kty: string;
  alg?: string;
  n: string;
  e: string;
  use?: string;
}

export interface Jwks {
  keys: Jwk[];
}

// Cache JWKS per team domain in module scope. Access rotates keys rarely; we
// re-fetch on a kid miss so rotation self-heals.
const jwksCache = new Map<string, { keys: Jwk[]; fetchedAt: number }>();
const JWKS_TTL_MS = 60 * 60 * 1000; // 1h

function certsUrlFor(teamDomain: string): string {
  return `https://${teamDomain}/cdn-cgi/access/certs`;
}

async function defaultFetchJwks(certsUrl: string): Promise<Jwks> {
  const res = await fetch(certsUrl);
  if (!res.ok) throw new Error(`JWKS fetch ${certsUrl} → ${res.status}`);
  return (await res.json()) as Jwks;
}

async function resolveKey(
  teamDomain: string,
  kid: string,
  fetchJwks: (certsUrl: string) => Promise<Jwks>,
): Promise<Jwk | null> {
  const cached = jwksCache.get(teamDomain);
  const fresh = cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS;
  const hit = fresh ? cached!.keys.find((k) => k.kid === kid) : undefined;
  if (hit) return hit;

  // Miss (cold, stale, or key rotation) — fetch fresh.
  const jwks = await fetchJwks(certsUrlFor(teamDomain));
  jwksCache.set(teamDomain, { keys: jwks.keys ?? [], fetchedAt: Date.now() });
  return jwks.keys?.find((k) => k.kid === kid) ?? null;
}

/**
 * Verify a Cloudflare Access JWT. Returns the claims on success, or null on any
 * failure (bad signature, expired, wrong aud/iss, unknown key, malformed).
 * Never throws on an untrusted token — only the caller decides what to do.
 */
export async function verifyAccessJwt(
  token: string,
  opts: VerifyOptions,
): Promise<AccessClaims | null> {
  const fetchJwks = opts.fetchJwks ?? defaultFetchJwks;
  const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);

  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: JwtHeader;
  let payload: JwtPayload;
  try {
    header = JSON.parse(decodeUtf8(base64urlToBytes(headerB64))) as JwtHeader;
    payload = JSON.parse(decodeUtf8(base64urlToBytes(payloadB64))) as JwtPayload;
  } catch {
    return null;
  }

  if (header.alg !== "RS256" || !header.kid) return null;

  // Claim checks before the expensive crypto.
  const expectedIss = `https://${opts.teamDomain}`;
  if (payload.iss !== expectedIss) return null;
  const auds = Array.isArray(payload.aud)
    ? payload.aud
    : payload.aud
      ? [payload.aud]
      : [];
  if (!auds.includes(opts.aud)) return null;
  if (typeof payload.exp === "number" && now >= payload.exp) return null;
  if (typeof payload.nbf === "number" && now < payload.nbf) return null;
  if (!payload.sub) return null;

  const jwk = await resolveKey(opts.teamDomain, header.kid, fetchJwks);
  if (!jwk || jwk.kty !== "RSA") return null;

  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    return null;
  }

  const signed = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      base64urlToBytes(sigB64),
      signed,
    );
  } catch {
    return null;
  }
  if (!valid) return null;

  return payload.email !== undefined
    ? { sub: payload.sub, email: payload.email }
    : { sub: payload.sub };
}

function base64urlToBytes(input: string): Uint8Array<ArrayBuffer> {
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const bin = atob(b64 + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

// Exposed for tests that want a clean cache between cases.
export function _clearJwksCache(): void {
  jwksCache.clear();
}
