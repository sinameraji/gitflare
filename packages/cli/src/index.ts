#!/usr/bin/env node
import { Command } from "commander";
import { createRequire } from "node:module";
import { runInit } from "./commands/init.js";
import { runStatus } from "./commands/status.js";

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

program.parseAsync(process.argv);
