// CI secrets store — CLI side (M10). Pure helpers; the command lives in
// commands/secrets.ts.
//
// Storage: one Worker Secret per CI secret, named CI_SECRET_<NAME>, on the
// repo's own Worker (one Worker per repo, so secrets are per repo). The Worker
// reads them from its env at CI time (packages/worker/src/ci/secrets.ts —
// keep the prefix and name rules in sync; a test checks they agree).

export const CI_SECRET_PREFIX = "CI_SECRET_";
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_NAME_LENGTH = 100;
/** Cloudflare caps a Worker Secret's value at 5 KiB. */
export const MAX_SECRET_BYTES = 5 * 1024;

/** Validate + canonicalise (upper case — GitHub secret names are case-insensitive). */
export function normalizeSecretName(raw: string): { name?: string; error?: string } {
  const name = raw.trim();
  if (!name) return { error: "secret name is empty" };
  if (name.length > MAX_NAME_LENGTH) return { error: `secret name longer than ${MAX_NAME_LENGTH} chars` };
  if (!NAME_RE.test(name)) {
    return { error: `invalid secret name "${name.slice(0, 60)}" — letters, digits and _ only; must not start with a digit` };
  }
  return { name: name.toUpperCase() };
}

export function workerSecretName(name: string): string {
  return `${CI_SECRET_PREFIX}${name.toUpperCase()}`;
}

/** CI secret names (prefix stripped, sorted) out of a Worker's secret list. */
export function ciSecretNames(workerSecrets: Array<{ name: string }>): string[] {
  return workerSecrets
    .map((s) => s.name)
    .filter((n) => n.startsWith(CI_SECRET_PREFIX) && n.length > CI_SECRET_PREFIX.length)
    .map((n) => n.slice(CI_SECRET_PREFIX.length))
    .sort();
}

/**
 * A value piped on stdin: drop exactly ONE trailing newline (what `echo` and
 * most editors add) and nothing else — leading/trailing spaces may be real.
 */
export function valueFromStdin(raw: string): string {
  return raw.replace(/\r?\n$/, "");
}

export function validateSecretValue(value: string): string | null {
  if (value.length === 0) return "secret value is empty";
  const bytes = new TextEncoder().encode(value).length;
  if (bytes > MAX_SECRET_BYTES) return `secret value is ${bytes} bytes — Cloudflare's limit is ${MAX_SECRET_BYTES}`;
  return null;
}

/** Read all of a (piped) stream as UTF-8. */
export async function readAll(stream: AsyncIterable<Buffer | string>): Promise<string> {
  let out = "";
  for await (const chunk of stream) out += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  return out;
}
