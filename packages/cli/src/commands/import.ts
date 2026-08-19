import * as p from "@clack/prompts";
import kleur from "kleur";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { orange } from "../util.js";
import { importActionsWorkflows, formatReport } from "../actions-import.js";

/**
 * `gitflare ci import` — translate .github/workflows/*.yml into .gitflare/ci.yml.
 * Dry-run by default (prints the YAML + report); --write writes the file.
 */
export async function runCiImport(opts: { dir?: string; out?: string; write?: boolean; cwd?: string }): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare ci import")));
  const cwd = opts.cwd ?? process.cwd();
  const dir = resolve(cwd, opts.dir ?? ".github/workflows");
  const outPath = resolve(cwd, opts.out ?? ".gitflare/ci.yml");
  let names: string[] = [];
  try {
    names = (await fs.readdir(dir)).filter((n) => /\.ya?ml$/.test(n)).sort();
  } catch {
    p.log.error(`No workflows directory at ${kleur.cyan(dir)}. Run this inside a repo, or pass --dir.`);
    return;
  }
  if (names.length === 0) {
    p.log.warn(`No *.yml in ${dir}.`);
    return;
  }
  const files = await Promise.all(names.map(async (name) => ({ name, text: await fs.readFile(join(dir, name), "utf8") })));
  const result = importActionsWorkflows(files);

  p.log.message(formatReport(result.report));
  if (result.jobCount === 0) {
    p.outro(kleur.yellow("Nothing to write — no push-triggered Linux jobs could be translated. See the reasons above."));
    return;
  }
  p.log.message(kleur.bold("Generated .gitflare/ci.yml:") + "\n" + kleur.gray(result.ciYml.trimEnd()));

  if (!opts.write) {
    p.outro(`Dry run. Re-run with ${kleur.cyan("--write")} to save it to ${kleur.cyan(outPath)}, then review, commit, and \`gitflare ci enable\`.`);
    return;
  }
  const exists = await fs.stat(outPath).then(() => true).catch(() => false);
  if (exists) {
    const ok = await p.confirm({ message: `${outPath} exists — overwrite?`, initialValue: false });
    if (p.isCancel(ok) || !ok) return p.cancel("Left as is."), undefined;
  }
  await fs.mkdir(resolve(outPath, ".."), { recursive: true });
  await fs.writeFile(outPath, result.ciYml, "utf8");
  p.outro(
    [
      `Wrote ${kleur.cyan(outPath)}.`,
      "  Next: fix anything marked above (deploy project/entry, secrets, ${{ }} expressions), commit it,",
      `  then ${kleur.cyan("gitflare ci enable")} — from then on every push runs it in your Cloudflare Sandbox.`,
      "  With ci.yml committed, GitHub Actions and GitFlare CI run side by side until you delete the old workflows.",
    ].join("\n"),
  );
}
