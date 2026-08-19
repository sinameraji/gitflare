# gitflare

> **A backup plan for your GitHub repos.** Self-host a live mirror on your own Cloudflare account. One command, private by default, open source. Nothing routes through anyone else.

One command mirrors any GitHub repo onto your own Cloudflare account using [Artifacts](https://developers.cloudflare.com/artifacts/) for git storage, a [Cloudflare Worker](https://developers.cloudflare.com/workers/) for the dashboard + webhook sync, and per-repo [Durable Objects](https://developers.cloudflare.com/durable-objects/) for state. Opt in to **continuous deploy** and **generic CI** and your pushes keep shipping from your own account even when GitHub Actions is down. **GitFlare never sees your code, your token, or your traffic** — there's no server in the loop. It's an MIT-licensed CLI; everything it provisions runs on infrastructure you own.

## Install + run

```bash
npm i -g gitflare
```

Then, from inside any GitHub repo on your machine:

```bash
gitflare init        # autodetects the GitHub remote from the current directory
```

Or pass a repo explicitly (works via `npx gitflare init …` too):

```bash
gitflare init github.com/<owner>/<repo>
```

## What `init` does

1. Asks for a **GitHub personal access token** (`repo` + `admin:repo_hook` scopes). Saved tokens are offered for reuse on later runs.
2. Asks for a **Cloudflare API token** with three account-level permissions:
   - Workers Scripts → Edit
   - Artifacts → Edit
   - Account Settings → Read
3. Shows you the exact resources it's about to provision, waits for `y`.
4. Imports your GitHub repo into Artifacts (one-time server-side seed).
5. Deploys a Cloudflare Worker that mirrors future pushes incrementally and serves a dashboard at `https://gitflare-<owner>--<repo>.<your-subdomain>.workers.dev`.
6. Installs a GitHub webhook on the repo pointing at the Worker.
7. Saves config to `~/.gitflare/credentials.json` (mode 0600).

## What you get

A dashboard showing your repo's branches, last-synced state, file tree with syntax highlighting, and rendered README (images proxied through your Worker) — served from your own Worker, on your account, on Cloudflare's edge. Push to GitHub → mirror updates within seconds. `git clone` from the Artifacts remote works directly. When GitHub is down, the dashboard and clones still work; with CD/CI enabled, deploys and test runs keep working too.

## Other commands

- `gitflare status` — list the repos you've provisioned, with each one's Worker URL and Artifacts remote.
- `gitflare access enable` / `disable` — gate the dashboard + API behind Cloudflare Access SSO (free up to 50 seats on Cloudflare One). Needs **Access: Apps and Policies → Edit** on your Cloudflare token. Protects the web UI/API; `git clone` from Artifacts isn't gated yet.
- `gitflare deploy enable` / `disable` — continuous deploy. Commit a `.gitflare/deploy.yml` and your **pre-built** Worker (or Pages site) ships on every push, straight from your account — bindings (vars/KV/R2/D1/DO/services), opt-in D1 migrations, per-branch Pages previews, live logs at `<dashboard>/r/<repo>/deployments`. Needs a deploy token with **Workers Scripts → Edit** (and Pages/D1 permissions if you use those).
- `gitflare deploy run` — deploy the current Artifacts HEAD right now (the GitHub-down escape hatch). `gitflare deploy list` / `gitflare deploy rollback [--to <id>]` — history and rollback.
- `gitflare ci enable` / `disable` — generic CI. Commit a `.gitflare/ci.yml` (jobs, `needs:`, `run:` steps) and every push runs in a **Cloudflare Sandbox on your own account** — a full Linux container with Node + Python. A `needs`-gated deploy job ships what CI just built. Requires the **Workers Paid** plan (Containers) and two more token permissions: **Cloudchamber → Edit** and **Containers → Edit**. `--instance-type <dev|basic|standard-1..4>` sizes the runner (default `standard-1`).
- `gitflare ci run` / `list` / `cancel` — trigger the pipeline for the current Artifacts HEAD, review runs, or stop one. Runs + live logs at `<dashboard>/r/<repo>/ci`; results post back to GitHub as commit statuses (`gitflare/ci`).

Full workflow-file syntax and examples: [github.com/sinameraji/gitflare](https://github.com/sinameraji/gitflare#other-commands).

## Requirements

- Node ≥ 20
- A Cloudflare account with [Artifacts beta access](https://developers.cloudflare.com/artifacts/)
- A GitHub repo you can install webhooks on

## Cost

GitFlare itself is free — it's an MIT-licensed CLI, not a hosted service. You pay Cloudflare directly for what you use: the mirror + dashboard fit in the free tier / $5-per-month Workers Paid, Artifacts is in beta, and CI runs Containers, which bill usage on top of Workers Paid.

## Status

Pre-alpha, built in the open. Shipped: v0.1 read replica, v0.2 continuous deploy, v0.3 core CI (sandbox jobs, `needs`-gated deploys, live logs). Next: reverse sync back to GitHub + auto-trigger on pushes to the mirror ("GitHub-down mode"), then team collaboration (v0.4) and cross-tenant federation via Cloudflare Mesh (v0.5). Roadmap and live status: [PLAN.md](https://github.com/sinameraji/gitflare/blob/main/PLAN.md).

## License

[MIT](https://github.com/sinameraji/gitflare/blob/main/LICENSE) © Sina Meraji and GitFlare contributors.
