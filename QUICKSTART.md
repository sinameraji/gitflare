# GitFlare quickstart (end-to-end)

This walks you through provisioning a GitFlare mirror for one of your GitHub repos onto your own Cloudflare account. The `init` flow below is unchanged since v0.1 and is live-validated through v0.3; the opt-in features that come after it (Access, deploy, CI) are listed at the end.

## Prereqs

- Node ≥ 20
- A Cloudflare account with **Artifacts beta access**
- A GitHub repo you can install webhooks on
- A clean workstation — no need to be logged in to wrangler in advance

## 1. Run the CLI

Install once:

```bash
npm i -g gitflare
```

Then, from inside any GitHub repo:

```bash
gitflare init        # autodetects the GitHub remote from this directory
```

Or pass a repo explicitly from anywhere:

```bash
gitflare init github.com/<owner>/<repo>
```

The CLI will then ask for two tokens. Skip ahead to step 3 — section 2 below is just the token-creation reference.

> **From source** (only if you're hacking on GitFlare itself): `git clone https://github.com/sinameraji/gitflare && cd gitflare && pnpm install && pnpm --filter gitflare build && node packages/cli/dist/index.js init github.com/<owner>/<repo>`

## 2. Create the two tokens

**GitHub PAT** (https://github.com/settings/tokens/new):
- Scopes: `repo`, `admin:repo_hook`
- Name: `GitFlare`

**Cloudflare API token** (https://dash.cloudflare.com/profile/api-tokens):

Click **Create Custom Token** and add these **3 account-level permissions** (this is the minimum for v0.1; later versions will request more as features are added):

| Section | Permission | Access |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | Artifacts | Edit |
| Account | Account Settings | Read |

Account Resources: **Include → your account**.

Notes:
- "Workers Routes" is a *Zone* permission and isn't needed unless you bring your own domain.
- R2/D1/Workers KV aren't used in v0.1 — they appear in [PLAN.md §11](./PLAN.md#11-auth-and-onboarding) for later versions.
- Artifacts: Edit grants Read implicitly.

## 3. Walk through `gitflare init`

When you run `npx gitflare init github.com/<owner>/<repo>`, the CLI will:

1. Verify your GitHub token (shows your username + the repo's default branch).
2. Verify your Cloudflare token, list accounts, resolve your workers.dev subdomain.
3. Show the **contract** — exactly what's about to be provisioned — and wait for `y`.
4. Ensure an Artifacts namespace named `gitflare` exists.
5. Call Artifacts `POST /repos/:name/import` to seed the mirror from GitHub.
6. Generate a `wrangler.toml` for the bundled Worker (account ID, Artifacts + Durable Object bindings, `REPO_MAP`).
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

The dashboard shows the Artifacts clone URL and a ready-to-paste "How to clone" snippet. Mint a read token in the Cloudflare dashboard (Artifacts → your namespace → the repo → Tokens), then:

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
npx gitflare status
```

Lists all repos you've provisioned and where their Workers live.

## Next steps (all opt-in, all on your account)

- **Private dashboard:** `gitflare access enable` — Cloudflare Access SSO in front of the UI/API (needs *Access: Apps and Policies → Edit* on your token).
- **Continuous deploy:** `gitflare deploy enable` + a `.gitflare/deploy.yml` — pushes ship your pre-built Worker/Pages site from your own account.
- **Generic CI:** `gitflare ci enable` + a `.gitflare/ci.yml` — jobs run in a Cloudflare Sandbox on your account (Workers Paid; needs *Cloudchamber → Edit* and *Containers → Edit*).

Command reference and workflow-file syntax: [README → Other commands](./README.md#other-commands).

## GitHub-down drill

What works today when github.com is unreachable:

1. The dashboard, file browser, and `git clone` from the Artifacts remote keep working (nothing routes through GitHub).
2. Push your work straight to the Artifacts remote (mint a *write* token; same `-c http.extraHeader=…` trick as the clone above, or `git push https://x:<token>@<remote>`).
3. Run `gitflare ci run` (or `gitflare deploy run` if you only use CD) — the pipeline runs against the current Artifacts HEAD, on your account.
4. When GitHub is back, push the same commits to GitHub as usual; the mirror is already up to date, so the resulting webhook sync is a no-op.

Making steps 2–4 automatic — a queue-driven trigger on pushes to the mirror, plus fast-forward reverse sync back to GitHub — is milestone M9 (see [PLAN.md §12](./PLAN.md#12-milestones-and-development-log)). This section will grow into a real drill when it lands.
