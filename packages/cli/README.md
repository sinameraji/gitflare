# gitflare CLI

The CLI for GitFlare. One command provisions an entire GitFlare instance into your Cloudflare account.

## Install (during development)

```bash
pnpm install
pnpm --filter gitflare build
node packages/cli/dist/index.js init github.com/owner/repo
```

Or use tsx for live development:

```bash
pnpm --filter gitflare dev -- init github.com/owner/repo
```

## What `init` does

1. Prompts for a **GitHub PAT** (scopes: `repo`, `admin:repo_hook`).
2. Prompts for a **Cloudflare API token** with these scopes:
   - Workers Scripts: Edit
   - Workers Routes: Edit
   - Durable Objects: Edit (via Workers Scripts)
   - D1: Edit, R2: Edit, Workers KV: Edit
   - Artifacts: Read + Edit
   - Account Settings: Read
3. Lists your Cloudflare accounts and resolves your workers.dev subdomain.
4. Shows the *contract* — exactly what will be provisioned — and waits for confirmation.
5. Creates an Artifacts namespace (`gitflare`) if it doesn't exist.
6. Calls Artifacts `POST /repos/:name/import` to seed the mirror from GitHub (one-time, server-side history pull).
7. Writes `wrangler.toml` with the right bindings + account ID + REPO_MAP.
8. Runs `pnpm exec wrangler deploy` in the worker package.
9. Sets `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` as Worker secrets via `wrangler secret put`.
10. Installs a webhook on the GitHub repo pointing at `https://<worker>.workers.dev/webhooks/github` with the HMAC secret.
11. Saves config to `~/.gitflare/credentials.json` (mode 0600).

After this, every `git push` to GitHub triggers an incremental sync into Artifacts within seconds.

## Other commands (stubs / partial)

- `gitflare status` — lists provisioned repos from local config.
- `gitflare resync`, `gitflare detach`, `gitflare logs` — planned (later milestones).
