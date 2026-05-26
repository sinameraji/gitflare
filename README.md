<p align="center">
  <img src="assets/logo.png" alt="GitFlare" width="160" />
</p>

<h1 align="center">GitFlare</h1>

<p align="center">
  <a href="https://github.com/sinameraji/gitflare/blob/main/LICENSE"><img src="https://img.shields.io/github/license/sinameraji/gitflare?color=f38020&style=flat-square" alt="License: MIT"></a>
  <a href="https://github.com/sinameraji/gitflare/stargazers"><img src="https://img.shields.io/github/stars/sinameraji/gitflare?color=f38020&style=flat-square" alt="Stars"></a>
  <a href="https://github.com/sinameraji/gitflare/network/members"><img src="https://img.shields.io/github/forks/sinameraji/gitflare?color=f38020&style=flat-square" alt="Forks"></a>
  <a href="https://github.com/sinameraji/gitflare/issues"><img src="https://img.shields.io/github/issues/sinameraji/gitflare?color=f38020&style=flat-square" alt="Issues"></a>
  <a href="https://github.com/sinameraji/gitflare/pulls"><img src="https://img.shields.io/github/issues-pr/sinameraji/gitflare?color=f38020&style=flat-square" alt="PRs"></a>
  <img src="https://img.shields.io/github/last-commit/sinameraji/gitflare?color=f38020&style=flat-square" alt="Last commit">
  <img src="https://img.shields.io/github/commit-activity/w/sinameraji/gitflare?color=f38020&style=flat-square" alt="Commit activity">
  <img src="https://img.shields.io/github/repo-size/sinameraji/gitflare?color=f38020&style=flat-square" alt="Repo size">
  <br>
  <img src="https://img.shields.io/badge/built_on-Cloudflare-f38020?style=flat-square&logo=cloudflare&logoColor=white" alt="Cloudflare">
  <img src="https://img.shields.io/badge/Artifacts-beta-f38020?style=flat-square" alt="Artifacts beta">
  <img src="https://img.shields.io/badge/Mesh-curious-f38020?style=flat-square" alt="Mesh">
  <img src="https://img.shields.io/badge/Sandboxes-eyeing-f38020?style=flat-square" alt="Sandboxes">
  <img src="https://img.shields.io/badge/TypeScript-5.6-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript">
  <img src="https://img.shields.io/badge/Hono-4-e36002?style=flat-square&logo=hono&logoColor=white" alt="Hono">
  <img src="https://img.shields.io/badge/Astro-killed_for_v0.1-ff5d01?style=flat-square&logo=astro&logoColor=white" alt="Astro">
  <img src="https://img.shields.io/badge/node-%E2%89%A520-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node">
  <img src="https://img.shields.io/badge/pnpm-9-f69220?style=flat-square&logo=pnpm&logoColor=white" alt="pnpm">
  <br>
  <img src="https://img.shields.io/badge/status-pre--alpha-red?style=flat-square" alt="status: pre-alpha">
  <img src="https://img.shields.io/badge/works_on_my_machine-✓-success?style=flat-square" alt="works on my machine">
  <img src="https://img.shields.io/badge/YOLO-encouraged-ff69b4?style=flat-square" alt="YOLO">
  <img src="https://img.shields.io/badge/PRs-welcome-brightgreen?style=flat-square" alt="PRs welcome">
  <img src="https://img.shields.io/badge/made_in-Toronto-red?style=flat-square" alt="Toronto">
  <img src="https://img.shields.io/badge/replaces-GitHub_(maybe)-181717?style=flat-square&logo=github&logoColor=white" alt="vs GitHub">
  <img src="https://img.shields.io/badge/depends_on-GitHub_being_up-yellow?style=flat-square&logo=github&logoColor=white" alt="dependency irony">
  <img src="https://img.shields.io/badge/vibes-immaculate-9146ff?style=flat-square" alt="vibes">
</p>

<p align="center">
  <em>GitHub stays your source of truth. GitFlare is the faster, always-up mirror on your own Cloudflare account.</em>
</p>

---

GitFlare is a GitHub-shaped developer experience built on Cloudflare primitives — Artifacts, Sandboxes, Dynamic Workers, ArtifactFS, Browser Run, and Mesh. You install it on **your own Cloudflare account** (BYO scoped API token, eight permissions, all named), and it mirrors a GitHub repo onto your account in real time.

When GitHub goes down, your reads, your clones, and (in later versions) your CI/CD keep working. When GitHub is up, you don't notice GitFlare is running.

## Status

Early development — v0.1 end-to-end cut landed (M0–M4). One command provisions a GitFlare instance into your Cloudflare account; GitHub webhooks drive incremental sync into Artifacts.

- **Try it:** [QUICKSTART.md](./QUICKSTART.md)
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
