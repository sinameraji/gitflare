import * as p from "@clack/prompts";
import kleur from "kleur";
import { CloudflareClient } from "../cloudflare.js";
import { loadConfig, saveConfig } from "../config.js";
import { orange } from "../util.js";
import { redeployWorker } from "../redeploy.js";
import { wranglerSecret } from "../wrangler.js";
import { pickRepo, getCfToken } from "../repo-select.js";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

async function fetchRemote(
  cf: CloudflareClient,
  entry: Awaited<ReturnType<typeof pickRepo>>,
): Promise<string | undefined> {
  if (!entry) return undefined;
  try {
    const r = await cf.getRepo(
      entry.cloudflareAccountId,
      entry.artifactsNamespace,
      entry.artifactsRepoName,
    );
    return r.remote;
  } catch (e) {
    p.log.error(`Artifacts remote lookup failed: ${(e as Error).message}`);
    return undefined;
  }
}

export async function runDeployEnable(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare deploy enable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;

  p.log.message(
    [
      kleur.bold("Continuous deploy stores a Cloudflare token as a Worker Secret"),
      "on your own account so the Worker can ship your project on push — even",
      "when GitHub Actions is down. GitFlare never sees it; it lives only in your",
      "Worker's secrets.",
      "",
      `The token needs ${kleur.cyan("Workers Scripts: Edit")} (the same scope init already used).`,
      `Create a fresh, narrow one at ${kleur.gray(TOKEN_URL)} or reuse your saved token.`,
    ].join("\n"),
  );

  let deployToken: string | undefined;
  if (cfg.cloudflare?.token) {
    const reuse = await p.confirm({
      message: "Reuse your saved Cloudflare token as the deploy token?",
      initialValue: false,
    });
    if (p.isCancel(reuse)) return p.cancel("Cancelled."), undefined;
    if (reuse) deployToken = cfg.cloudflare.token;
  }
  if (!deployToken) {
    const v = await p.password({
      message: "Deploy token (Workers Scripts: Edit)",
      validate: (s) => (!s ? "required" : undefined),
    });
    if (p.isCancel(v)) return p.cancel("Cancelled."), undefined;
    deployToken = v as string;
  }

  // The provisioning token (for the deploy itself).
  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);

  const sp = p.spinner();
  sp.start("Verifying deploy token");
  try {
    await new CloudflareClient(deployToken).verifyToken();
    sp.stop("Deploy token OK");
  } catch (e) {
    sp.stop("Deploy token verification failed");
    p.log.error((e as Error).message);
    return;
  }

  const remote = await fetchRemote(cf, entry);
  if (!remote) return;

  // Mark CD on so redeploy emits CD_ENABLED + the DeployDO binding/migration,
  // then set the deploy-token secret.
  entry.deploy = { enabledAt: new Date().toISOString() };
  sp.start("Redeploying Worker with CD enabled");
  try {
    const res = await redeployWorker(entry, cfToken, remote);
    sp.message("Setting deploy-token secret");
    await wranglerSecret(res.workDir, cfToken, "CF_DEPLOY_TOKEN", deployToken);
    sp.stop("Worker redeployed with CD enabled");
  } catch (e) {
    sp.stop("Redeploy failed");
    p.log.error((e as Error).message);
    return;
  }

  cfg.cloudflare = { token: cfToken };
  await saveConfig(cfg);

  p.outro(
    [
      kleur.bold(orange("CD enabled.")),
      "",
      "  Commit a .gitflare/deploy.yml like:",
      kleur.gray("    on: push"),
      kleur.gray("    branches: [main]"),
      kleur.gray("    steps:"),
      kleur.gray("      - cloudflare/deploy:"),
      kleur.gray("          project: my-worker"),
      kleur.gray("          kind: worker"),
      kleur.gray("          entry: dist/worker.js   # a pre-built, single-file ES module"),
      "",
      `  Deploys appear at ${kleur.cyan(`${entry.workerUrl}/r/${entry.artifactsRepoName}/deployments`)}`,
      kleur.gray("  v0.2 MVP deploys pre-built artifacts only — build steps land in v0.3 (CI)."),
    ].join("\n"),
  );
}

export async function runDeployDisable(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare deploy disable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  if (!entry.deploy) {
    p.log.warn(`CD is not enabled for ${kleur.cyan(entry.githubFullName)}.`);
    p.outro("");
    return;
  }

  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);

  const remote = await fetchRemote(cf, entry);
  if (!remote) return;

  // Clear CD so redeploy drops CD_ENABLED — the Worker then ignores pushes even
  // though the CF_DEPLOY_TOKEN secret remains (harmless; gated on CD_ENABLED).
  delete entry.deploy;
  const sp = p.spinner();
  sp.start("Redeploying Worker with CD disabled");
  try {
    await redeployWorker(entry, cfToken, remote);
    sp.stop("CD disabled");
  } catch (e) {
    sp.stop("Disable failed");
    p.log.error((e as Error).message);
    return;
  }

  await saveConfig(cfg);
  p.log.info(
    "The CF_DEPLOY_TOKEN secret is left on the Worker (inert without CD_ENABLED); delete it in the dashboard to fully revoke.",
  );
  p.outro(kleur.bold(orange("CD disabled.")));
}
