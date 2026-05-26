<p align="center">
  <img src="assets/logo.png" alt="GitFlare" width="160" />
</p>

<h1 align="center">GitFlare</h1>

<p align="center">
  <a href="https://github.com/sinameraji/gitflare/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sinameraji/gitflare?color=f38020&style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/sinameraji/gitflare/stargazers"><img src="https://img.shields.io/github/stars/sinameraji/gitflare?color=f38020&style=flat-square" alt="Stars"></a>
  <img src="https://img.shields.io/github/last-commit/sinameraji/gitflare?color=f38020&style=flat-square" alt="Last commit">
  <img src="https://img.shields.io/badge/built_on-Cloudflare-f38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare">
  <img src="https://img.shields.io/badge/Artifacts-beta-f38020?style=flat-square" alt="Artifacts beta">
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/status-pre--alpha-red?style=flat-square" alt="status: pre-alpha">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs welcome">
</p>

<p align="center">
  <em>GitHub stays your source of truth. GitFlare is the faster, always-up mirror on your own Cloudflare account.</em>
</p>

---

GitFlare is a GitHub-shaped developer experience built on Cloudflare primitives — Artifacts, Sandboxes, Dynamic Workers, ArtifactFS, Browser Run, and Mesh. You install it on **your own Cloudflare account** (BYO scoped API token, eight permissions, all named), and it mirrors a GitHub repo onto your account in real time.

When GitHub goes down, your reads, your clones, and (in later versions) your CI/CD keep working. When GitHub is up, you don't notice GitFlare is running.

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

That's it. The CLI walks you through a GitHub PAT + a scoped Cloudflare API token, then provisions an Artifacts repo, a Worker, and a GitHub webhook — all on your own Cloudflare account. Detailed walkthrough: [QUICKSTART.md](./QUICKSTART.md).

[![npm](https://img.shields.io/npm/v/gitflare?color=f38020&style=flat-square)](https://www.npmjs.com/package/gitflare)

## Status

Pre-alpha. v0.1 (read-replica cut, M0–M4) is live on npm. CI/CD, team collaboration, and cross-tenant federation via Cloudflare Mesh are on the roadmap.

- **Roadmap and design:** [PLAN.md](./PLAN.md)
- **Live milestone status:** [PLAN.md §12](./PLAN.md#12-milestones-and-development-log)

## How it works (v0.1)

```
git push origin main
        │
        ▼
   github.com ──────► webhook ──────► your Worker ──────► Artifacts (in your account)
                                                                 │
                                                                 ▼
                                                       https://<repo>.<you>.gitflare.dev
                                                       (git clone + read-only web UI)
```

- Your Worker, your Artifacts repo, your D1, your R2 — all on your Cloudflare account.
- Cloudflare's free tier + $5/month Workers Paid covers a solo developer.
- GitFlare-the-company never sees your code, your token, or your traffic.

## Repository layout

```
gitflare/
├── PLAN.md              ← the design doc (read this first)
├── README.md            ← you are here
├── assets/              ← logo, diagrams
├── packages/
│   ├── cli/             ← the `gitflare` CLI (Node.js, commander + clack)
│   ├── worker/          ← the Cloudflare Worker — sync pipeline + read-only UI (Hono + JSX)
│   └── shared/          ← shared TypeScript types
└── QUICKSTART.md        ← end-to-end provisioning guide
```

## Quick links

- **[Full plan and roadmap →](./PLAN.md)**
- **[v0.1 milestones (live) →](./PLAN.md#12-milestones-and-development-log)**
- **[Auth flow and Cloudflare scopes →](./PLAN.md#11-auth-and-onboarding)**
- **[Privacy guarantee →](./PLAN.md#6-mesh-deep-dive--the-collaboration-trust-model)**

## License

[MIT](./LICENSE) © 2026 Sina Meraji and GitFlare contributors.
