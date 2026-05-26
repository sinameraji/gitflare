# gitflare

> GitHub stays your source of truth. GitFlare is the faster, always-up mirror on your own Cloudflare account.

One command mirrors any GitHub repo onto your own Cloudflare account using [Artifacts](https://developers.cloudflare.com/artifacts/) for git storage, a [Cloudflare Worker](https://developers.cloudflare.com/workers/) for the dashboard + webhook sync, and a per-repo [Durable Object](https://developers.cloudflare.com/durable-objects/) for state. **GitFlare-the-company never sees your code, your token, or your traffic** — everything runs on infrastructure you own.

## Install + run

No install needed:

```bash
npx gitflare init github.com/<owner>/<repo>
```

Or install globally:

```bash
npm i -g gitflare
gitflare init github.com/<owner>/<repo>
```

## What `init` does

1. Asks for a **GitHub personal access token** (`repo` + `admin:repo_hook` scopes).
2. Asks for a **Cloudflare API token** with three account-level permissions:
   - Workers Scripts → Edit
   - Artifacts → Edit
   - Account Settings → Read
3. Shows you the exact resources it's about to provision, waits for `y`.
4. Imports your GitHub repo into Artifacts (one-time server-side seed).
5. Deploys a Cloudflare Worker that mirrors future pushes incrementally and serves a dashboard at `https://<repo>.<your-subdomain>.workers.dev`.
6. Installs a GitHub webhook on the repo pointing at the Worker.
7. Saves config to `~/.gitflare/credentials.json` (mode 0600).

## What you get

A web dashboard showing your repo's branches, file tree, and rendered README — served from your own Worker, on your account, on Cloudflare's edge. Push to GitHub → mirror updates within seconds. When GitHub is down, the dashboard still works (and v0.2 will keep deploys working too).

## Requirements

- Node ≥ 20
- A Cloudflare account with [Artifacts beta access](https://developers.cloudflare.com/artifacts/)
- A GitHub repo you can install webhooks on

## Pricing

Three account-level Cloudflare permissions, all on the free tier. Realistic cost for a solo developer mirroring one repo: **about $5/month** for Workers Paid (needed for Durable Objects), plus pennies for Artifacts. No charge to GitFlare-the-company — there isn't one.

## Status

Pre-alpha. v0.1 is the read-replica cut: GitHub stays canonical, GitFlare mirrors. CI/CD (v0.2), team collaboration (v0.4), and cross-tenant federation via Cloudflare Mesh (v0.5) are on the roadmap — see [PLAN.md](https://github.com/sinameraji/gitflare/blob/main/PLAN.md).

## License

[MIT](https://github.com/sinameraji/gitflare/blob/main/LICENSE) © Sina Meraji and GitFlare contributors.
