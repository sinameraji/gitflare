import { CloudflareClient } from "../cloudflare.js";
import { loadConfig } from "../config.js";
import { formatCredentialOutput, parseCredentialInput, requestMatchesRemote, stripTokenExpiry } from "../git-config.js";

/**
 * `gitflare credential <get|store|erase> --repo <artifacts-repo-name>` — a git
 * credential helper (installed into .git/config by `gitflare remote add`).
 * For `get` it mints a 10-minute WRITE token for the mirror via the Cloudflare
 * REST API using the token saved by `gitflare init`, and prints it in the
 * helper protocol. `store`/`erase` are no-ops (nothing is persisted).
 * Speaks only on stdout; every diagnostic goes to stderr so git never sees it.
 */
export async function runCredentialHelper(op: string, opts: { repo?: string }): Promise<void> {
  if (op !== "get") return; // store / erase: nothing to do
  const stdin = await readStdin();
  const req = parseCredentialInput(stdin);

  const cfg = await loadConfig();
  const entry = opts.repo
    ? cfg.repos.find((r) => r.artifactsRepoName === opts.repo || r.githubFullName === opts.repo)
    : undefined;
  if (!entry) {
    process.stderr.write(`gitflare credential: no provisioned repo matches ${opts.repo ?? "(none)"}\n`);
    process.exitCode = 1;
    return;
  }
  const cfToken = cfg.cloudflare?.token;
  if (!cfToken) {
    process.stderr.write("gitflare credential: no saved Cloudflare token — run `gitflare init` once on this machine\n");
    process.exitCode = 1;
    return;
  }
  const cf = new CloudflareClient(cfToken);
  let remote: string;
  try {
    remote = (await cf.getRepo(entry.cloudflareAccountId, entry.artifactsNamespace, entry.artifactsRepoName)).remote;
  } catch (e) {
    process.stderr.write(`gitflare credential: ${(e as Error).message}\n`);
    process.exitCode = 1;
    return;
  }
  // Only answer for the mirror this helper was installed for; anything else
  // (e.g. github.com) gets silence, so git moves on to the next helper.
  if (!requestMatchesRemote(req, remote)) return;

  try {
    const tok = await cf.createRepoToken(entry.cloudflareAccountId, entry.artifactsNamespace, {
      repo: entry.artifactsRepoName,
      scope: "write",
      ttl: 600,
    });
    process.stdout.write(formatCredentialOutput("x", stripTokenExpiry(tok.plaintext)));
  } catch (e) {
    process.stderr.write(`gitflare credential: token mint failed: ${(e as Error).message}\n`);
    process.exitCode = 1;
  }
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(data));
    if (process.stdin.isTTY) resolve("");
  });
}
