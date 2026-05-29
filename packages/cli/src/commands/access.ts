import * as p from "@clack/prompts";
import kleur from "kleur";
import { CloudflareClient } from "../cloudflare.js";
import { loadConfig, saveConfig } from "../config.js";
import { orange } from "../util.js";
import { redeployWorker } from "../redeploy.js";
import { pickRepo, getCfToken } from "../repo-select.js";

// "Cloudflare Access: Apps and Policies: Edit" is needed in addition to the
// 3 scopes `init` requests. The token-creation page:
const ACCESS_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";
const ZERO_TRUST_URL = "https://one.dash.cloudflare.com/";

function hostOf(workerUrl: string): string {
  return workerUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

function scopeHint(): void {
  p.log.warn(
    [
      "This looks like a missing scope or no Zero Trust org.",
      `  • Enable Zero Trust once (free up to 50 seats): ${kleur.gray(ZERO_TRUST_URL)}`,
      `  • Re-issue your Cloudflare token at ${kleur.gray(ACCESS_TOKEN_URL)} adding:`,
      `      ${kleur.cyan("Cloudflare Access: Apps and Policies")} — Edit`,
      "  Then re-run `gitflare access enable` and choose a fresh token.",
    ].join("\n"),
  );
}

export async function runAccessEnable(
  repoArg: string | undefined,
): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare access enable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;

  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);

  // 1. Resolve the Zero Trust team auth domain.
  const sp = p.spinner();
  sp.start("Resolving Zero Trust organization");
  let teamDomain: string;
  try {
    const org = await cf.getZeroTrustOrg(entry.cloudflareAccountId);
    teamDomain = org.authDomain;
    sp.stop(`Zero Trust org: ${kleur.cyan(teamDomain)}`);
  } catch (e) {
    sp.stop("Could not resolve Zero Trust org");
    p.log.error((e as Error).message);
    scopeHint();
    return;
  }

  // 2. Who's allowed in.
  const emailsRaw = await p.text({
    message: "Allowed email(s), comma-separated",
    placeholder: "you@example.com",
    validate: (s) => (!s ? "at least one email required" : undefined),
  });
  if (p.isCancel(emailsRaw)) return p.cancel("Cancelled."), undefined;
  const emails = (emailsRaw as string)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // 3. Reconstruct the Artifacts remote (needed to redeploy).
  sp.start("Fetching Artifacts remote");
  let remote: string;
  try {
    const r = await cf.getRepo(
      entry.cloudflareAccountId,
      entry.artifactsNamespace,
      entry.artifactsRepoName,
    );
    remote = r.remote;
    sp.stop("Got Artifacts remote");
  } catch (e) {
    sp.stop("Artifacts remote lookup failed");
    p.log.error((e as Error).message);
    return;
  }

  // 4. Create (or reuse) the Access app + policy.
  const host = hostOf(entry.workerUrl);
  sp.start("Creating Cloudflare Access application");
  let appId: string;
  let aud: string;
  try {
    const existing = (await cf.listAccessApps(entry.cloudflareAccountId)).find(
      (a) => a.domain === host || a.domain === host + "/",
    );
    if (existing) {
      appId = existing.id;
      aud = existing.aud;
      sp.message("Reusing existing Access app");
    } else {
      const app = await cf.createAccessApp(entry.cloudflareAccountId, {
        name: `GitFlare — ${entry.githubFullName}`,
        domain: host,
      });
      appId = app.id;
      aud = app.aud;
    }
    await cf.createAccessPolicy(entry.cloudflareAccountId, appId, {
      name: "GitFlare allow-list",
      emails,
    });
    sp.stop(`Access app ready (aud ${kleur.gray(aud.slice(0, 8) + "…")})`);
  } catch (e) {
    sp.stop("Access app setup failed");
    p.log.error((e as Error).message);
    scopeHint();
    return;
  }

  // 5. Record the Access config, then redeploy so the vars take effect.
  entry.access = { appId, aud, teamDomain, allowedEmails: emails };
  sp.start("Redeploying Worker with Access enabled");
  try {
    await redeployWorker(entry, cfToken, remote);
    sp.stop("Worker redeployed");
  } catch (e) {
    sp.stop("Redeploy failed");
    p.log.error((e as Error).message);
    return;
  }

  // 6. Persist.
  cfg.cloudflare = { token: cfToken };
  await saveConfig(cfg);

  p.outro(
    [
      kleur.bold(orange("Access enabled.")),
      "",
      `  ${entry.workerUrl} now requires SSO login.`,
      `  Allowed: ${kleur.cyan(emails.join(", "))}`,
      "",
      kleur.yellow("  Note: this gates the web dashboard + API only."),
      kleur.gray("  `git clone` of the Artifacts remote is NOT gated by Access —"),
      kleur.gray("  it uses Artifacts' own repo tokens. Private-clone lands in a later version."),
    ].join("\n"),
  );
}

export async function runAccessDisable(
  repoArg: string | undefined,
): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare access disable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;

  if (!entry.access) {
    p.log.warn(`Access is not enabled for ${kleur.cyan(entry.githubFullName)}.`);
    p.outro("");
    return;
  }

  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);

  const sp = p.spinner();
  sp.start("Fetching Artifacts remote");
  let remote: string;
  try {
    const r = await cf.getRepo(
      entry.cloudflareAccountId,
      entry.artifactsNamespace,
      entry.artifactsRepoName,
    );
    remote = r.remote;
    sp.stop("Got Artifacts remote");
  } catch (e) {
    sp.stop("Artifacts remote lookup failed");
    p.log.error((e as Error).message);
    return;
  }

  sp.start("Deleting Access application");
  try {
    await cf.deleteAccessApp(entry.cloudflareAccountId, entry.access.appId);
    sp.stop("Access app deleted");
  } catch (e) {
    // Non-fatal: the app may already be gone. Continue to redeploy open.
    sp.stop("Access app delete failed (continuing)");
    p.log.warn((e as Error).message);
  }

  delete entry.access;
  sp.start("Redeploying Worker as public");
  try {
    await redeployWorker(entry, cfToken, remote);
    sp.stop("Worker redeployed");
  } catch (e) {
    sp.stop("Redeploy failed");
    p.log.error((e as Error).message);
    return;
  }

  await saveConfig(cfg);
  p.outro(kleur.bold(orange("Access disabled — repo is public again.")));
}
