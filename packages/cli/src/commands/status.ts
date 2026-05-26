import * as p from "@clack/prompts";
import kleur from "kleur";

export async function runStatus(): Promise<void> {
  p.intro(kleur.bold().hex("#F38020")("GitFlare status"));
  p.log.warn("Status flow lands after M1. Stub only.");
  p.outro("Done (stub).");
}
