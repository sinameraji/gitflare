import * as p from "@clack/prompts";
import kleur from "kleur";

const orange = (s: string): string => `\x1b[38;2;243;128;32m${s}\x1b[0m`;

export async function runStatus(): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare status")));
  p.log.warn("Status flow lands after M1. Stub only.");
  p.outro("Done (stub).");
}
