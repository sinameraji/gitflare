# GitFlare quickstart (end-to-end)

This walks you through provisioning a GitFlare mirror for one of your GitHub repos onto your own Cloudflare account. Tested against v0.1 (M0–M4).

## Prereqs

- Node ≥ 20 and pnpm
- A Cloudflare account with **Artifacts beta access**
- A GitHub repo you can install webhooks on
- A clean workstation — no need to be logged in to wrangler in advance

## 1. Clone + install

```bash
git clone <this-repo>
cd gitflare
pnpm install
pnpm --filter gitflare build
```

## 2. Create the two tokens

**GitHub PAT** (https://github.com/settings/tokens/new):
- Scopes: `repo`, `admin:repo_hook`
- Name: `GitFlare`

**Cloudflare API token** (https://dash.cloudflare.com/profile/api-tokens):

Create a custom token with these permissions:

| Section | Permission | Access |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Workers Routes | Edit |
| Account | Workers KV Storage | Edit |
| Account | Workers R2 Storage | Edit |
| Account | D1 | Edit |
| Account | Artifacts | Read |
| Account | Artifacts | Edit |
| Account | Account Settings | Read |

Account Resources: include your account.

## 3. Run `gitflare init`

```bash
node packages/cli/dist/index.js init github.com/<owner>/<repo>
```

The CLI will:

1. Verify your GitHub token (shows your username + the repo's default branch).
2. Verify your Cloudflare token, list accounts, resolve your workers.dev subdomain.
3. Show the **contract** — exactly what's about to be provisioned — and wait for `y`.
4. Ensure an Artifacts namespace named `gitflare` exists.
5. Call Artifacts `POST /repos/:name/import` to seed the mirror from GitHub.
6. Rewrite `packages/worker/wrangler.toml` with your account ID + REPO_MAP.
7. Run `wrangler deploy` against your account.
8. Set `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` as Worker secrets.
9. Install a GitHub webhook on the repo pointing at `https://<worker>.workers.dev/webhooks/github`.
10. Save your config to `~/.gitflare/credentials.json` (mode 0600).

## 4. Verify it worked

Open the Worker URL the CLI printed. You should see the GitFlare dashboard listing your repo, the Artifacts clone URL, and "no syncs yet" (because no push has happened since the install).

Make a commit and push to GitHub:

```bash
cd <your-repo>
git commit --allow-empty -m "trigger GitFlare sync"
git push
```

Within a few seconds, refreshing the Worker URL should show:
- Status: `synced`
- The ref (`refs/heads/main` or your default) with the new SHA
- "Just now" as the synced timestamp

## 5. Clone from your mirror

The dashboard shows the Artifacts clone URL. Grab a token from the Cloudflare dashboard (or `gitflare token` once that command lands in M5), then:

```bash
git -c http.extraHeader="Authorization: Bearer $ARTIFACTS_TOKEN" \
    clone "$ARTIFACTS_REMOTE" my-mirror
```

## Troubleshooting

- **`wrangler deploy failed`** → the CLI prints the full wrangler output. Most common cause: missing scopes on the Cloudflare token. Re-create with the table above.
- **`Artifacts provisioning failed` with "already exists"** → safe to retry after deleting the existing repo via the Cloudflare dashboard.
- **Webhook fires but no sync** → check the Worker logs in the Cloudflare dashboard. Common cause: GitHub token doesn't have `repo` scope for the upstream fetch.
- **Sync runs but pushes nothing** → check that the branch in the webhook matches the branch being pushed. We currently sync only the ref in the push event.

## Status check

```bash
node packages/cli/dist/index.js status
```

Lists all repos you've provisioned and where their Workers live.
