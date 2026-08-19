import * as p from "@clack/prompts";
import kleur from "kleur";
import { CloudflareClient } from "../cloudflare.js";
import { GitHubClient } from "../github.js";
import { loadConfig, saveConfig } from "../config.js";
import { orange, randomHex, parseGithubUrl } from "../util.js";
import { redeployWorker } from "../redeploy.js";
import { queueNameFor, wranglerSecret } from "../wrangler.js";
import { pickRepo, getCfToken, fetchRemote, type RepoEntry } from "../repo-select.js";

const TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens";

/**
 * `gitflare sync enable` — M9 "GitHub-down mode".
 *
 * Provisions, on the user's account: a Queue that receives the mirror's
 * Artifacts `pushed` events, an event subscription scoped to this one repo,
 * and a queue consumer on the Worker (redeploy). Sets SYNC_ENABLED so the
 * Worker (a) runs CI/CD from pushes made straight to the mirror and (b) pushes
 * those refs back to GitHub, fast-forward only, once GitHub is reachable.
 */
export async function runSyncEnable(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare sync enable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;

  p.log.message(
    [
      kleur.bold("Pushes straight to your Artifacts mirror will now:"),
      "  • trigger CI/CD on your Worker exactly like a GitHub push, and",
      "  • be pushed back to GitHub (fast-forward only — never force, never delete)",
      "    as soon as GitHub is reachable, with retries and a dashboard banner meanwhile.",
      "",
      "This provisions ON YOUR ACCOUNT: one Queue + one Artifacts event subscription",
      "(this repo only) + a queue consumer on the Worker. Queues are on the Free plan.",
      `The Cloudflare token needs ${kleur.cyan("Account → Queues → Edit")} in addition to the`,
      `permissions init asked for — edit it in place at ${kleur.gray(TOKEN_URL)} if the`,
      "next step fails with a permissions error.",
      "",
      `Reverse pushes use the ${kleur.cyan("GITHUB_TOKEN")} already on the Worker; it must be`,
      "allowed to push to this repo (classic PAT `repo` scope, or a fine-grained PAT",
      "with Contents: write). Protected branches reject the push — that shows up as",
      `"rejected" on the dashboard, and ${kleur.cyan("gitflare sync now")} retries once you unprotect.`,
    ].join("\n"),
  );

  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);
  const remote = await fetchRemote(cf, entry);
  if (!remote) return;

  // Soft preflight on the GitHub side (best effort — never blocks).
  if (cfg.github?.token) {
    try {
      const gh = new GitHubClient(cfg.github.token);
      const { owner, repo } = parseGithubUrl(entry.githubFullName);
      const info = await gh.getRepo(owner, repo);
      if (info.permissions && info.permissions.push === false) {
        p.log.warn(
          `Your saved GitHub token can't push to ${kleur.cyan(entry.githubFullName)} — reverse sync will land as "auth". Re-run \`gitflare init\` with a token that has push rights.`,
        );
      }
      const prot = await gh.getBranchProtection(owner, repo, info.default_branch);
      if (prot) {
        p.log.warn(
          `${kleur.cyan(info.default_branch)} is a protected branch on GitHub. Direct pushes to it (which is what reverse sync does) will be rejected unless the protection allows your token.`,
        );
      }
    } catch {
      // ignore — purely advisory
    }
  }

  const controlSecret =
    entry.deploy?.controlSecret ?? entry.ci?.controlSecret ?? entry.sync?.controlSecret ?? randomHex(32);
  const queueName = queueNameFor(entry.workerName);
  const subName = `${entry.workerName}-artifacts-pushed`;

  const sp = p.spinner();
  sp.start("Ensuring the events queue");
  let queueId: string;
  let subscriptionId: string;
  try {
    const existing = (await cf.listQueues(entry.cloudflareAccountId)).find((q) => q.queue_name === queueName);
    queueId = existing?.queue_id ?? (await cf.createQueue(entry.cloudflareAccountId, queueName)).queue_id;
    sp.message("Ensuring the Artifacts push subscription");
    const subs = await cf.listEventSubscriptions(entry.cloudflareAccountId);
    const sub = subs.find(
      (s) =>
        s.source.type === "artifacts.repo" &&
        s.source.repo_name === entry.artifactsRepoName &&
        s.source.namespace === entry.artifactsNamespace &&
        s.destination.queue_id === queueId,
    );
    if (sub) {
      subscriptionId = sub.id;
      if (!sub.enabled) await cf.setEventSubscriptionEnabled(entry.cloudflareAccountId, sub.id, true);
    } else {
      subscriptionId = (
        await cf.createArtifactsPushSubscription(entry.cloudflareAccountId, {
          name: subName,
          namespace: entry.artifactsNamespace,
          repoName: entry.artifactsRepoName,
          queueId,
        })
      ).id;
    }
    sp.stop(`Queue ${kleur.cyan(queueName)} + subscription ready`);
  } catch (e) {
    sp.stop("Provisioning failed");
    const msg = (e as Error).message;
    if (/403|10000|authentication|permission|unauthorized/i.test(msg)) {
      p.log.error(
        [
          "This looks like a token permission problem. Queues + event subscriptions need",
          `${kleur.cyan("Account → Queues → Edit")}. Edit the token in place at ${kleur.gray(TOKEN_URL)}`,
          "(the secret stays the same), then re-run `gitflare sync enable`.",
          "",
          msg,
        ].join("\n"),
      );
    } else {
      p.log.error(msg);
    }
    return;
  }

  // Set before redeploy — redeployWorker reads entry.sync to emit the consumer
  // block + SYNC_ENABLED, and entry.workerUrl for WORKER_URL.
  entry.sync = {
    enabledAt: new Date().toISOString(),
    enabled: true,
    controlSecret,
    queueName,
    queueId,
    subscriptionId,
  };

  sp.start("Redeploying Worker with the queue consumer + sync enabled");
  let redeployed = false;
  try {
    const res = await redeployWorker(entry, cfToken, remote);
    redeployed = true;
    cfg.cloudflare = { token: cfToken };
    await saveConfig(cfg);
    sp.message("Setting control secret");
    await wranglerSecret(res.workDir, cfToken, "CONTROL_SECRET", controlSecret);
    sp.stop("Worker redeployed with sync enabled");
  } catch (e) {
    const msg = (e as Error).message;
    if (redeployed) {
      sp.stop("Sync is live, but setting the control secret failed");
      p.log.warn("`gitflare sync now/status` will 401 until the control secret is set. Re-run `gitflare sync enable` to retry.");
      p.log.error(msg);
      return;
    }
    sp.stop("Redeploy failed");
    if (/queue|permission|unauthorized|10403|CODE.?100/i.test(msg)) {
      p.log.error(
        [
          "Binding the queue consumer failed. Most likely the token lacks",
          `${kleur.cyan("Account → Queues → Edit")} — edit it at ${kleur.gray(TOKEN_URL)} and re-run.`,
          "",
          msg,
        ].join("\n"),
      );
    } else {
      p.log.error(msg);
    }
    return; // entry.sync stays unsaved; the queue/subscription are harmless leftovers, reused next time
  }

  p.outro(
    [
      kleur.bold(orange("Sync enabled.")),
      "",
      "  When GitHub is down, push to your mirror instead — CI/CD runs from it, and",
      "  GitHub catches up (fast-forward) as soon as it's reachable again.",
      "",
      `  Push once to both:      ${kleur.cyan("gitflare remote add")}   ${kleur.gray("(adds a second pushurl + credential helper)")}`,
      `  Push the mirror now:    ${kleur.cyan("gitflare sync now")}     ${kleur.gray("(GitHub is back — don't wait for the retry)")}`,
      `  See both directions:    ${kleur.cyan("gitflare sync status")}  ${kleur.gray(`or ${entry.workerUrl}`)}`,
    ].join("\n"),
  );
}

export async function runSyncDisable(repoArg: string | undefined, opts: { purge?: boolean }): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare sync disable")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  if (!entry.sync) {
    p.log.warn(`Sync is not enabled for ${kleur.cyan(entry.githubFullName)}.`);
    p.outro("");
    return;
  }
  const cfToken = await getCfToken(cfg);
  if (!cfToken) return p.cancel("Cancelled."), undefined;
  const cf = new CloudflareClient(cfToken);
  const remote = await fetchRemote(cf, entry);
  if (!remote) return;

  const sp = p.spinner();
  const sync = entry.sync;
  if (opts.purge) {
    // Order matters: detach the consumer (redeploy) BEFORE deleting the queue.
    delete entry.sync;
    sp.start("Redeploying Worker without the queue consumer");
    try {
      await redeployWorker(entry, cfToken, remote);
      sp.message("Deleting the subscription + queue");
      await cf.deleteEventSubscription(entry.cloudflareAccountId, sync.subscriptionId).catch(() => undefined);
      await cf.deleteQueue(entry.cloudflareAccountId, sync.queueId).catch((e: Error) =>
        p.log.warn(`Queue delete failed (delete it in the dashboard): ${e.message}`),
      );
      sp.stop("Sync removed");
    } catch (e) {
      entry.sync = sync; // redeploy failed — nothing changed on the Worker
      sp.stop("Purge failed");
      p.log.error((e as Error).message);
      return;
    }
  } else {
    sp.start("Disabling the subscription + redeploying without SYNC_ENABLED");
    try {
      await cf.setEventSubscriptionEnabled(entry.cloudflareAccountId, sync.subscriptionId, false).catch(() => undefined);
      entry.sync.enabled = false;
      await redeployWorker(entry, cfToken, remote);
      sp.stop("Sync disabled");
    } catch (e) {
      entry.sync.enabled = true;
      sp.stop("Disable failed");
      p.log.error((e as Error).message);
      return;
    }
  }
  await saveConfig(cfg);
  p.log.info(
    opts.purge
      ? "The queue, subscription, and consumer are gone. `gitflare sync enable` re-creates them."
      : "Events are paused and SYNC_ENABLED was dropped; the queue + consumer stay (free while idle). `gitflare sync enable` turns it back on; `--purge` removes everything.",
  );
  p.outro(kleur.bold(orange(opts.purge ? "Sync removed." : "Sync disabled.")));
}

// --- control-plane commands ------------------------------------------------

function controlSecretFor(entry: RepoEntry): string | undefined {
  const s = entry.sync?.controlSecret ?? entry.deploy?.controlSecret ?? entry.ci?.controlSecret;
  if (!s) {
    p.log.warn(
      `No control secret for ${kleur.cyan(entry.githubFullName)} — enable sync, deploy, or ci first (any of them sets it).`,
    );
  }
  return s;
}

async function controlFetch(entry: RepoEntry, secret: string, path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  return fetch(`${entry.workerUrl}${path}`, {
    method: init?.method ?? "GET",
    headers: { Authorization: `Bearer ${secret}`, ...(init?.body ? { "Content-Type": "application/json" } : {}) },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
}

export async function runSyncNow(repoArg: string | undefined, opts: { ref?: string }): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare sync now")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = controlSecretFor(entry);
  if (!secret) return;
  const ref = opts.ref ? (opts.ref.startsWith("refs/") ? opts.ref : `refs/heads/${opts.ref}`) : undefined;

  const sp = p.spinner();
  sp.start(ref ? `Queuing ${ref} for a push to GitHub` : "Comparing every mirror branch with GitHub and queuing the ones that differ");
  try {
    const res = await controlFetch(entry, secret, "/control/sync/reverse", {
      method: "POST",
      body: { repo: entry.artifactsRepoName, ...(ref ? { ref } : {}), reconcile: true },
    });
    if (res.status !== 202) {
      sp.stop("Request failed");
      p.log.error(`${res.status}: ${await res.text()}`);
      return;
    }
    const { queued } = (await res.json()) as { queued: string[] };
    sp.stop(queued.length ? `Queued ${queued.length} ref(s): ${queued.map((r) => r.replace(/^refs\/heads\//, "")).join(", ")}` : "Nothing to push — GitHub already matches the mirror");
  } catch (e) {
    sp.stop("Request failed");
    p.log.error((e as Error).message);
    return;
  }
  p.outro(`The Worker pushes them now (fast-forward only). Status: ${kleur.cyan("gitflare sync status")} or ${kleur.cyan(entry.workerUrl)}`);
}

export async function runSyncTags(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare sync tags")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = controlSecretFor(entry);
  if (!secret) return;
  const sp = p.spinner();
  sp.start("Asking the Worker to mirror every GitHub tag the mirror is missing");
  try {
    const res = await controlFetch(entry, secret, "/control/sync/tags", { method: "POST", body: { repo: entry.artifactsRepoName } });
    if (res.status !== 202) {
      sp.stop("Request failed");
      p.log.error(`${res.status}: ${await res.text()}`);
      return;
    }
    sp.stop("Tag backfill started on the Worker (one push per tag — a few hundred tags take a minute or two)");
  } catch (e) {
    sp.stop("Request failed");
    p.log.error((e as Error).message);
    return;
  }
  p.outro(`Progress: the Tags section on ${kleur.cyan(entry.workerUrl)}, or ${kleur.cyan("gitflare sync status")}. New tags pushed to GitHub sync automatically from now on.`);
}

export async function runSyncIssues(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare sync issues")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = controlSecretFor(entry);
  if (!secret) return;
  const sp = p.spinner();
  sp.start("Asking the Worker to (re)import issues, pull requests, comments, and releases from GitHub");
  try {
    const res = await controlFetch(entry, secret, "/control/meta/backfill", { method: "POST", body: { repo: entry.artifactsRepoName, force: true } });
    const j = (await res.json().catch(() => ({}))) as { accepted?: boolean; reason?: string };
    if (res.status === 202 && j.accepted) sp.stop("Import started on the Worker (a few hundred items take under a minute)");
    else if (j.reason) sp.stop(`Not started: ${j.reason}`);
    else {
      sp.stop("Request failed");
      p.log.error(`${res.status}: ${JSON.stringify(j)}`);
      return;
    }
  } catch (e) {
    sp.stop("Request failed");
    p.log.error((e as Error).message);
    return;
  }
  p.outro(`Browse at ${kleur.cyan(`${entry.workerUrl}/r/${entry.artifactsRepoName}/issues`)} — read-only; new activity arrives via the webhook.`);
}

interface SyncStateResponse {
  refs: Array<{ ref: string; sha: string; syncedAt: number; source?: string; forwardError?: string }>;
  reverse: Array<{
    ref: string;
    status: string;
    attempts: number;
    lastError?: string;
    nextAttemptAt?: number;
    syncedAt?: number;
    githubSha?: string;
  }>;
  tagBackfill?: { status: string; pushed?: number; alreadyPresent?: number; conflicts?: string[]; error?: string; finishedAt?: number } | null;
}

export async function runSyncStatus(repoArg: string | undefined): Promise<void> {
  p.intro(kleur.bold(orange("GitFlare sync status")));
  const cfg = await loadConfig();
  const entry = await pickRepo(cfg, repoArg);
  if (!entry) return;
  const secret = controlSecretFor(entry);
  if (!secret) return;

  const sp = p.spinner();
  sp.start("Fetching sync state");
  let state: SyncStateResponse;
  try {
    const res = await controlFetch(entry, secret, `/control/sync/state?repo=${encodeURIComponent(entry.artifactsRepoName)}`);
    if (!res.ok) {
      sp.stop("Fetch failed");
      p.log.error(`${res.status}: ${await res.text()}`);
      return;
    }
    state = (await res.json()) as SyncStateResponse;
    sp.stop(`sync ${entry.sync?.enabled ? kleur.green("enabled") : kleur.yellow("not enabled")} for ${entry.githubFullName}`);
  } catch (e) {
    sp.stop("Fetch failed");
    p.log.error((e as Error).message);
    return;
  }

  const rev = new Map(state.reverse.map((r) => [r.ref, r]));
  const branches = state.refs.filter((r) => r.ref.startsWith("refs/heads/"));
  const tags = state.refs.filter((r) => r.ref.startsWith("refs/tags/"));
  if (state.refs.length === 0) {
    p.log.message("No refs synced yet.");
  }
  if (tags.length || state.tagBackfill) {
    const tb = state.tagBackfill;
    p.log.message(
      `${kleur.cyan("tags")}: ${tags.length} synced${tb ? kleur.gray(` — last backfill ${tb.status}${tb.pushed !== undefined ? `, pushed ${tb.pushed}, already present ${tb.alreadyPresent ?? 0}` : ""}${tb.conflicts?.length ? `, ${tb.conflicts.length} conflict(s)` : ""}${tb.error ? `, error: ${tb.error}` : ""}`) : ""}`,
    );
  }
  for (const r of branches) {
    const name = r.ref.replace(/^refs\/heads\//, "");
    const fwd = r.syncedAt ? `${ago(r.syncedAt)}${r.source === "artifacts" ? " (pushed to mirror)" : ""}` : "import seed";
    const rv = rev.get(r.ref);
    let back = kleur.gray("—");
    if (rv) {
      if (rv.status === "synced") back = kleur.green(`synced${rv.syncedAt ? ` ${ago(rv.syncedAt)}` : ""}`);
      else if (rv.status === "pending" || rv.status === "error" || rv.status === "auth")
        back = kleur.yellow(`${rv.status} (${rv.attempts}× tried${rv.nextAttemptAt ? `, next ${inWhen(rv.nextAttemptAt)}` : ""})`);
      else back = kleur.red(rv.status);
    }
    p.log.message(
      `${kleur.cyan(name.padEnd(28))} ${kleur.gray(r.sha.slice(0, 8))}  GitHub→mirror: ${fwd}${r.forwardError ? kleur.red(` ⚠ ${r.forwardError}`) : ""}   mirror→GitHub: ${back}${rv?.lastError && rv.status !== "synced" ? kleur.gray(` — ${rv.lastError}`) : ""}`,
    );
  }
  p.outro(`Dashboard: ${kleur.cyan(entry.workerUrl)}`);
}

function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 60_000) return `${Math.round(d / 1000)}s ago`;
  if (d < 3_600_000) return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.round(d / 3_600_000)}h ago`;
  return `${Math.round(d / 86_400_000)}d ago`;
}
function inWhen(ms: number): string {
  const d = ms - Date.now();
  if (d <= 0) return "now";
  if (d < 60_000) return `in ${Math.round(d / 1000)}s`;
  if (d < 3_600_000) return `in ${Math.round(d / 60_000)}m`;
  return `in ${Math.round(d / 3_600_000)}h`;
}
