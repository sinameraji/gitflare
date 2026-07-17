<p align="center">
  <img src="assets/logo.png" alt="GitFlare" width="160" />
</p>

<h1 align="center">GitFlare</h1>

<p align="center">
  <strong>A backup plan for your GitHub repos.</strong>
</p>

<p align="center">
  Self-host a live mirror on your own Cloudflare account. One command, private by default, open source. Nothing routes through anyone else.
</p>

---

## Roadmap

GitFlare ships in versions. Each one stands alone — if the next one never gets built, the current one is still useful by itself. The grand plan is to move from "read replica" all the way to "fully self-sovereign collaboration on Cloudflare primitives." Full design and the reasoning behind each version is in [PLAN.md](./PLAN.md).

| Version | Status | What it does |
|---|---|---|
| **v0.1** | ✅ **shipping — you are here** | **Read replica.** One command mirrors a GitHub repo into your Cloudflare account: Artifacts for git storage, a Worker that takes GitHub webhooks + serves a dashboard, file browsing with syntax highlighting, README rendering (images proxied through your Worker), sync status. Optional Cloudflare Access gates the dashboard for private repos. If GitHub is down, reads + clones still work. |
| v0.2 | 🧪 Worker deploys live-validated; Pages + D1 pending | **CD that doesn't depend on GitHub.** Push → your Worker deploys to your own account: Workers + Pages (with preview deploys), bindings (vars/KV/R2/D1/DO/services), opt-in D1 migrations, live deploy logs over WebSocket, plus `deploy run` (the GitHub-down escape hatch), `deploy list`, and `deploy rollback`. Deploys **pre-built** artifacts via `.gitflare/deploy.yml`; arbitrary build steps arrive with v0.3 CI. |
| v0.3 | 🚧 in progress (core CI live-validated) | **Generic CI.** `.gitflare/ci.yml` with jobs / `needs:` / `run:` steps, executed on Cloudflare Sandboxes (full Linux containers on your account) — validated end-to-end: push → sandbox boots → clones → runs your steps with live logs, and a `needs`-gated deploy job ships **what CI just built** (not the stale committed file) to a reachable Worker. Cancel, run history, GitHub commit statuses. Still to come in v0.3: R2 build cache, Browser Run for E2E, a GitHub Actions importer, Pages build artifacts. |
| v0.4 | 📋 planned | **Multi-user teams.** PRs, reviews, comments — native to GitFlare, bidirectionally mirrored to GitHub. Stacked diffs. "Open PR in sandbox" one-click ephemeral env. |
| v0.5 | 📋 planned | **Cross-tenant collaboration via Cloudflare Mesh.** Alice and Bob on separate Cloudflare accounts; private repos served Mesh-only with per-identity policies instead of SSH keys. |
| v0.6 | 📋 planned | **Public repos + discovery.** A real code browser for the public web, search, forks across accounts. |
| v1.0 | 📋 someday | **Production-ready, fully open source.** Hardening, polish, multi-region durability. No hosted product, no paid tier — GitFlare stays an MIT CLI you run on your own account. |

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

### Other commands

- `gitflare status` — sync status for the repos you've provisioned.
- `gitflare access enable` — gate the dashboard + API behind Cloudflare Access SSO (free up to 50 seats on Cloudflare One). Note: this protects the web UI/API; `git clone` from Artifacts isn't gated yet — that's a later version.
- `gitflare deploy enable` — turn on continuous deploy. Commit a `.gitflare/deploy.yml` and your **pre-built** Worker (or Pages site) ships on every push, straight from your account:

  ```yaml
  on: push
  branches: [main]
  steps:
    - cloudflare/deploy:
        project: my-worker
        kind: worker            # or "pages"
        entry: dist/worker.js   # worker: a built single-file ES module; pages: a directory
        vars:
          API_BASE: https://example.com
        kv:
          - { binding: CACHE, id: "<namespace-id>" }
        d1:
          - { binding: DB, database_id: "<id>" }
        migrations:             # optional; runs only with apply: true (idempotent)
          dir: migrations
          database_id: "<id>"
          apply: true
  ```

- `gitflare deploy run` — deploy the current Artifacts HEAD right now. This is the **GitHub-down escape hatch**: push straight to your Artifacts remote, then run this; no GitHub involved.
- `gitflare deploy list` / `gitflare deploy rollback [--to <id>]` — review deploy history and roll back to a previous successful deploy.

  Deploys and their **live logs** show up at `<dashboard-url>/r/<repo>/deployments`.

- `gitflare ci enable` — turn on generic CI (v0.3, requires the Workers Paid plan for Containers). Commit a `.gitflare/ci.yml` and every push runs your jobs in a **Cloudflare Sandbox on your own account** — full Linux, Node 20 + Python 3.11 — no GitHub Actions involved:

  ```yaml
  on: push
  branches: [main]
  jobs:
    test:
      steps:
        - run: npm ci
        - run: npm test
    deploy:
      needs: [test]          # deploys only if tests pass
      steps:
        - cloudflare/deploy:
            project: my-worker
            kind: worker
            entry: dist/worker.js
  ```

  If a job builds `entry` (e.g. `npm run build`), the deploy ships the freshly built file from the CI workspace, not the committed copy. When `ci.yml` exists, it owns the pipeline — `deploy.yml` no longer runs ungated. Deploy jobs also need `gitflare deploy enable` (that's where the deploy token lives).

- `gitflare ci run` / `list` / `cancel` — trigger the pipeline for the current Artifacts HEAD (GitHub-down escape hatch), review runs, or stop a runaway one. Runs + **live logs** stream at `<dashboard-url>/r/<repo>/ci`, and results post back to GitHub as commit statuses (`gitflare/ci`) when GitHub is reachable.

## Contributing

Pre-alpha, built in the open, and there's a lot of obvious next work. Cloudflare Access (M5), the full v0.2 CD feature set, and the v0.3 core CI (M8: sandbox jobs, needs-gated deploys, artifact handover) have landed — see [PLAN.md §12](./PLAN.md#12-milestones-and-development-log) for current status. PRs and issues are welcome — particularly on:

- **Live-validating the remaining CD paths.** The v0.3 CI stack (Containers provisioning, Sandbox exec, the Workers Scripts upload + workers.dev enablement) and the needs-gated deploy job are now validated end-to-end against a real Workers Paid account. Still needing a live run: **Pages Direct Upload**, the **D1 migration** query path, and **Cloudflare Access** (M5) apps/policies.
- **v0.3 remainder.** R2 build cache keyed on lockfile hash, Browser Run for E2E, the GitHub Actions importer, and Pages build-artifact handover — see [PLAN.md §12 M8 notes](./PLAN.md#12-milestones-and-development-log).
- **Private `git clone`.** Access gates the dashboard, but clone still hits Artifacts directly. Closing that needs an Access service token / Mesh path (v0.4+).
- **Custom domains** in front of the Worker, and **better empty states / error messages** anywhere in the CLI or dashboard.
- **Anything in [PLAN.md §8 Open Questions](./PLAN.md#8-open-questions-to-resolve-before-v01-starts)** you have a strong opinion on.

How to contribute:

1. Open an issue describing what you want to do (so we don't duplicate work).
2. Fork, branch, code. The repo is a pnpm workspace; `pnpm install && pnpm -r typecheck && pnpm -r test` should pass.
3. Open a PR. Small, focused PRs land fastest.

### Releasing

Releases are automated with [Release Please](https://github.com/googleapis/release-please). Write PR titles as [Conventional Commits](https://www.conventionalcommits.org/) — `feat:` → minor, `fix:` → patch, `feat!:` / `BREAKING CHANGE` → major; `docs:`/`chore:` don't trigger a release. On merge to `main`, a release PR is opened that bumps the version and changelog; merging *that* tags the release and publishes [`gitflare`](https://www.npmjs.com/package/gitflare) to npm.

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
