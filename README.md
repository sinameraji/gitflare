<p align="center">
  <img src="assets/logo.png" alt="GitFlare" width="160" />
</p>

<h1 align="center">GitFlare</h1>

<p align="center">
  <em>GitHub stays your source of truth. GitFlare is the faster, always-up mirror on your own Cloudflare account.</em>
</p>

---

GitFlare is a GitHub-shaped developer experience built on Cloudflare primitives — Artifacts, Sandboxes, Dynamic Workers, ArtifactFS, Browser Run, and Mesh. You install it on **your own Cloudflare account** (BYO scoped API token, eight permissions, all named), and it mirrors a GitHub repo onto your account in real time.

When GitHub goes down, your reads, your clones, and (in later versions) your CI/CD keep working. When GitHub is up, you don't notice GitFlare is running.

## Status

Early development. v0.1 (self-hosted read replica) is in progress. See [PLAN.md](./PLAN.md) for the full versioned roadmap and §12 for the live milestones log.

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
│   ├── cli/             ← the `gitflare` CLI (Node.js)
│   ├── worker/          ← the Cloudflare Worker (Hono on Workers)
│   ├── web/             ← the read-only web UI (Astro on Pages)
│   └── shared/          ← shared TypeScript types
└── docs/                ← per-package READMEs, design notes
```

## Quick links

- **[Full plan and roadmap →](./PLAN.md)**
- **[v0.1 milestones (live) →](./PLAN.md#12-milestones-and-development-log)**
- **[Auth flow and Cloudflare scopes →](./PLAN.md#11-auth-and-onboarding)**
- **[Privacy guarantee →](./PLAN.md#6-mesh-deep-dive--the-collaboration-trust-model)**

## License

License is not yet decided. Working assumption: source-available + free for self-host, paid for hosted (FSL-style). Until finalized, treat this repo as **all rights reserved** by the authors. See [LICENSE](./LICENSE).
