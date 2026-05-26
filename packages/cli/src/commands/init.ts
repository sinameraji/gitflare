import * as p from "@clack/prompts";
import kleur from "kleur";
import { GitHubClient } from "../github.js";
import { CloudflareClient } from "../cloudflare.js";
import { loadConfig, saveConfig } from "../config.js";
import {
  artifactsRepoNameFor,
  orange,
  parseGithubUrl,
  randomHex,
} from "../util.js";
import {
  workerPackageDir,
  writeWranglerToml,
  wranglerDeploy,
  wranglerSecret,
} from "../wrangler.js";

export interface InitOptions {
  session?: string;
}

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

const GITHUB_PAT_URL =
  "https://github.com/settings/tokens/new?scopes=repo,admin:repo_hook&description=GitFlare";

export async function runInit(
  githubUrl: string | undefined,
  opts: InitOptions,
): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare init")));

  if (opts.session) {
    p.log.warn("Session-based init not implemented yet. Falling back to interactive.");
  }

  // ---------- 1. Repo URL ----------
  if (!githubUrl) {
    const v = await p.text({
      message: "GitHub repo to mirror",
      placeholder: "github.com/owner/repo",
      validate: (s) => (!s ? "required" : undefined),
    });
    if (p.isCancel(v)) return p.cancel("Cancelled."), undefined;
    githubUrl = v as string;
  }
  const { owner, repo } = parseGithubUrl(githubUrl);
  p.log.info(`Repo: ${kleur.cyan(`${owner}/${repo}`)}`);

  // ---------- 2. GitHub PAT ----------
  p.log.info(`If you don't have a PAT, create one (scopes: repo, admin:repo_hook):\n  ${kleur.gray(GITHUB_PAT_URL)}`);
  const ghToken = await p.password({
    message: "GitHub personal access token",
    validate: (s) => (!s ? "required" : undefined),
  });
  if (p.isCancel(ghToken)) return p.cancel("Cancelled."), undefined;

  const gh = new GitHubClient(ghToken as string);
  const ghSpinner = p.spinner();
  ghSpinner.start("Verifying GitHub token");
  let ghUser: { login: string };
  let ghRepo: { default_branch: string; private: boolean; clone_url: string };
  try {
    ghUser = await gh.getUser();
    ghRepo = await gh.getRepo(owner, repo);
    ghSpinner.stop(`GitHub OK — user ${kleur.cyan(ghUser.login)}, repo default branch ${kleur.cyan(ghRepo.default_branch)}`);
  } catch (e) {
    ghSpinner.stop("GitHub verification failed");
    p.log.error((e as Error).message);
    return;
  }

  // ---------- 3. Cloudflare token ----------
  p.log.info(
    [
      `Create a Cloudflare API token at ${kleur.gray(TOKEN_URL)}`,
      `with these ${kleur.bold("3 account-level permissions")}:`,
      `  • ${kleur.cyan("Workers Scripts")}        — Edit`,
      `  • ${kleur.cyan("Artifacts")}              — Edit  ${kleur.gray("(adds Read implicitly)")}`,
      `  • ${kleur.cyan("Account Settings")}       — Read`,
    ].join("\n"),
  );
  const cfToken = await p.password({
    message: "Cloudflare API token",
    validate: (s) => (!s ? "required" : undefined),
  });
  if (p.isCancel(cfToken)) return p.cancel("Cancelled."), undefined;

  const cf = new CloudflareClient(cfToken as string);
  const cfSpinner = p.spinner();
  cfSpinner.start("Verifying Cloudflare token");
  let accountId: string;
  let subdomain: string;
  try {
    await cf.verifyToken();
    const accounts = await cf.listAccounts();
    if (accounts.length === 0) throw new Error("No accounts visible to this token");
    if (accounts.length === 1) {
      accountId = accounts[0]!.id;
    } else {
      cfSpinner.stop("Multiple accounts visible");
      const choice = await p.select({
        message: "Pick the Cloudflare account",
        options: accounts.map((a) => ({ value: a.id, label: `${a.name} (${a.id})` })),
      });
      if (p.isCancel(choice)) return p.cancel("Cancelled."), undefined;
      accountId = choice as string;
      cfSpinner.start("Resolving Workers subdomain");
    }
    subdomain = await cf.getWorkersSubdomain(accountId);
    cfSpinner.stop(`Cloudflare OK — account ${kleur.cyan(accountId.slice(0, 8) + "…")} subdomain ${kleur.cyan(subdomain)}`);
  } catch (e) {
    cfSpinner.stop("Cloudflare verification failed");
    p.log.error((e as Error).message);
    return;
  }

  // ---------- 4. Confirm the contract ----------
  const namespace = "gitflare";
  const artifactsRepoName = artifactsRepoNameFor(owner, repo);
  const workerName = `gitflare-${artifactsRepoName}`;
  const workerUrl = `https://${workerName}.${subdomain}.workers.dev`;

  p.log.message(kleur.bold("About to provision on your Cloudflare account:"));
  p.log.message(`  Worker:         ${kleur.cyan(workerName)}`);
  p.log.message(`  URL:            ${kleur.cyan(workerUrl)}`);
  p.log.message(`  Artifacts ns:   ${kleur.cyan(namespace)}`);
  p.log.message(`  Artifacts repo: ${kleur.cyan(artifactsRepoName)}`);
  p.log.message(`  Importing from: ${kleur.cyan(ghRepo.clone_url)}`);
  p.log.message(`  GitHub webhook: ${kleur.cyan(`${owner}/${repo}`)} → ${kleur.gray(workerUrl + "/webhooks/github")}`);
  p.log.message(kleur.gray("  All resources live in your Cloudflare account. GitFlare-the-company sees none of this."));

  const proceed = await p.confirm({ message: "Proceed?", initialValue: true });
  if (p.isCancel(proceed) || !proceed) return p.cancel("Cancelled."), undefined;

  // ---------- 5. Import into Artifacts ----------
  // Namespaces auto-provision on first repo creation — no explicit ensure step.
  // Idempotent on re-run: if the repo exists, we reuse it.
  const provSpin = p.spinner();
  provSpin.start("Importing repo into Artifacts (one-time seed from GitHub)");
  let artifactsRemote: string;
  try {
    const imported = await cf.importRepo(accountId, namespace, {
      name: artifactsRepoName,
      url: ghRepo.clone_url,
      branch: ghRepo.default_branch,
    });
    artifactsRemote = imported.remote;
    provSpin.stop(`Artifacts repo created: ${kleur.cyan(imported.name)}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/409|already exists/i.test(msg)) {
      provSpin.message("Repo already exists — fetching existing remote");
      try {
        const existing = await cf.getRepo(accountId, namespace, artifactsRepoName);
        artifactsRemote = existing.remote;
        provSpin.stop(`Reusing existing Artifacts repo: ${kleur.cyan(existing.name)}`);
      } catch (e2) {
        provSpin.stop("Artifacts repo lookup failed");
        p.log.error((e2 as Error).message);
        return;
      }
    } else {
      provSpin.stop("Artifacts import failed");
      p.log.error(msg);
      return;
    }
  }
  p.log.info(`Clone URL: ${kleur.gray(artifactsRemote)}`);

  // ---------- 6. Worker deploy ----------
  const webhookSecret = randomHex(32);
  const repoMap: Record<string, string> = {
    [`${owner}/${repo}`]: artifactsRepoName,
  };

  const wDir = workerPackageDir();
  const depSpin = p.spinner();
  depSpin.start("Writing wrangler.toml + deploying Worker");
  let deployedUrl: string;
  try {
    await writeWranglerToml({
      workerPackageDir: wDir,
      cloudflareApiToken: cfToken as string,
      accountId,
      workerName,
      artifactsNamespace: namespace,
      repoMap,
    });
    const deploy = await wranglerDeploy({
      workerPackageDir: wDir,
      cloudflareApiToken: cfToken as string,
      accountId,
      workerName,
      artifactsNamespace: namespace,
      repoMap,
    });
    deployedUrl = deploy.workerUrl;
    depSpin.message("Setting Worker secrets");
    await wranglerSecret(wDir, cfToken as string, "GITHUB_WEBHOOK_SECRET", webhookSecret);
    await wranglerSecret(wDir, cfToken as string, "GITHUB_TOKEN", ghToken as string);
    depSpin.stop(`Worker live at ${kleur.cyan(deployedUrl)}`);
  } catch (e) {
    depSpin.stop("Worker deploy failed");
    p.log.error((e as Error).message);
    return;
  }

  // ---------- 7. GitHub webhook ----------
  const hookSpin = p.spinner();
  hookSpin.start("Installing GitHub webhook");
  try {
    const existing = await gh.listHooks(owner, repo);
    const same = existing.find((h) => h.config?.url === `${deployedUrl}/webhooks/github`);
    if (same) {
      hookSpin.message(`Replacing existing webhook ${same.id}`);
      await gh.deleteHook(owner, repo, same.id);
    }
    const created = await gh.createHook(owner, repo, {
      url: `${deployedUrl}/webhooks/github`,
      secret: webhookSecret,
      events: ["push", "pull_request", "issues", "issue_comment", "pull_request_review", "release"],
    });
    hookSpin.stop(`Webhook installed (id ${created.id})`);
  } catch (e) {
    hookSpin.stop("Webhook install failed");
    p.log.error((e as Error).message);
    return;
  }

  // ---------- 8. Persist local config ----------
  const cfg = await loadConfig();
  cfg.github = { token: ghToken as string };
  cfg.cloudflare = { token: cfToken as string };
  cfg.repos.push({
    githubFullName: `${owner}/${repo}`,
    cloudflareAccountId: accountId,
    artifactsNamespace: namespace,
    artifactsRepoName,
    workerName,
    workerUrl: deployedUrl,
    createdAt: new Date().toISOString(),
  });
  await saveConfig(cfg);

  p.outro(
    [
      kleur.bold(orange("Done.")),
      "",
      `  Web UI:  ${kleur.cyan(deployedUrl)}`,
      `  Clone:   ${kleur.gray(`git clone <artifacts-remote-from-dashboard>`)}`,
      `  Push to GitHub → mirror lands in Artifacts in seconds.`,
    ].join("\n"),
  );
}
