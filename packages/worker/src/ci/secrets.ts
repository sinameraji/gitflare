// CI secrets (M10). Stored as Worker Secrets named `CI_SECRET_<NAME>` by
// `gitflare secrets set` (Cloudflare encrypts them at rest; their values can
// never be read back through the API or dashboard). The CI runner reads them
// from the Worker env at run time and hands them to the sandbox through the
// exec env only — never argv, never a file — and scrubs them from logs.
//
// ci.yml surface: `${{ secrets.NAME }}` is allowed in a run job's `env:`
// values (alone or embedded, e.g. `Bearer ${{ secrets.TOKEN }}`). It is a
// parse error anywhere else we'd have to splice it into a command line.
// Other `${{ … }}` expressions are left verbatim, as before.

/** Worker Secret name prefix — keeps CI secrets apart from CONTROL_SECRET & co. */
export const CI_SECRET_PREFIX = "CI_SECRET_";

/** Canonical secret names: like GitHub's — letters, digits, `_`, no leading digit. */
export const SECRET_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_SECRET_NAME_LENGTH = 100;

/** Any `${{ secrets.… }}` — loosely, so malformed refs are caught, not ignored. */
const LOOSE_REF_RE = /\$\{\{\s*secrets\s*\.([^}]*?)\s*\}\}/g;
/** Something that starts like a secrets ref but never closes `}}`. */
const UNCLOSED_REF_RE = /\$\{\{\s*secrets\s*\./;

/**
 * GitHub treats secret names case-insensitively; so do we, by canonicalising
 * to upper case everywhere (CLI storage and ci.yml resolution).
 */
export function canonicalSecretName(name: string): string {
  return name.toUpperCase();
}

export function validateSecretName(name: string): string | null {
  if (!name) return "secret name is empty";
  if (name.length > MAX_SECRET_NAME_LENGTH) return `secret name longer than ${MAX_SECRET_NAME_LENGTH} chars`;
  if (!SECRET_NAME_RE.test(name)) {
    return `invalid secret name "${name.slice(0, 60)}" (letters, digits and _ only; must not start with a digit)`;
  }
  return null;
}

export function secretEnvName(name: string): string {
  return `${CI_SECRET_PREFIX}${canonicalSecretName(name)}`;
}

/**
 * The (canonical) secret names referenced by one string. Returns an error for
 * a malformed reference (`${{ secrets.bad-name }}`, `${{ secrets. }}`, an
 * unterminated `${{ secrets.X`) so a typo fails at parse time instead of
 * silently shipping the literal text into the job.
 */
export function secretRefsIn(value: string): { names: string[]; error?: string } {
  const names: string[] = [];
  let stripped = value;
  for (const m of value.matchAll(LOOSE_REF_RE)) {
    const raw = (m[1] ?? "").trim();
    const invalid = validateSecretName(raw);
    if (invalid) return { names: [], error: `bad secrets reference \`${m[0]}\`: ${invalid}` };
    const name = canonicalSecretName(raw);
    if (!names.includes(name)) names.push(name);
    stripped = stripped.replace(m[0], "");
  }
  if (UNCLOSED_REF_RE.test(stripped)) {
    return { names: [], error: `unterminated secrets reference in "${value.slice(0, 60)}"` };
  }
  return { names };
}

export function containsSecretRef(value: string): boolean {
  return UNCLOSED_REF_RE.test(value);
}

/** Looks a canonical secret name up in the Worker env. */
export type SecretLookup = (name: string) => string | undefined;

export function secretLookupFromEnv(env: object): SecretLookup {
  const bag = env as Record<string, unknown>;
  return (name) => {
    const v = bag[secretEnvName(name)];
    return typeof v === "string" ? v : undefined;
  };
}

/** Every CI secret value bound on the Worker — the scrub list for a run. */
export function allSecretValues(env: object): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    if (k.startsWith(CI_SECRET_PREFIX) && typeof v === "string" && v.length > 0) out.push(v);
  }
  return out;
}

export interface ResolvedEnv {
  env?: Record<string, string>;
  /** Canonical names referenced but not set on the Worker. */
  missing?: string[];
  /** Secret values that were spliced into `env` (for the scrubber). */
  values: string[];
}

/**
 * Substitute `${{ secrets.NAME }}` in a job's env values. All-or-nothing: if
 * any referenced secret is unset, returns `missing` and no env (the job must
 * fail rather than run with a hole in its environment).
 */
export function resolveJobEnv(env: Record<string, string>, lookup: SecretLookup): ResolvedEnv {
  const out: Record<string, string> = {};
  const missing: string[] = [];
  const values: string[] = [];
  for (const [key, raw] of Object.entries(env)) {
    out[key] = raw.replace(LOOSE_REF_RE, (whole, inner: string) => {
      const name = canonicalSecretName(inner.trim());
      const v = lookup(name);
      if (v === undefined) {
        if (!missing.includes(name)) missing.push(name);
        return whole;
      }
      if (!values.includes(v)) values.push(v);
      return v;
    });
  }
  if (missing.length > 0) return { missing, values: [] };
  return { env: out, values };
}

export function missingSecretsMessage(missing: string[]): string {
  const list = missing.join(", ");
  const first = missing[0] ?? "NAME";
  return `secret${missing.length > 1 ? "s" : ""} not set: ${list} — run \`gitflare secrets set ${first}\``;
}

// -- scrubbing ----------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** btoa that doesn't throw on non-Latin-1 input (encodes UTF-8 bytes). */
export function utf8Base64(s: string): string {
  return bytesToBase64(new TextEncoder().encode(s));
}

/**
 * Base64 forms of a secret that survive being embedded in a longer encoded
 * stream: for each of the three byte alignments, the run of base64 characters
 * that depends ONLY on the secret's bytes (the chars that straddle the
 * unknown neighbours are dropped). Covers `echo -n $S | base64`, `echo $S |
 * base64` (trailing newline), and `printf 'user:%s' $S | base64` alike.
 */
export function base64Variants(secret: string): string[] {
  const bytes = new TextEncoder().encode(secret);
  const out: string[] = [];
  for (let k = 0; k < 3; k++) {
    const padded = new Uint8Array(k + bytes.length);
    padded.set(bytes, k);
    const enc = bytesToBase64(padded);
    const start = Math.ceil((8 * k) / 6);
    const end = Math.floor((8 * (k + bytes.length)) / 6);
    const core = enc.slice(start, end);
    // Very short cores would blank common substrings of unrelated output.
    if (core.length >= 4) out.push(core);
  }
  return out;
}

/** Needles to blank for one secret: the value, each line of it, base64 forms. */
export function scrubNeedles(secret: string): string[] {
  if (!secret) return [];
  const needles = new Set<string>([secret]);
  if (secret.includes("\n")) {
    // Logs are scrubbed line by line, so a multi-line secret (a PEM key) can
    // only ever be matched one line at a time.
    for (const line of secret.split(/\r?\n/)) {
      const t = line.trim();
      if (t.length >= 4) needles.add(t);
    }
  }
  for (const v of base64Variants(secret)) needles.add(v);
  return [...needles];
}
