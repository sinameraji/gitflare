import * as p from "@clack/prompts";
import kleur from "kleur";

export interface InitOptions {
  session?: string;
}

const orange = (s: string): string => `\x1b[38;2;243;128;32m${s}\x1b[0m`;

export async function runInit(
  githubUrl: string | undefined,
  opts: InitOptions,
): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare init")));

  if (opts.session) {
    p.log.info("Session-based init not implemented yet (M2). Stub only.");
    p.outro("Done (stub).");
    return;
  }

  if (!githubUrl) {
    const v = await p.text({
      message: "GitHub repo URL",
      placeholder: "github.com/owner/repo",
    });
    if (p.isCancel(v)) {
      p.cancel("Cancelled.");
      process.exit(0);
    }
    githubUrl = v as string;
  }

  p.log.info(`Will mirror: ${kleur.cyan(githubUrl)}`);
  p.log.warn("Provisioning flow lands in M2. This is a stub.");
  p.outro("Done (stub).");
}
