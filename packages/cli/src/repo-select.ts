import * as p from "@clack/prompts";
import kleur from "kleur";
import type { LocalConfig } from "./config.js";

export type RepoEntry = LocalConfig["repos"][number];

/** Resolve a repo entry from an arg, or prompt if there's more than one. */
export async function pickRepo(
  cfg: LocalConfig,
  repoArg: string | undefined,
): Promise<RepoEntry | undefined> {
  if (cfg.repos.length === 0) {
    p.log.warn("No repos provisioned. Run `gitflare init <github-url>` first.");
    return undefined;
  }
  if (repoArg) {
    const match = cfg.repos.find(
      (r) => r.githubFullName === repoArg || r.artifactsRepoName === repoArg,
    );
    if (!match) {
      p.log.error(`No provisioned repo matches ${kleur.cyan(repoArg)}.`);
      return undefined;
    }
    return match;
  }
  if (cfg.repos.length === 1) return cfg.repos[0];
  const choice = await p.select({
    message: "Which repo?",
    options: cfg.repos.map((r) => ({
      value: r.githubFullName,
      label: r.githubFullName,
    })),
  });
  if (p.isCancel(choice)) return undefined;
  return cfg.repos.find((r) => r.githubFullName === choice);
}

/** Reuse the saved Cloudflare token, or prompt for one. */
export async function getCfToken(cfg: LocalConfig): Promise<string | undefined> {
  if (cfg.cloudflare?.token) return cfg.cloudflare.token;
  const v = await p.password({
    message: "Cloudflare API token",
    validate: (s) => (!s ? "required" : undefined),
  });
  if (p.isCancel(v)) return undefined;
  return v as string;
}
