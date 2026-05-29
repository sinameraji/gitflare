#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";
import { runAccessEnable, runAccessDisable } from "./commands/access.js";
import { runDeployEnable, runDeployDisable } from "./commands/deploy.js";

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

program.parseAsync(process.argv);
