import * as p from "@clack/prompts";
import kleur from "kleur";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CloudflareClient } from "../cloudflare.js";
import { loadConfig } from "../config.js";
import { detectGithubRemoteFromCwd, orange, parseGithubUrl } from "../util.js";
import { fetchRemote, getCfToken, pickRepo, type RepoEntry } from "../repo-select.js";
import { planRemoteAdd, planRemoteRemove } from "../git-config.js";
import { runCredentialHelper } from "./credential.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function git(args: string[], cwd = process.cwd()): { ok: boolean; out: string; err: string } {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim(), err: (r.stderr ?? "").trim() };
}

/** The `gitflare` entrypoint git should invoke for credentials (dist/index.js next to dist/commands/). */
function cliEntry(): string {
  return join(HERE, "..", "index.js");
}

/** Resolve the provisioned repo for the current checkout: explicit arg, else match origin. */
async function resolveEntry(repoArg: string | undefined): Promise<RepoEntry | undefined> {
  const cfg = await loadConfig();
  if (repoArg) return pickRepo(cfg, repoArg);
  const origin = detectGithubRemoteFromCwd();
  if (origin) {
    try {
      const { owner, repo } = parseGithubUrl(origin);
      const full = `${owner}/${repo}`.toLowerCase();
      const match = cfg.repos.find((r) => r.githubFullName.toLowerCase() === full);
      if (match) return match;
      p.log.warn(`origin points at ${kleur.cyan(`${owner}/${repo}`)}, which isn't provisioned with GitFlare — pick one:`);
    } catch {
      // fall through to the picker
    }
  }
  return pickRepo(cfg, undefined);
}

export async function runRemoteAdd(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare remote add")));
  const originUrl = git(["config", "--get", "remote.origin.url"]).out;
  if (!originUrl) {
    p.log.error("Run this inside a git checkout that has an `origin` remote.");
    return;
  }
  const entry = await resolveEntry(repoArg);
  if (!entry) return;

  const cfg = await loadConfig();
  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const remote = await fetchRemote(new CloudflareClient(cfToken), entry);
  if (!remote) return;

  const existing = git(["config", "--get-all", "remote.origin.pushurl"]).out.split("\n").filter(Boolean);
  const entryPath = cliEntry();
  const helperCommand = `!${JSON.stringify(process.execPath)} ${JSON.stringify(entryPath)} credential --repo ${entry.artifactsRepoName}`;
  const plan = planRemoteAdd({ originUrl, artifactsRemote: remote, existingPushUrls: existing, helperCommand });

  for (const op of plan.ops) {
    const r = git(op);
    if (!r.ok) {
      p.log.error(`git ${op.join(" ")} failed: ${r.err}`);
      return;
    }
  }

  if (/[\\/]_npx[\\/]/.test(entryPath)) {
    p.log.warn(
      "You're running gitflare via npx — the credential helper now points into npx's cache, which can be evicted. Install it globally (`npm i -g gitflare`) and re-run `gitflare remote add` for a stable path.",
    );
  }
  p.log.success(
    plan.alreadyConfigured
      ? "The mirror was already a push destination; refreshed the credential helper."
      : `Added the mirror as a second push destination for ${kleur.cyan("origin")}.`,
  );
  p.outro(
    [
      kleur.bold(orange("git push now goes to both.")),
      "",
      `  1. GitHub   ${kleur.gray(originUrl)}`,
      `  2. mirror   ${kleur.gray(remote)}`,
      "",
      "  When GitHub is down, leg 1 fails and git exits non-zero — but leg 2 still lands,",
      "  and with `gitflare sync enable` the mirror runs CI/CD and pushes GitHub back up",
      "  to date when it returns. Credentials for the mirror are minted on the fly",
      "  (10-minute write tokens) by `gitflare credential`; nothing long-lived is stored.",
      "",
      `  Undo any time: ${kleur.cyan("gitflare remote remove")}`,
    ].join("\n"),
  );
}

export async function runRemoteRemove(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare remote remove")));
  const originUrl = git(["config", "--get", "remote.origin.url"]).out;
  if (!originUrl) {
    p.log.error("Run this inside a git checkout that has an `origin` remote.");
    return;
  }
  const entry = await resolveEntry(repoArg);
  if (!entry) return;
  const cfg = await loadConfig();
  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const remote = await fetchRemote(new CloudflareClient(cfToken), entry);
  if (!remote) return;

  const existing = git(["config", "--get-all", "remote.origin.pushurl"]).out.split("\n").filter(Boolean);
  const plan = planRemoteRemove({ originUrl, artifactsRemote: remote, existingPushUrls: existing });
  for (const op of plan.ops) {
    const r = git(op);
    // --remove-section on a missing section is a benign failure.
    if (!r.ok && !op.includes("--remove-section")) {
      p.log.error(`git ${op.join(" ")} failed: ${r.err}`);
      return;
    }
  }
  p.outro(kleur.bold(orange(plan.alreadyConfigured ? "Mirror push destination removed." : "Nothing to remove — the mirror wasn't a push destination.")));
}

export { runCredentialHelper };
