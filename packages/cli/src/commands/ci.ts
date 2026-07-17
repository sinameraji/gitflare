import * as p from "@clack/prompts";
import kleur from "kleur";
import { CloudflareClient } from "../cloudflare.js";
import { loadConfig, saveConfig } from "../config.js";
import { orange, randomHex } from "../util.js";
import { redeployWorker } from "../redeploy.js";
import { wranglerSecret } from "../wrangler.js";
import { pickRepo, getCfToken, type RepoEntry } from "../repo-select.js";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

// Cloudflare Containers instance types. "standard" was renamed to the numbered
// "standard-N" tiers; we default to standard-1 (real test suites OOM on basic).
const INSTANCE_TYPES = ["dev", "basic", "standard-1", "standard-2", "standard-3", "standard-4"];
const DEFAULT_INSTANCE_TYPE = "standard-1";

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

export async function runCiEnable(
  repoArg: string | undefined,
  opts: { instanceType?: string },
): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare ci enable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;

  p.log.message(
    [
      kleur.bold("CI runs your .gitflare/ci.yml on push inside a Cloudflare Sandbox"),
      "container on your own account — even when GitHub Actions is down. The",
      `container image is ${kleur.cyan("docker.io/cloudflare/sandbox")} (Node 20 + Python 3.11),`,
      "referenced straight from Docker Hub — no local Docker needed.",
      "",
      `Containers require the ${kleur.cyan("Workers Paid")} plan. The Cloudflare API token`,
      `used for the redeploy may additionally need the ${kleur.cyan("Containers")} account`,
      "permission — if the redeploy fails with a permissions error, re-issue the",
      `token with that scope added at ${kleur.gray(TOKEN_URL)}.`,
    ].join("\n"),
  );

  const instanceType = opts.instanceType ?? DEFAULT_INSTANCE_TYPE;
  if (!INSTANCE_TYPES.includes(instanceType)) {
    p.log.error(
      `--instance-type must be one of ${INSTANCE_TYPES.join(" | ")}, got "${instanceType}".`,
    );
    return;
  }

  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);

  const remote = await fetchRemote(cf, entry);
  if (!remote) return;

  // The control secret is shared with deploy (one CONTROL_SECRET on the
  // Worker), so reuse whichever copy already exists — enabling one feature
  // must never strand the other's.
  const controlSecret =
    entry.deploy?.controlSecret ?? entry.ci?.controlSecret ?? randomHex(32);

  // Set before redeploy — redeployWorker reads entry.ci to emit the SANDBOX
  // binding, containers block, and CI_ENABLED var.
  entry.ci = {
    enabledAt: new Date().toISOString(),
    enabled: true,
    controlSecret,
    instanceType,
  };

  const sp = p.spinner();
  sp.start("Redeploying Worker with CI enabled");
  let redeployed = false;
  try {
    const res = await redeployWorker(entry, cfToken, remote);
    redeployed = true;
    // The Worker is now live with CI_ENABLED + the containers block — persist
    // that BEFORE the secret step so a secret failure can't leave the Worker
    // enabled while local config still says disabled (which would make
    // `gitflare ci disable` refuse to turn it back off).
    cfg.cloudflare = { token: cfToken };
    await saveConfig(cfg);
    sp.message("Setting control secret");
    // Always (re)write CONTROL_SECRET — idempotent, and it re-establishes the
    // secret if the Worker was recreated (dashboard delete + re-provision).
    await wranglerSecret(res.workDir, cfToken, "CONTROL_SECRET", controlSecret);
    sp.stop("Worker redeployed with CI enabled");
  } catch (e) {
    const msg = (e as Error).message;
    if (redeployed) {
      // Redeploy succeeded; only the secret step failed. Config is already
      // saved (CI is genuinely live), so tell the user how to finish.
      sp.stop("CI is live, but setting the control secret failed");
      p.log.warn(
        "`gitflare ci run/list/cancel` will 401 until the control secret is set. " +
          "Re-run `gitflare ci enable` to retry (your config is already saved).",
      );
      p.log.error(msg);
      return;
    }
    sp.stop("Redeploy failed");
    if (/container|plan|payment|not.?entitled|unauthorized|permission|10403|CODE.?100/i.test(msg)) {
      p.log.error(
        [
          "This looks like a Containers entitlement problem. Two likely causes:",
          `  • Containers require the ${kleur.cyan("Workers Paid")} plan — upgrade in the Cloudflare dashboard.`,
          `  • The API token is missing the container permissions. Deploying a`,
          `    container needs BOTH ${kleur.cyan("Account → Cloudchamber → Edit")} and`,
          `    ${kleur.cyan("Account → Containers → Edit")} (the worker script uploads without`,
          `    them, but the container rollout returns Forbidden). Edit the token`,
          `    in place at ${kleur.gray(TOKEN_URL)} — the secret stays the same — then`,
          "    re-run `gitflare ci enable`.",
          "",
          msg,
        ].join("\n"),
      );
    } else {
      p.log.error(msg);
    }
    // Redeploy never happened; the in-memory entry.ci is discarded (not saved).
    return;
  }

  p.outro(
    [
      kleur.bold(orange("CI enabled.")),
      "",
      "  Commit a .gitflare/ci.yml like:",
      kleur.gray("    on: push"),
      kleur.gray("    branches: [main]"),
      kleur.gray("    jobs:"),
      kleur.gray("      test:"),
      kleur.gray("        steps:"),
      kleur.gray("          - run: npm ci"),
      kleur.gray("          - run: npm test"),
      kleur.gray("      deploy:"),
      kleur.gray("        needs: [test]"),
      kleur.gray("        steps:"),
      kleur.gray("          - cloudflare/deploy:"),
      kleur.gray("              project: my-worker"),
      kleur.gray("              kind: worker"),
      kleur.gray("              entry: dist/worker.js"),
      "",
      `  Runs appear at ${kleur.cyan(`${entry.workerUrl}/r/${entry.artifactsRepoName}/ci`)}`,
      kleur.gray("  deploy jobs additionally need `gitflare deploy enable`."),
    ].join("\n"),
  );
}

export async function runCiDisable(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare ci disable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  if (!entry.ci || !entry.ci.enabled) {
    p.log.warn(`CI is not enabled for ${kleur.cyan(entry.githubFullName)}.`);
    p.outro("");
    return;
  }

  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);

  const remote = await fetchRemote(cf, entry);
  if (!remote) return;

  // Flip enabled off but do NOT delete entry.ci — the Sandbox container stays
  // provisioned on the Worker so re-enable is a var-only redeploy (no
  // deleted_classes migration needed).
  entry.ci.enabled = false;
  const sp = p.spinner();
  sp.start("Redeploying Worker with CI disabled");
  try {
    await redeployWorker(entry, cfToken, remote);
    sp.stop("CI disabled");
  } catch (e) {
    sp.stop("Disable failed");
    p.log.error((e as Error).message);
    return;
  }

  await saveConfig(cfg);
  p.log.info(
    "CI_ENABLED was dropped — the Worker now ignores pushes. The Sandbox container config remains on the Worker (idle containers cost nothing); `gitflare ci enable` turns it back on.",
  );
  p.outro(kleur.bold(orange("CI disabled.")));
}

// --- control-plane commands (talk to the Worker's /control/* endpoints) ---

function ciSecret(entry: RepoEntry): string | undefined {
  if (!entry.ci || !entry.ci.enabled) {
    p.log.warn(`CI isn't enabled for ${kleur.cyan(entry.githubFullName)}. Run \`gitflare ci enable\`.`);
    return undefined;
  }
  return entry.ci?.controlSecret ?? entry.deploy?.controlSecret;
}

async function controlFetch(
  entry: RepoEntry,
  secret: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<Response> {
  return fetch(`${entry.workerUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${secret}`,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
    },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

export async function runCiRun(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare ci run")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = ciSecret(entry);
  if (!secret) return;

  const sp = p.spinner();
  sp.start("Triggering a CI run of the current Artifacts HEAD");
  try {
    const res = await controlFetch(entry, secret, "/control/ci/run", {
      method: "POST",
      body: { repo: entry.artifactsRepoName },
    });
    if (res.status !== 202) {
      sp.stop("Trigger failed");
      p.log.error(`${res.status}: ${await res.text()}`);
      return;
    }
    sp.stop("CI run triggered (runs in your Worker's sandbox — works even when GitHub is down)");
  } catch (e) {
    sp.stop("Trigger failed");
    p.log.error((e as Error).message);
    return;
  }
  p.outro(`Watch it at ${kleur.cyan(`${entry.workerUrl}/r/${entry.artifactsRepoName}/ci`)}`);
}

interface CiRunRow {
  id: number;
  branch: string;
  sha: string;
  mode: string;
  status: "running" | "success" | "failed" | "skipped";
  message?: string;
  jobs: Array<{ name: string; status: string }>;
}

function jobGlyph(status: string): string {
  if (status === "success") return "✓";
  if (status === "failed") return "✗";
  if (status === "skipped") return "○";
  return "●"; // running/pending
}

export async function runCiList(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare ci list")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = ciSecret(entry);
  if (!secret) return;

  const sp = p.spinner();
  sp.start("Fetching CI run history");
  let runs: CiRunRow[] = [];
  try {
    const res = await controlFetch(entry, secret, `/control/ci/runs?repo=${encodeURIComponent(entry.artifactsRepoName)}`);
    if (!res.ok) {
      sp.stop("Fetch failed");
      p.log.error(`${res.status}: ${await res.text()}`);
      return;
    }
    ({ runs } = (await res.json()) as { runs: CiRunRow[] });
    sp.stop(`${runs.length} run(s)`);
  } catch (e) {
    sp.stop("Fetch failed");
    p.log.error((e as Error).message);
    return;
  }

  if (runs.length === 0) {
    p.outro("No CI runs yet.");
    return;
  }
  for (const r of runs.slice(0, 20)) {
    const dot = r.status === "success" ? kleur.green("●") : r.status === "failed" ? kleur.red("●") : kleur.yellow("●");
    const jobs = r.jobs.map((j) => `${j.name}${jobGlyph(j.status)}`).join(" ") || "—";
    p.log.message(
      `${dot} #${r.id} ${kleur.cyan(r.branch)} ${kleur.gray(r.sha.slice(0, 8))} ${r.mode}  ${jobs}  ${r.status}${r.message ? kleur.gray(` — ${r.message}`) : ""}`,
    );
  }
  p.outro(`Full view: ${kleur.cyan(`${entry.workerUrl}/r/${entry.artifactsRepoName}/ci`)}`);
}

export async function runCiCancel(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare ci cancel")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = ciSecret(entry);
  if (!secret) return;

  const sp = p.spinner();
  sp.start("Requesting cancellation of the in-flight CI run");
  try {
    const res = await controlFetch(entry, secret, "/control/ci/cancel", {
      method: "POST",
      body: { repo: entry.artifactsRepoName },
    });
    if (res.status !== 202) {
      sp.stop("Cancel failed");
      p.log.error(`${res.status}: ${await res.text()}`);
      return;
    }
    sp.stop("Cancel requested — the current step's sandbox is being torn down");
  } catch (e) {
    sp.stop("Cancel failed");
    p.log.error((e as Error).message);
    return;
  }
  p.outro(`Watch it at ${kleur.cyan(`${entry.workerUrl}/r/${entry.artifactsRepoName}/ci`)}`);
}
