# @gitflare/worker

The Cloudflare Worker that fronts a single user's GitFlare deployment. One Worker per mirrored repo, deployed into the **user's** Cloudflare account by `gitflare init` (the CLI bundles this package with esbuild and generates the `wrangler.toml` — see `packages/cli/src/wrangler.ts`; the `wrangler.toml` in this directory is a dev-only stand-in).

## Responsibilities

1. **Receive GitHub webhooks** (`/webhooks/github`), verify the HMAC signature, and on `push` mirror the pushed branch into the user's Artifacts repo.
2. **Serve the dashboard + JSON API** (Hono JSX, server-rendered): repo overview, file browser with syntax highlighting, README rendering, raw blobs, deployments, CI runs.
3. **Run continuous deploy** (v0.2): parse `.gitflare/deploy.yml`, upload Workers scripts / Pages sites, apply D1 migrations, stream logs.
4. **Run generic CI** (v0.3): parse `.gitflare/ci.yml`, execute `run:` jobs in a Cloudflare Sandbox, delegate `needs`-gated deploy jobs, post GitHub commit statuses.
5. **Optionally gate the UI/API** behind Cloudflare Access (M5).
6. **GitHub-down mode** (M9): consume the mirror's Artifacts `pushed` events from a Queue, run CI/CD from pushes made straight to the mirror, and push those branches back to GitHub (fast-forward only) from a RepoDO alarm with backoff.

## Architecture

```
GitHub ── push webhook (HMAC) ──► POST /webhooks/github ── 202 immediately
                                        │  (work continues in waitUntil)
                                        ▼
                               RepoDO  POST /sync            per-repo Durable Object; serializes syncs,
                                        │                     stores last-synced sha per ref
                                        ▼
                          syncGithubToArtifacts()             isomorphic-git over an in-memory fs (MemFs):
                                        │                     shallow clone the pushed branch from GitHub,
                                        │                     mint a 10-min write token, push to Artifacts
                                        ▼
                     Artifacts repo (user's account)  ◄──── git clone (smart HTTP, read token)
                                        │
                     ┌──────────────────┴───────────────────┐
                     ▼  CI_ENABLED=1                        ▼  otherwise
              CiDO  POST /run                        DeployDO  POST /deploy
              one Sandbox per run, jobs in            .gitflare/deploy.yml → Workers Scripts API /
              topo order, live logs over WS,          Pages Direct Upload / D1 query API,
              deploy jobs delegate to DeployDO        history + rollback, live logs over WS
```

- **Per-repo Durable Objects** so concurrent webhooks for the same repo don't race; different repos run in parallel.
- **isomorphic-git in the Worker** for the per-push delta (small, no container cold start). The **initial seed** uses Artifacts' one-shot `import` (done by the CLI).
- **A committed `.gitflare/ci.yml` owns the pipeline**: `deploy.yml` no longer runs ungated on push; deploy jobs run only after their `needs` succeed.
- **Reverse sync (M9)** is idempotent and never forces: it compares both tips, clones the mirror branch deep enough to contain GitHub's tip (`cloneBranchReaching`), and pushes with `force:false`. Loop guards: an `outbound:<ref>` marker is written *before* every forward push so our own Artifacts events are recognised; `/sync` short-circuits with `dispatch:false` when the mirror already has the sha so the webhook echo of our own GitHub push doesn't re-run the pipeline. Both DOs dedupe push-like modes by branch+sha.

## Durable Objects

| Class | Binding | Routes (internal) | State |
|---|---|---|---|
| `RepoDO` | `REPO` | `POST /sync`, `POST /artifacts-push`, `POST /reverse/now`, `GET /state`, `alarm()` | `ref:<ref>` → `{ref, sha, syncedAt, source, forwardError?}`; `outbound:<ref>` (forward push in flight); `reverse:<ref>` → `{status: pending\|synced\|conflict\|rejected\|auth\|error\|stalled, attempts, nextAttemptAt, lastError, githubSha}` |
| `DeployDO` | `DEPLOY` | `POST /deploy`, `POST /rollback`, `GET /state`, `/stream` (WS) | `deploy:<id>` records (mode push/manual/rollback/ci, steps, 500-line log ring), `migrations:<db>` applied set |
| `CiDO` | `CI` | `POST /run` (202, detached), `POST /cancel`, `GET /state`, `/stream` (WS) | `run:<id>` records (jobs, per-step outcomes, log ring, deadline); alarm watchdog fails over-budget/orphaned runs and destroys sandboxes |
| `Sandbox` (from `@cloudflare/sandbox`) | `SANDBOX` (only after `gitflare ci enable`) | — | the CI container |

## HTTP routes

| Route | Gate | Purpose |
|---|---|---|
| `GET /health` | open | `{ok, version}` |
| `GET /` | Access* | dashboard: refs, sync state, top-level tree, README |
| `GET /r/:name/tree/*`, `GET /r/:name/blob/*` | Access* | file browser (default branch HEAD; blobs highlighted, binaries detected) |
| `GET /r/:name/raw/*` | Access* | raw bytes from the mirror (README image proxy) |
| `GET /api/refs` | Access* | JSON: RepoDO state for every repo |
| `GET /r/:name/deployments`, `GET /r/:name/deployments/stream` | Access* | deploy history + live-log WebSocket |
| `GET /r/:name/ci`, `GET /r/:name/ci/stream`, `POST /r/:name/ci/cancel` | Access* (cancel refuses unless Access is on) | CI runs + live logs + cancel |
| `POST /control/deploy/run`, `POST /control/deploy/rollback`, `GET /control/deployments` | `CONTROL_SECRET` bearer | CLI: `deploy run/rollback/list` |
| `POST /control/ci/run`, `POST /control/ci/cancel`, `GET /control/ci/runs` | `CONTROL_SECRET` bearer | CLI: `ci run/cancel/list` |
| `POST /control/sync/reverse`, `GET /control/sync/state` | `CONTROL_SECRET` bearer | CLI: `sync now` (re-queue / reconcile), `sync status` |
| *queue consumer* (`export default { fetch, queue }`) | queue binding | Artifacts `cf.artifacts.repo.pushed` → RepoDO `/artifacts-push` → dispatch as mode `artifacts-push` |
| `POST /webhooks/github` | HMAC (`GITHUB_WEBHOOK_SECRET`) | `ping`, `push` (branches only — tags/deletes are acked and skipped); every other event is acked and ignored |

\* Access enforcement only when `ACCESS_AUD` + `ACCESS_TEAM_DOMAIN` are set (`gitflare access enable`); otherwise the mirror is public-readable.

## Bindings, vars, secrets (all set by the CLI)

| Name | Kind | Set by | What |
|---|---|---|---|
| `ARTIFACTS` | Artifacts namespace binding | `init` | git storage; used to mint short-lived read/write tokens |
| `REPO`, `DEPLOY`, `CI` | Durable Object bindings | `init` | see table above (migrations v1–v4 always emitted) |
| `SANDBOX` + `[[containers]]` | DO binding + container app | `ci enable` | `docker.io/cloudflare/sandbox:<pinned>`, `instance_type`, `max_instances = 5` |
| `GITFLARE_VERSION` | var | every deploy | CLI version, shown in the UI + `/health` |
| `ACCOUNT_ID` | var | every deploy | for the Workers Scripts / Pages / D1 REST calls |
| `REPO_MAP` | var (JSON) | every deploy | `{"owner/repo": {name, remote}}` — Artifacts repo name + clone URL |
| `ACCESS_AUD`, `ACCESS_TEAM_DOMAIN` | vars | `access enable` | Access JWT audience + team domain |
| `CD_ENABLED` | var (`"1"`) | `deploy enable` | gates DeployDO on push |
| `CI_ENABLED` | var (`"1"`) | `ci enable` | gates CiDO on push (`ci disable` drops it, keeps the container) |
| `SYNC_ENABLED` | var (`"1"`) | `sync enable` | gates the alarm-driven reverse pushes (`sync now` runs regardless) |
| `WORKER_URL` | var | every redeploy | the Worker's own URL, for status links from the queue consumer |
| `[[queues.consumers]]` | queue consumer | `sync enable` | `<worker-name>-events`, fed by a per-repo `artifacts.repo` `pushed` subscription |
| `GITHUB_WEBHOOK_SECRET` | secret | `init` | webhook HMAC |
| `GITHUB_TOKEN` | secret | `init` | fetch from GitHub; post commit statuses |
| `CF_DEPLOY_TOKEN` | secret | `deploy enable` | Workers Scripts: Edit (+ Pages/D1 as used) on the user's account |
| `CONTROL_SECRET` | secret | `deploy enable` / `ci enable` | bearer for `/control/*` |

## Source layout

```
src/
├── index.tsx            routes, webhook handler, DO exports
├── env.ts               Env + REPO_MAP helpers        types.ts   Artifacts binding types
├── durable-objects/     repo.ts · deploy.ts · ci.ts
├── sync/                git-sync.ts (GitHub→Artifacts) · reverse-sync.ts (Artifacts→GitHub) · memfs.ts
├── events/              artifacts.ts (event parsing, own-push classification) · consumer.ts (queue handler)
├── pipeline/dispatch.ts the single CI-vs-Deploy decision (webhook + consumer)
├── artifacts/           refs.ts (listServerRefs) · content.ts (clone/tree/blob helpers)
├── github/webhook.ts    HMAC verification
├── deploy/              yaml.ts (subset parser) · workflow.ts (deploy.yml) · cf-deploy.ts (Scripts/Pages/D1 APIs) · dedupe.ts
├── ci/                  workflow.ts (ci.yml) · sandbox-runner.ts · delegation.ts · github-status.ts
├── access/              jwt.ts (RS256 via WebCrypto + JWKS cache) · middleware.ts
└── ui/                  layout · home · browse · deployments · runs · states · highlight
```

## Dev

```bash
pnpm install
pnpm --filter @gitflare/worker test        # vitest, node env, pure-function suites (test/*.test.ts)
pnpm --filter @gitflare/worker typecheck
pnpm --filter @gitflare/worker dev         # wrangler dev (needs your own bindings in wrangler.toml)
```

Live status per milestone lives in [PLAN.md §12](../../PLAN.md#12-milestones-and-development-log).
