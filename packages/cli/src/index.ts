#!/usr/bin/env node
import { Command } from "commander";
import { runInit } from "./commands/init";
import { runStatus } from "./commands/status";

const program = new Command();

program
  .name("gitflare")
  .description("GitHub-shaped developer experience on Cloudflare primitives")
  .version("0.0.0");

program
  .command("init")
  .description("Provision GitFlare for a GitHub repo on your Cloudflare account")
  .argument("[github-url]", "GitHub repo URL (e.g. github.com/owner/repo)")
  .option("--session <token>", "Session blob from gitflare.dev onboarding")
  .action(runInit);

program
  .command("status")
  .description("Show sync status for the current repo")
  .action(runStatus);

program.parseAsync(process.argv);
