// Pure planning for `gitflare remote add|remove` — the git-config edits that
// make `git push` fan out to GitHub AND the Artifacts mirror, with a
// credential helper that mints short-lived Artifacts tokens on demand.
// Kept free of I/O so it can be unit-tested; commands/remote.ts executes it.

export interface RemoteAddInput {
  /** `remote.origin.url` — the GitHub URL pushes go to today. */
  originUrl: string;
  /** The Artifacts clone URL (https://<acct>.artifacts.cloudflare.net/git/<ns>/<name>.git). */
  artifactsRemote: string;
  /** Current `remote.origin.pushurl` values (empty = git pushes to `url`). */
  existingPushUrls: readonly string[];
  /** The `credential.<remote>.helper` value, e.g. `!"/usr/bin/node" "/…/dist/index.js" credential --repo o--r`. */
  helperCommand: string;
}

export interface RemotePlan {
  /** `git config …` argument vectors, in order. */
  ops: string[][];
  alreadyConfigured: boolean;
}

/** git config section key for the credential helper, matched by full URL (useHttpPath). */
export function credentialSection(artifactsRemote: string): string {
  return `credential.${artifactsRemote}`;
}

/**
 * Add the mirror as a second push destination. Order matters: with any
 * `pushurl` set, git ignores `url` for pushes — so when none exists yet the
 * GitHub URL is added FIRST, keeping GitHub as the first (and primary) leg.
 */
export function planRemoteAdd(input: RemoteAddInput): RemotePlan {
  const ops: string[][] = [];
  const has = (u: string) => input.existingPushUrls.includes(u);
  const alreadyConfigured = has(input.artifactsRemote);
  if (!alreadyConfigured) {
    if (input.existingPushUrls.length === 0) {
      ops.push(["config", "--add", "remote.origin.pushurl", input.originUrl]);
    }
    ops.push(["config", "--add", "remote.origin.pushurl", input.artifactsRemote]);
  }
  const section = credentialSection(input.artifactsRemote);
  ops.push(["config", `${section}.helper`, input.helperCommand]);
  ops.push(["config", `${section}.useHttpPath`, "true"]);
  ops.push(["config", `${section}.username`, "x"]);
  return { ops, alreadyConfigured };
}

/**
 * Undo `planRemoteAdd`. If the only pushurl left afterwards would be the
 * origin URL we added ourselves, drop it too so `.git/config` returns to how
 * git had it (pushing to `url`).
 */
export function planRemoteRemove(input: {
  originUrl: string;
  artifactsRemote: string;
  existingPushUrls: readonly string[];
}): RemotePlan {
  const ops: string[][] = [];
  const present = input.existingPushUrls.includes(input.artifactsRemote);
  if (present) {
    ops.push(["config", "--unset-all", "remote.origin.pushurl", regexLiteral(input.artifactsRemote)]);
    const remaining = input.existingPushUrls.filter((u) => u !== input.artifactsRemote);
    if (remaining.length === 1 && remaining[0] === input.originUrl) {
      ops.push(["config", "--unset-all", "remote.origin.pushurl", regexLiteral(input.originUrl)]);
    }
  }
  ops.push(["config", "--remove-section", credentialSection(input.artifactsRemote)]);
  return { ops, alreadyConfigured: present };
}

/** `git config --unset-all key <value-regex>` — anchor and escape the literal URL. */
export function regexLiteral(s: string): string {
  return `^${s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}$`;
}

// ---- git credential helper protocol ------------------------------------------

export interface CredentialRequest {
  protocol?: string;
  host?: string;
  path?: string;
  username?: string;
  [k: string]: string | undefined;
}

/** Parse the `key=value` lines git writes to a helper's stdin (up to the blank line). */
export function parseCredentialInput(stdin: string): CredentialRequest {
  const out: CredentialRequest = {};
  for (const raw of stdin.split(/\r?\n/)) {
    if (raw === "") break;
    const i = raw.indexOf("=");
    if (i <= 0) continue;
    out[raw.slice(0, i)] = raw.slice(i + 1);
  }
  return out;
}

/** The lines a helper writes back for `get`. */
export function formatCredentialOutput(username: string, password: string): string {
  return `username=${username}\npassword=${password}\n`;
}

/** Artifacts tokens come back as "art_v2_…?expires=<unix>"; git wants just the secret. */
export function stripTokenExpiry(plaintext: string): string {
  const i = plaintext.indexOf("?expires=");
  return i === -1 ? plaintext : plaintext.slice(0, i);
}

/** Does this credential request target the given Artifacts remote? */
export function requestMatchesRemote(req: CredentialRequest, artifactsRemote: string): boolean {
  let u: URL;
  try {
    u = new URL(artifactsRemote);
  } catch {
    return false;
  }
  if (req.protocol && req.protocol !== u.protocol.replace(/:$/, "")) return false;
  if (req.host && req.host !== u.host) return false;
  if (req.path) {
    const want = u.pathname.replace(/^\//, "");
    if (req.path !== want && req.path !== want.replace(/\.git$/, "")) return false;
  }
  return true;
}
