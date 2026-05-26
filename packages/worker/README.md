# @gitflare/worker

The Cloudflare Worker that fronts a single user's GitFlare deployment.

## Responsibilities

1. **Receive GitHub webhooks**, verify HMAC, dispatch by event type.
2. **Mirror code** from GitHub into the user's Artifacts repo on every push.
3. **Serve repo metadata** to the web UI (read API; landing in M3).
4. (Later) Serve the read-only web UI itself.
5. (Later) Run deploys and CI workflows.

## Architecture

```
GitHub
  │
  │  push event (HMAC signed)
  ▼
[ Worker: /webhooks/github ]
  │  verify signature
  │  parse event
  ▼
[ Per-repo Durable Object (RepoDO) ]
  │  serialize sync ops per repo
  │  call sync routine
  ▼
[ syncGithubToArtifacts() ]
  │  init memfs
  │  isomorphic-git fetch from GitHub (shallow, only new objects)
  │  mint Artifacts write token
  │  isomorphic-git push to Artifacts
  ▼
Artifacts repo (in user's Cloudflare account)
```

### Why this shape

- **Per-repo Durable Object** so two concurrent webhooks for the same repo don't race on push ordering. Different repos get different DOs and run in parallel.
- **isomorphic-git in the Worker** rather than a Sandbox: per-push deltas are small (a few commits), CPU stays well under Worker limits, no container cold-start tax.
- **Initial seed via Artifacts `import` API** (handled by the CLI in M2) — `import` is a one-shot server-side history pull, not a continuous mirror. After seeding, this Worker handles all incremental updates.

## Bindings (set by `gitflare init`)

| Binding | What |
|---|---|
| `ARTIFACTS` | Artifacts namespace handle |
| `REPO` | `RepoDO` Durable Object namespace |
| `GITHUB_WEBHOOK_SECRET` (secret) | HMAC secret for incoming GitHub webhooks |
| `GITHUB_TOKEN` (secret) | OAuth token for fetching from GitHub |
| `REPO_MAP` (var) | JSON map of `"owner/repo"` → Artifacts repo name |

## Dev

```bash
pnpm install
pnpm --filter @gitflare/worker test
pnpm --filter @gitflare/worker typecheck
pnpm --filter @gitflare/worker dev    # wrangler dev (needs user bindings configured)
```

## Status (as of M1)

- ✅ HMAC verification
- ✅ Hono routing + webhook dispatch
- ✅ `RepoDO` with per-ref state + serialized sync
- ✅ `syncGithubToArtifacts` using isomorphic-git + memfs
- ✅ Unit tests for HMAC + memfs
- ⏳ End-to-end test on a real Cloudflare account — waits for M2 (CLI provisioning)
- ⏳ Issue/PR mirroring — later in v0.1 scope
