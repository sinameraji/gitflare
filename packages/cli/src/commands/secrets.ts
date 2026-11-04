import * as p from "@clack/prompts";
import kleur from "kleur";
import { CloudflareClient } from "../cloudflare.js";
import { loadConfig } from "../config.js";
import { orange } from "../util.js";
import { pickRepo, getCfToken, type RepoEntry } from "../repo-select.js";
import {
  ciSecretNames,
  normalizeSecretName,
  readAll,
  validateSecretValue,
  valueFromStdin,
  workerSecretName,
} from "../secrets.js";

// `gitflare secrets set|list|rm` — the CI secrets store (M10). Values are
// Worker Secrets on the repo's own Worker (CI_SECRET_<NAME>): encrypted at
// rest by Cloudflare, write-only through the API, read by the Worker's CI
// runner at run time. The value is NEVER taken from argv (shell history, ps).

async function setup(
  repoArg: string | undefined,
): Promise<{ entry: RepoEntry; cf: CloudflareClient } | undefined> {
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return undefined;
  const token = await getCfToken(cfg);
  if (!token) {
    p.cancel("Cancelled.");
    return undefined;
  }
  return { entry, cf: new CloudflareClient(token) };
}

async function readValue(name: string): Promise<string | undefined> {
  if (!process.stdin.isTTY) {
    // Piped: `gitflare secrets set NPM_TOKEN < token.txt` / `… | gitflare secrets set X`
    return valueFromStdin(await readAll(process.stdin));
  }
  const v = await p.password({
    message: `Value for ${name} (input hidden)`,
    validate: (s) => (s ? undefined : "required"),
  });
  if (p.isCancel(v)) return undefined;
  return v as string;
}

export async function runSecretsSet(nameArg: string, repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare secrets set")));
  const n = normalizeSecretName(nameArg);
  if (!n.name) {
    p.log.error(n.error ?? "invalid secret name");
    process.exitCode = 1;
    return;
  }
  const ctx = await setup(repoArg);
  if (!ctx) return;
  const { entry, cf } = ctx;

  const value = await readValue(n.name);
  if (value === undefined) return p.cancel("Cancelled."), undefined;
  const invalid = validateSecretValue(value);
  if (invalid) {
    p.log.error(invalid);
    process.exitCode = 1;
    return;
  }

  const sp = p.spinner();
  sp.start(`Storing ${n.name} as a Worker Secret on ${entry.workerName}`);
  try {
    await cf.putWorkerSecret(entry.cloudflareAccountId, entry.workerName, workerSecretName(n.name), value);
    sp.stop(`${n.name} set`);
  } catch (e) {
    sp.stop("Failed");
    p.log.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  if (!entry.ci?.enabled) {
    p.log.warn("CI isn't enabled for this repo yet — the secret is stored and will be used once you `gitflare ci enable`.");
  }
  p.outro(
    [
      `Use it in ${kleur.cyan(".gitflare/ci.yml")} via a job's env:`,
      kleur.gray(`    env:`),
      kleur.gray(`      ${n.name}: \${{ secrets.${n.name} }}`),
      kleur.gray("  Setting a secret redeploys the Worker — a CI run in flight at that moment is interrupted."),
    ].join("\n"),
  );
}

export async function runSecretsList(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare secrets list")));
  const ctx = await setup(repoArg);
  if (!ctx) return;
  const { entry, cf } = ctx;
  let names: string[];
  try {
    names = ciSecretNames(await cf.listWorkerSecrets(entry.cloudflareAccountId, entry.workerName));
  } catch (e) {
    p.log.error((e as Error).message);
    process.exitCode = 1;
    return;
  }
  if (names.length === 0) {
    p.outro(`No CI secrets for ${kleur.cyan(entry.githubFullName)}. Add one with ${kleur.cyan("gitflare secrets set NAME")}.`);
    return;
  }
  // Names only — Cloudflare never returns secret values.
  p.log.message(names.join("\n"));
  p.outro(`${names.length} secret(s) for ${kleur.cyan(entry.githubFullName)}`);
}

export async function runSecretsRm(nameArg: string, repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare secrets rm")));
  const n = normalizeSecretName(nameArg);
  if (!n.name) {
    p.log.error(n.error ?? "invalid secret name");
    process.exitCode = 1;
    return;
  }
  const ctx = await setup(repoArg);
  if (!ctx) return;
  const { entry, cf } = ctx;
  try {
    await cf.deleteWorkerSecret(entry.cloudflareAccountId, entry.workerName, workerSecretName(n.name));
  } catch (e) {
    const msg = (e as Error).message;
    p.log.error(/→ 404/.test(msg) ? `No secret named ${n.name} on ${entry.workerName}.` : msg);
    process.exitCode = 1;
    return;
  }
  p.outro(`${n.name} removed. Jobs that still reference it will fail until it's set again.`);
}
