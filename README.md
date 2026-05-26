<p align="center">
  <img src="assets/logo.png" alt="GitFlare" width="160" />
</p>

<h1 align="center">GitFlare</h1>

<p align="center">
  <em>GitHub stays your source of truth. GitFlare is the faster, always-up mirror on your own Cloudflare account.</em>
</p>

---

## Roadmap

GitFlare ships in versions. Each one stands alone — if the next one never gets built, the current one is still useful by itself. The grand plan is to move from "read replica" all the way to "fully self-sovereign collaboration on Cloudflare primitives." Full design and the reasoning behind each version is in [PLAN.md](./PLAN.md).

| Version | Status | What it does |
|---|---|---|
| **v0.1** | ✅ **shipping — you are here** | **Read replica.** One command mirrors a GitHub repo into your Cloudflare account: Artifacts for git storage, a Worker that takes GitHub webhooks + serves a dashboard, file browsing, README rendering, sync status. If GitHub is down, reads + clones still work. |
| v0.2 | 🚧 next | **CD that doesn't depend on GitHub.** Push to GitHub → your GitFlare Worker runs `wrangler deploy` against your own account. When GitHub Actions is down, your prod still ships. |
| v0.3 | 📋 planned | **Generic CI.** A small declarative workflow format that runs tests on Cloudflare Sandboxes (full Linux) or Dynamic Workers (fast JS path). Build cache in R2. Browser Run for E2E. |
| v0.4 | 📋 planned | **Multi-user teams.** PRs, reviews, comments — native to GitFlare, bidirectionally mirrored to GitHub. Stacked diffs. "Open PR in sandbox" one-click ephemeral env. |
| v0.5 | 📋 planned | **Cross-tenant collaboration via Cloudflare Mesh.** Alice and Bob on separate Cloudflare accounts; private repos served Mesh-only with per-identity policies instead of SSH keys. |
| v0.6 | 📋 planned | **Public repos + discovery.** A real code browser for the public web, search, forks across accounts. |
| v1.0 | 📋 someday | **Production-ready.** Real SLAs, billing for the hosted coordinator, multi-region DR. |

## Try it

Install once:

```bash
npm i -g gitflare
```

Then, from inside any GitHub repo on your machine:

```bash
gitflare init        # autodetects the GitHub remote from the current directory
```

Or pass a repo explicitly:

```bash
gitflare init github.com/<owner>/<repo>
```

The CLI walks you through a GitHub PAT + a scoped Cloudflare API token (three account-level permissions, all named), shows you exactly what it's about to provision, and waits for confirmation. After that it imports your repo into Artifacts, deploys a Worker on your account, sets secrets, installs a webhook, and prints the dashboard URL. Step-by-step walkthrough with screenshots in [QUICKSTART.md](./QUICKSTART.md).

GitFlare never sees your code, your token, or your traffic. It's an MIT-licensed CLI; everything it provisions runs on infrastructure you own.

## Contributing

Pre-alpha, built in the open, and there's a lot of obvious next work. PRs and issues are welcome — particularly on:

- **v0.2 (CD).** The plumbing for a `.gitflare/deploy.yml` workflow that runs on push and shells out to `wrangler deploy`. Sketched in [PLAN.md §4](./PLAN.md#v02--deploy-without-github-cd).
- **M5: Cloudflare Access in front of the Worker** so private repos actually stay private. The dashboard is currently public-readable to anyone with the URL.
- **Syntax highlighting** in the file viewer (Shiki has a Workers-compatible port).
- **Image proxy** through the Worker so README images render for private repos too (currently we rewrite to GitHub raw URLs, which only works for public repos).
- **Better empty states / error messages** anywhere in the CLI or dashboard.
- **Anything in [PLAN.md §8 Open Questions](./PLAN.md#8-open-questions-to-resolve-before-v01-starts)** you have a strong opinion on.

How to contribute:

1. Open an issue describing what you want to do (so we don't duplicate work).
2. Fork, branch, code. The repo is a pnpm workspace; `pnpm install && pnpm -r typecheck && pnpm -r test` should pass.
3. Open a PR. Small, focused PRs land fastest.

If you just want to talk through an idea, open a Discussion or DM [@sinameraji](https://github.com/sinameraji).

## How it works (v0.1)

```
git push origin main
        │
        ▼
   github.com ──────► webhook ──────► your Worker ──────► Artifacts (in your account)
                                                                 │
                                                                 ▼
                                                       https://<repo>.<you>.workers.dev
                                                       (git clone + read-only web UI)
```

- Your Worker, your Artifacts repo, your D1, your R2 — all on your Cloudflare account.
- Cloudflare's free tier + $5/month Workers Paid covers a solo developer.
- No server in the loop between you and Cloudflare. We don't have an account to log you into.

## Repository layout

```
gitflare/
├── PLAN.md              ← the design doc — read this first
├── README.md            ← you are here
├── QUICKSTART.md        ← end-to-end provisioning walkthrough
├── assets/              ← logo, diagrams
└── packages/
    ├── cli/             ← the `gitflare` CLI (Node.js, commander + clack)
    ├── worker/          ← the Cloudflare Worker — sync pipeline + dashboard
    └── shared/          ← shared TypeScript types
```

## License

[MIT](./LICENSE) © Sina Meraji and GitFlare contributors.
