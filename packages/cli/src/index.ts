#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runAccessEnable, runAccessDisable } from "./commands/access.js";
import { runSyncEnable, runSyncDisable, runSyncNow, runSyncStatus, runSyncTags, runSyncIssues } from "./commands/sync.js";
import { runRemoteAdd, runRemoteRemove, runCredentialHelper } from "./commands/remote.js";
import { runCiImport } from "./commands/import.js";
import {
  runDeployEnable,
  runDeployDisable,
  runDeployRun,
  runDeploysList,
  runDeployRollback,
} from "./commands/deploy.js";
import {
  runCiEnable,
  runCiDisable,
  runCiRun,
  runCiList,
  runCiCancel,
} from "./commands/ci.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version?: string };

const program = new Command();

program
  .name("gitflare")
  .description("GitHub-shaped developer experience on Cloudflare primitives")
  .version(pkg.version ?? "0.0.0");

program
  .command("init")
  .description("Provision GitFlare for a GitHub repo on your Cloudflare account")
  .argument("[github-url]", "GitHub repo URL (e.g. github.com/owner/repo). Omit or pass '.' to autodetect from the current directory's git remote.")
  .option("--session <token>", "Session blob from gitflare.dev onboarding")
  .action(runInit);

program
  .command("status")
  .description("Show sync status for the current repo")
  .action(runStatus);

const access = program
  .command("access")
  .description("Gate a repo's dashboard behind Cloudflare Access SSO");
access
  .command("enable")
  .description("Put Cloudflare Access in front of the Worker (web UI + API)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runAccessEnable);
access
  .command("disable")
  .description("Remove Cloudflare Access — make the repo public again")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runAccessDisable);

const deploy = program
  .command("deploy")
  .description("Continuous deploy: ship your project on push, GitHub-down-proof");
deploy
  .command("enable")
  .description("Enable CD — store a deploy token and deploy on push via .gitflare/deploy.yml")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runDeployEnable);
deploy
  .command("disable")
  .description("Disable CD for a repo")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runDeployDisable);
deploy
  .command("run")
  .description("Deploy the current Artifacts HEAD now (the GitHub-down escape hatch)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runDeployRun);
deploy
  .command("list")
  .description("List recent deploys for a repo")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runDeploysList);
deploy
  .command("rollback")
  .description("Roll back to a previous deploy (default: last successful)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .option("--to <id>", "deploy id to roll back to")
  .action(runDeployRollback);

const ci = program
  .command("ci")
  .description("Generic CI: run .gitflare/ci.yml jobs on Cloudflare Sandboxes on push");
ci.command("enable")
  .description("Enable CI — run .gitflare/ci.yml on push in a Cloudflare Sandbox container")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .option("--instance-type <type>", "sandbox container size: dev | basic | standard-1..4 (default standard-1)")
  .action(runCiEnable);
ci.command("disable")
  .description("Disable CI for a repo (the container config stays provisioned)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runCiDisable);
ci.command("run")
  .description("Run the CI pipeline for the current Artifacts HEAD now (the GitHub-down escape hatch)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runCiRun);
ci.command("list")
  .description("List recent CI runs for a repo")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runCiList);
ci.command("import")
  .description("Translate .github/workflows/*.yml into .gitflare/ci.yml (dry run; --write saves it) with a report of what didn't map")
  .option("--dir <path>", "workflows directory (default .github/workflows)")
  .option("--out <path>", "output file (default .gitflare/ci.yml)")
  .option("--write", "write the file instead of printing it")
  .action(runCiImport);
ci.command("cancel")
  .description("Cancel the in-flight CI run for a repo")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runCiCancel);

const sync = program
  .command("sync")
  .description("GitHub-down mode: run CI/CD from pushes to the mirror and push them back to GitHub");
sync.command("enable")
  .description("Provision a Queue + Artifacts push subscription and enable reverse sync (mirror → GitHub)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runSyncEnable);
sync.command("disable")
  .description("Pause events + reverse sync (queue stays); --purge removes the queue + subscription")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .option("--purge", "delete the queue, subscription, and consumer binding")
  .action(runSyncDisable);
sync.command("now")
  .description("Push the mirror's branches to GitHub now (fast-forward only) — e.g. right after GitHub comes back")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .option("--ref <ref>", "only this branch (name or refs/heads/…)")
  .action(runSyncNow);
sync.command("tags")
  .description("Mirror every existing GitHub tag into Artifacts once (new tags sync automatically on push)")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runSyncTags);
sync.command("issues")
  .description("(Re)import issues, pull requests, comments, and releases from GitHub into the read-only mirror")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runSyncIssues);
sync.command("status")
  .description("Show per-branch sync state in both directions")
  .argument("[repo]", "github full name or artifacts repo name; prompts if omitted")
  .action(runSyncStatus);

const remote = program
  .command("remote")
  .description("Make `git push` fan out to GitHub AND your Artifacts mirror (opt-in, per checkout)");
remote.command("add")
  .description("Add the mirror as a second pushurl on origin + a credential helper that mints short-lived tokens")
  .argument("[repo]", "github full name or artifacts repo name; defaults to the checkout's origin")
  .action(runRemoteAdd);
remote.command("remove")
  .description("Undo `remote add` for this checkout")
  .argument("[repo]", "github full name or artifacts repo name; defaults to the checkout's origin")
  .action(runRemoteRemove);

// git credential helper (installed by `remote add`; not for humans)
program
  .command("credential", { hidden: true })
  .argument("<op>", "get | store | erase")
  .option("--repo <name>", "artifacts repo name")
  .action(runCredentialHelper);

program.parseAsync(process.argv);
