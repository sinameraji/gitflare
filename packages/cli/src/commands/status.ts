import * as p from "@clack/prompts";
import kleur from "kleur";
import { loadConfig } from "../config.js";
import { orange } from "../util.js";

export async function runStatus(): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare status")));
  const cfg = await loadConfig();
  if (cfg.repos.length === 0) {
    p.log.warn("No repos provisioned. Run `gitflare init <github-url>` to add one.");
    p.outro("");
    return;
  }
  for (const r of cfg.repos) {
    p.log.info(
      [
        kleur.bold(r.githubFullName),
        `  worker:    ${r.workerUrl}`,
        `  artifacts: ${r.artifactsNamespace}/${r.artifactsRepoName}`,
        `  created:   ${r.createdAt}`,
      ].join("\n"),
    );
  }
  p.outro("");
}
