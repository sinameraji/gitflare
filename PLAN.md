# GitFlare — a GitHub-shaped product on Cloudflare primitives

> Working title. Could become `cfhub`, `edgehub`, whatever. The name doesn't matter yet.

## 1. One-paragraph pitch

GitHub keeps going down. Cloudflare just shipped Artifacts (a git server on Workers), Sandboxes GA (persistent Linux for CI), Dynamic Workers (sub-second isolate sandboxes), ArtifactFS (lazy-hydrated repo mounting), Browser Run (headless browsers), and Mesh (zero-trust private networking with per-identity policies). That stack covers ~70% of what GitHub does — *as backend primitives*. There is an obvious product-shaped hole: a human-facing developer experience on top of it. **gitflare is that product.** It starts as a self-hosted read replica of GitHub that you point your own Cloudflare account at — "GitHub stays your source of truth, gitflare is the faster, always-up mirror" — and incrementally grows into a system where GitHub is no longer in the critical path.

## 2. Strategic positioning

We do **not** open with "replace GitHub." Nobody wants that risk on day one. We open with **"your deployments don't depend on GitHub being up."** Same product, very different sales motion.

The migration philosophy is **mirror-forever by default, cutover when (and only when) the user decides**. Every version of gitflare assumes both remotes can coexist. The bidirectional sync is a load-bearing feature, not a transitional crutch.

The competitive moat is **depth on Cloudflare**, not breadth of GitHub-compat. We are not chasing the GitHub Actions marketplace. We are the obviously-correct tool if your stack already lives on Cloudflare — and we happen to also keep working when GitHub doesn't.

## 3. Architecture: which Cloudflare primitive does what

| Concern | Primitive | Notes |
|---|---|---|
| Git object storage + smart HTTP protocol | **Artifacts** | Zig-in-WASM git server on Durable Objects. One DO per repo. Forks from any remote, including GitHub. Don't build. |
| Lazy repo mount for CI/IDE | **ArtifactFS** | OSS filesystem driver. Hydrates files on access; CI starts before clone finishes. |
| Heavy CI runners (any stack) | **Sandboxes** | Persistent Linux, PTY, snapshot recovery, credential injection via egress proxy, idle = $0. |
| Fast CI runners (JS/TS) | **Dynamic Workers** | Isolate-based, ~100× faster cold start than containers. |
| Deploy target (Cloudflare-native) | **Workers / Pages / wrangler** | Sub-second deploys, no external runner needed. |
| Headless browser E2E | **Browser Run** | Live View + CDP + session recordings. |
| Issues / PRs / comments / metadata | **D1 + Durable Objects** | DO per repo for ref/PR serialization; D1 for query-shaped data. |
| Full-text + code search | **D1 FTS5 → Vectorize** | Start with SQLite FTS. Add semantic search later via Workers AI. |
| File / blob attachments | **R2** | Issue attachments, release artifacts, large LFS-style blobs. |
| Webhooks, event fan-out | **Queues** | Mirror sync, CI dispatch, downstream notifications. |
| Cross-account collaboration network | **Mesh** | See §6. This is the unlock for v0.4+. |
| Feature flags (internal) | **Flagship** | Rollout control for our own staged ramps. |
| Edge-rendered UI | **Pages / Workers + Astro or Remix** | "Cloudflare vibe." Server-rendered, fast first paint. |

What we actually build is **the social layer + the UI + the glue**: PRs, issues, reviews, identity, the mirror sync, the workflow runner, the policy surfaces on top of Mesh. Everything else is rented from Cloudflare.

## 4. Versioned roadmap

The versions are not equal in size. v0.1–v0.3 are roughly the same amount of work as v0.4 alone. Each version is shippable on its own — if we stop after any one of them, the thing is still useful.

---

### v0.1 — Read replica (self-host, single user)

**Goal:** I push to GitHub. gitflare shows a beautiful, fast, always-up mirror of my repo. If GitHub is down, I can still browse, clone, and pull.

**Scope:**
- One user, one Cloudflare account, BYO scoped API token.
- Web onboarding at `gitflare.dev` (GitHub OAuth → scope-explained Cloudflare token → session handoff) plus a `gitflare init` CLI that performs the actual deploy locally. Token never persists on gitflare's servers. Full flow in §11.
- GitHub webhook → Worker → incremental sync into Artifacts. Refs + tags + LFS pointers. Architecture: initial seed uses Artifacts' `POST /repos/:name/import` (one-shot, server-side history pull). Ongoing per-push sync runs inside the Worker via `isomorphic-git` with an in-memory filesystem, keyed off the last-synced SHA stored in a per-repo Durable Object. (`import` is not a continuous mirror — verified against the Artifacts docs.)
- Read-only web UI: repo browser, file viewer with syntax highlighting, commit log, blame, tag/release list, README rendering.
- `git clone https://gitflare.<account>.workers.dev/owner/repo` works (Artifacts' smart HTTP).
- Issues + PRs **read-only mirror** — pulled via GitHub API on webhook + periodic backfill. Render with original numbers preserved.
- Status page: "last synced 12s ago," "GitHub: 200 OK / 503 / unreachable."

**Explicitly out of scope:**
- Writing back to GitHub.
- Comments / reactions from gitflare's UI.
- CI, deploy, search, collaboration, anything multi-user.

**Success criteria:**
- KimiFlare's full history (598 commits, all branches, all PRs) mirrored in under 5 minutes from cold start.
- p95 page load under 200ms globally.
- During a simulated GitHub outage, all read paths still work.

**Open questions:**
- LFS handling: pointers in git, blobs in R2 via Artifacts' LFS support, or just punt?
- How do we render issue/PR cross-references (`#123`, `@alice`) when the linked accounts don't exist in gitflare yet? Probably: link out to GitHub until v0.4 identity bridge.

---

### v0.2 — Deploy without GitHub (CD)

**Goal:** I push to GitHub. gitflare syncs the code, runs `wrangler deploy`, my Worker is live. If GitHub Actions is down, my deploys still ship.

**Scope:**
- A minimal workflow format. One file, declarative, no expression language:
  ```yaml
  on: push
  branches: [main]
  steps:
    - cloudflare/deploy:
        project: kimiflare
        kind: worker
  ```
- Workflow lives in `.gitflare/deploy.yml` in the repo. Parsed by a Worker on push.
- Runs entirely in Workers + wrangler. No Sandbox needed for the Cloudflare-native deploy path.
- Secrets stored in the user's Cloudflare account (Workers Secrets) — we never see them.
- Deploy log streamed to the UI via WebSocket / Durable Object subscription.
- Per-branch preview deploys for Pages projects.
- `cloudflare/deploy` knows: Workers, Pages, Durable Objects bindings, R2 buckets, D1 schema migrations (with confirmation gate).

**Explicitly out of scope:**
- Generic CI (`npm test`). That's v0.3.
- Non-Cloudflare deploy targets. Maybe never.
- Importing existing GitHub Actions workflows.

**Success criteria:**
- "Push to main → live Worker" in under 5 seconds end-to-end.
- A deploy succeeds while `github.com` returns 503.

**Open questions:**
- Do we trigger from GitHub webhook only, or also from a push to gitflare's Artifacts remote? Probably both — Artifacts push is the "GitHub is down" escape hatch.
- D1 migration safety: do we require explicit approval per migration, or trust the user's wrangler config?

---

### v0.3 — Generic CI (tests, lint, build)

**Goal:** Run my test suite on gitflare. If it passes, deploy. All without touching GitHub Actions.

**Scope:**
- Workflow gains `runtime: worker | sandbox` and arbitrary `run:` steps:
  ```yaml
  on: push
  jobs:
    test:
      runtime: worker        # Dynamic Worker for JS/TS hot path
      steps:
        - run: npm ci
        - run: npm test
    e2e:
      runtime: sandbox       # full Linux when needed
      image: mcr.microsoft.com/playwright:latest
      steps:
        - run: npm run test:e2e
    deploy:
      needs: [test, e2e]
      runtime: worker
      steps:
        - cloudflare/deploy: { project: kimiflare }
  ```
- ArtifactFS mounts the repo into the Sandbox/Worker — CI starts in <500ms instead of waiting on `git clone`.
- Build cache lives in R2, keyed on lockfile hash.
- Test results posted back to the PR/commit view in the UI and (via GitHub Checks API) back to the GitHub PR.
- Browser Run wired in for any `playwright`-shaped step that asks for it.
- A **one-shot GitHub Actions importer** that translates the easy 80% of `.github/workflows/*.yml` into `.gitflare/*.yml`, with a clear "couldn't translate, here's why" report for the rest.

**Explicitly out of scope:**
- Matrix builds across OSes other than Linux. macOS/Windows runners — punt indefinitely.
- Arbitrary `uses: third-party/action@v1` execution. Importer flags these; we don't try to run them.
- Self-hosted runners.

**Success criteria:**
- KimiFlare's full CI suite runs on gitflare, end-to-end, in time comparable to or faster than GitHub Actions.
- A "GitHub is fully down" demo: push to gitflare's remote, tests run, deploy ships, status visible in gitflare UI.

**Open questions:**
- Concurrency limits per user account? Sandbox cost model means we can be generous, but we still want abuse protection.
- How aggressive should the dependency cache be? R2 egress is free *within* Cloudflare, but cold pulls from npm/PyPI/etc still cost time.

---

### v0.4 — Multi-user, single-tenant (teams on one account)

**Goal:** My team uses gitflare. We have logins, permissions, code reviews, comments, and PRs that originate inside gitflare (not just mirrored from GitHub).

This is the version where we stop being a read replica and start being a real product. It's also where Mesh enters.

**Scope:**

**Identity:**
- OAuth-based login. Cloudflare Access for the auth layer (free up to 50 seats on Zero Trust).
- A gitflare identity can optionally bind to a GitHub identity for mention-bridging. Old `@alice` mentions render as the same person if alice has bound her accounts.
- Per-user SSH keys for git push.

**Collaboration features (gitflare-native, not just mirrored):**
- PRs opened on gitflare. Review threads tied to commit SHAs + line ranges, so they survive force-pushes the way GitHub's do.
- Issues, comments, reactions, labels, milestones. Real CRUD in our D1.
- Notifications (in-app first; email + webhook later).
- Permissions: owner / maintainer / writer / reader / outside collaborator.

**Bidirectional sync (the hard part):**
- A PR opened on gitflare can be mirrored *to* GitHub. A comment on gitflare appears on the GitHub PR within seconds. Vice versa.
- Reviews are the trickiest: we preserve the commit-SHA + line anchor and re-resolve on each side.
- Conflict policy: gitflare is source-of-truth for any PR/issue *created* on gitflare. GitHub is source-of-truth for any *created* on GitHub. This avoids the "who wins" merge headache.
- An "unsync" button that detaches a repo from GitHub cleanly. After this, gitflare is canonical.

**Code review UX (where we can be better than GitHub):**
- Stacked diffs. Treat a PR chain as a first-class object, not a bag of branches.
- Per-file review state synced across reviewers in real-time via a Durable Object.
- "Open in sandbox" — one click spins up a Sandbox with the PR branch mounted via ArtifactFS, opens an in-browser code editor. Reviewer can actually run the code without local checkout.

**Out of scope for v0.4:**
- Cross-tenant collaboration (Alice's account ↔ Bob's account). That's v0.5.
- Public repos visible to non-logged-in internet users (some basics, but discovery/search/forks-from-strangers comes in v0.5).
- Marketplace, apps, OAuth provider role.

**Success criteria:**
- A 5-person team uses gitflare for a full sprint without touching github.com, while their GitHub mirror stays in sync.
- A force-pushed PR's review threads survive the rebase the same way GitHub's do.

**Open questions:**
- Email notifications: do we run our own SMTP path or use a third party (Resend, Postmark)? Probably third party for v0.4.
- The bidirectional sync of reviews is genuinely hard. We may ship one-way (gitflare → GitHub) first and add the reverse in v0.4.1.

---

### v0.5 — Cross-tenant collaboration (Mesh enters)

**Goal:** Alice (her Cloudflare account) and Bob (his Cloudflare account) collaborate on a repo. Each owns their own storage, runners, and bills. They share a project.

This is the version that justifies the "BYO Cloudflare keys + still collaborate" thesis. See §6 for the deep dive on Mesh.

**Scope:**

**The federation model:**
- Each gitflare user runs gitflare on their own Cloudflare account (the *node*). Their repos, issues, runners live there.
- A small **coordination service** (which Cloudflare-account it runs on is a choice — see §6) holds the cross-tenant graph: who-can-see-what, PR threads that span two nodes, the user identity directory.
- The coordination service is open-source and self-hostable. Anyone can run it. A user can move from a hosted coordinator to a self-hosted one without changing repos.

**Mesh-mediated trust:**
- Every gitflare node enrolls in a Mesh network — gets a private Mesh IP, an identity, post-quantum-encrypted transport.
- Cross-node operations (Alice's repo accepting a PR from Bob's fork) happen over Mesh, with **per-agent identity-based policies**. Bob's node can `git fetch` from Alice's repo only if Alice's Mesh policy allows it. No public-internet exposure required.
- Public repos opt out of the Mesh restriction: served on the regular internet via Workers, anyone can clone.
- Private repos: Mesh-only ingress. Even the coordination service can't read repo contents — it only sees opaque PR/issue threads.

**Forks across accounts:**
- Bob forks Alice's repo. Artifacts on Bob's account uses its native "fork from remote" against Alice's Mesh endpoint. Subsequent fetches are incremental.
- A PR opened by Bob references Alice's repo via the coordination service. Alice sees the PR in her UI. The diff is computed by streaming Bob's branch over Mesh into Alice's runner.

**Discovery (public web):**
- A public `gitflare.dev` (or similar) directory: searchable index of public repos, hosted on Workers.
- Each user's repos are served from their own subdomain by default; the public index links to those subdomains.

**Out of scope for v0.5:**
- Replacing GitHub's social graph (stars, followers, trending). We mirror stars-from-GitHub but don't compete on social discovery yet.
- Anonymous-of-the-internet contributing without an account. PRs require a gitflare identity.

**Success criteria:**
- Alice and Bob, on separate Cloudflare accounts, complete a full PR cycle (open, review, comment, force-push, merge) entirely on gitflare, with neither touching the other's account credentials.
- Network path is verified Mesh-only; tcpdump shows no public-internet hops between their nodes.

**Open questions:**
- Who pays for the coordination service? Options: (a) free hosted with a paid tier, (b) "bring your own Cloudflare account, we deploy the coordinator there for free," (c) federation of community-run coordinators. Leaning (b).
- How do we handle a coordinator being offline? Each node should still serve its own repos read-only. PRs that span nodes degrade gracefully — "waiting for coordinator" rather than "broken."

---

### v0.6 — Public repos and discovery

**Goal:** A public repo on gitflare is as good a developer experience as a public repo on GitHub. Forking, drive-by contributions, search, code navigation.

Scope is mostly UX polish + a discovery surface. Not architecturally novel after v0.5, so leaving the detail thin for now.

---

### v1.0 — Production-ready, paid tiers

The point at which we'd stop calling this beta. Hardening, polish, multi-region durability for the metadata layers we own (Artifacts already replicates itself). GitFlare stays fully open source — no hosted product, no paid tier; every user runs it on their own Cloudflare account. The roadmap here depends entirely on what we learn from v0.1–v0.6 so leaving it as a placeholder.

---

## 5. The mirror-forever invariant

Every version of gitflare must preserve this property:

> If a user disconnects gitflare tomorrow, their GitHub repo is in a state that loses nothing important. Conversely, if GitHub disappears tomorrow, gitflare has everything needed to keep operating.

Concretely:
- Every PR/issue/comment created on gitflare is mirrored to GitHub (when bound) within seconds, via the GitHub API, using the linked user's OAuth token.
- Every git ref pushed to gitflare is mirrored to GitHub (when bound). Failed pushes retry with exponential backoff and surface as a banner in the UI.
- The sync is observable: a "Sync status" page shows last-synced-at, lag, and any errors per direction.
- A user can `gitflare detach <repo>` to formally break the binding. After detach, gitflare is canonical; GitHub becomes a frozen archive.

This is non-negotiable through v0.5. After v0.5, users who want a fully detached experience can have it; defaults still favor the mirror.

## 6. Mesh deep-dive — the collaboration trust model

This is the section most worth getting right, because it determines whether the federation story is real or hand-wavy.

### The privacy guarantee, stated up front

Three tiers of repo, each with a clear and concrete story. The tier is a per-repo setting; users can move a repo between tiers and the system reconfigures Worker routes, DNS, and policies accordingly.

| Tier | Web UI access | Git clone access | Network |
|---|---|---|---|
| **Public** | Anyone, no login | Anyone, no auth | Public internet |
| **Private (single tenant)** | Cloudflare Access SSO | Access service token | Public internet, auth gated at Cloudflare's edge |
| **Private cross-tenant collab** | Mesh + Cloudflare One Client | Mesh identity | Mesh-only, no public DNS |

Key properties that must hold for any private repo:
- Unauthenticated requests get 403 at Cloudflare's edge, before reaching our code.
- No third party (including GitFlare) can read repo contents — they live in the user's Cloudflare account, encrypted at rest by Cloudflare's defaults.
- No "security by URL obscurity." A leaked hostname is not sufficient to clone.
- Every read is auditable: who fetched what ref, when, from what identity.

### What Mesh actually gives us

From the Cloudflare docs and the launch blog:

- Every enrolled node/agent/device gets a **Mesh IP** — a private address inside a Cloudflare-managed overlay network.
- Transport between Mesh participants is **post-quantum encrypted** and never traverses the public internet.
- Every connection inherits **Cloudflare One Zero Trust policies**: device posture, Gateway rules, DNS filtering, per-identity access controls.
- Mesh integrates with **Workers VPC**, so a Worker can be granted scoped access to a private network endpoint without manual tunnels.
- **Agents get distinct identities** with granular policies — the same primitive that lets you say "this AI agent can reach this database but not the others" lets us say "this gitflare node can fetch this repo but not the others."

### How gitflare uses it

**Each gitflare user's account is a Mesh node.**
- When you install gitflare on your Cloudflare account, the bootstrap CLI enrolls your account in gitflare's Mesh organization (or your own, for self-hosted-coordinator users).
- Your Worker that serves git endpoints binds to your Mesh IP for private operations, and to a public hostname for public-repo operations.

**Repo visibility maps to network reachability.**
- **Public repo:** served on the public internet via Workers. Anyone can clone. Auth needed only for write.
- **Private repo:** served only on the Mesh IP. The Worker rejects non-Mesh traffic. Even if someone learns the URL, they can't reach the host without being in the Mesh and passing the policy check.
- **Restricted-collaborators repo:** Mesh + per-identity policy. Alice grants Bob's Mesh identity `fetch` and `push` rights to this repo. Charlie, also in the Mesh, gets denied at the gateway.

**The coordinator's role shrinks.**
- The coordinator does *not* proxy repo data. It only stores cross-tenant metadata (who-can-see-what, PR threads, identity bindings).
- A PR comment Bob writes about Alice's repo: stored in the coordinator. The actual diff Bob's reviewing is fetched directly from Alice's Mesh endpoint into Bob's browser, no coordinator hop.
- This means the coordinator is small, replaceable, and not a privacy hazard. Repo contents never sit on a server that isn't owned by one of the participants.

**Per-identity policies replace SSH-key management.**
- Bob's gitflare identity *is* a Mesh identity. When Bob pushes, Alice's repo's Worker reads the Mesh identity off the connection (Cloudflare One injects this) and checks against Alice's per-repo policy stored in her account.
- No SSH key uploads, no PATs, no rotating secrets.
- Revoking a collaborator is one policy edit, propagates globally in seconds.

**Operational implications:**
- A user who runs gitflare fully self-hosted can opt out of the gitflare-managed Mesh org and run their own. They lose drop-in cross-tenant collab with gitflare.dev users, but they get full sovereignty.
- For the hosted product, we operate the default Mesh org. Users join it on signup. We never see their repo contents; we just operate the policy plane.

**What this rules out (deliberately):**
- We don't need a central reverse proxy fronting every user's repos. Mesh *is* the routing layer.
- We don't need to invent an auth protocol. Cloudflare Access + Mesh identities is the auth protocol.
- We don't need a global ACL store for cross-tenant repos. Each user's account stores their own policies; Mesh enforces them at the connection layer.

### Risks specific to Mesh

- **Vendor lock-in is now extreme.** If Cloudflare ever deprecates or repositions Mesh, the federation story breaks. Mitigation: keep a fallback "public HTTPS + signed-token auth" mode that works without Mesh, for self-hosted users.
- **Mesh is new (April 2026).** Real-world behavior at scale, latency profile across regions, and policy-eval semantics aren't yet battle-tested in third-party products. We have direct access to the Cloudflare team building these primitives, so this is a manageable risk — we plan a v0.4.5 spike to stress-test Mesh for our exact access patterns and feed any gaps back to them before committing v0.5's architecture.
- **Pricing.** Mesh is part of Cloudflare One. Free tier covers 50 seats. Beyond that, users pay per seat. We need to model whether GitFlare covers Mesh seats on behalf of users or passes the cost through transparently. Probably the latter — BYO keys means BYO Mesh bill.

## 7. Things we are deliberately not doing

- Building our own git server. Artifacts exists.
- Hosting non-Cloudflare deploy targets (AWS, Fly, Vercel). The pitch is depth on Cloudflare.
- macOS/Windows/iOS CI runners. Linux only. Hard line.
- A GitHub Actions marketplace clone. Our workflow format is intentionally smaller.
- Replacing GitHub's social graph (stars, followers, trending) in the first year.
- An LLM-chat-with-your-repo feature in v0.x. Cool, but a distraction from the trust story.
- A mobile app.

## 8. Open questions to resolve before v0.1 starts

1. **Domain.** Working assumption: `gitflare.dev` for the marketing + onboarding surface. Per-user instances live at `<repo>.<account>.gitflare.dev` (or a custom domain the user brings). Confirm availability and budget.
2. **Pricing model.** BYO-keys means we don't pay infra. We charge for: hosted coordinator, mirror-sync orchestration, the social-layer database. Per-seat? Per-repo? Flat? Leaning per-seat for hosted, free for self-host.
3. ~~**License.**~~ Resolved: **MIT**. GitFlare is and stays fully open source — no plans for a hosted commercial offering or relicensing. Everyone runs it on their own Cloudflare account, on the same terms.
4. **What "issues mirror" actually shows in v0.1.** Re-render from D1 (highest fidelity, most work), embed GitHub's UI in an iframe (lowest fidelity, fastest), or re-render read-only with link-out for actions (the middle path, currently leaning here).
5. **Artifacts pricing in GA.** The one primitive in our stack without published pricing. Worth getting an early signal from the Artifacts team given our direct access.
6. **Token-persistence policy.** §11 commits to "Cloudflare token never persists on gitflare servers" — we should formalize this as a written policy and have it reviewed before launch, since it constrains how the hosted coordinator (v0.4+) can be architected.

## 9. Suggested next steps

1. **Validate Artifacts public beta status and quotas.** Public beta was targeted for early May 2026 — confirm it's open and that one account can hold our expected repo volume.
2. **Build a 200-line spike of the v0.1 webhook → Artifacts mirror.** This is the smallest thing that proves the core architecture is real. If it doesn't fall out cleanly in a weekend, the bigger plan needs rethinking.
3. **Write the workflow format spec.** Even though it's v0.2+, the format shape constrains v0.1 UI choices (e.g., where workflow files live in the repo browser).
4. **Mesh spike.** Stand up two Cloudflare accounts, enroll both in a Mesh org, prove that account A's Worker can serve a private endpoint to account B with per-identity policy enforcement. This is the riskiest unknown. Do it before committing to v0.5.

## 10. Surfaces and UX

gitflare has three surfaces. They have different jobs and don't compete with each other.

### `git` itself — unchanged

The user keeps using `git push`, `git pull`, `git clone` exactly as today. gitflare doesn't wrap or replace `git`. At install time we *optionally* add a second `pushurl` to `.git/config` for the GitHub-down escape hatch — opt-in, removable by `gitflare uninstall`. Anything that requires devs to learn a new push verb is dead on arrival.

### The web UI — daily-use surface for humans

Edge-rendered (Astro or Remix on Pages), served from the user's account subdomain.

Per version:
- **v0.1** — repo browser, file viewer with syntax highlighting, commit log, blame, branches/tags, releases, README rendering, sync status. Issues + PRs visible but read-only.
- **v0.2** — adds Deployments: live log streaming, rollback, environment + Workers Secrets management.
- **v0.3** — adds Workflows: run history, logs, retry, cancel. "Open this commit in a Sandbox."
- **v0.4** — full PR creation/review UI, issue CRUD, comments/reactions/threads, notifications, stacked-diff review, "Open PR in sandbox" (Sandbox + ArtifactFS + in-browser editor).
- **v0.5** — cross-tenant invites, federated PR view, public directory.
- **v0.6** — discovery, search, profile pages.

Aesthetic intent: Cloudflare dashboard vibe — dense, fast, technical. Not GitHub marketing. The product is for people who know git.

### The `gitflare` CLI — install, admin, scripting

Distributed as `npx gitflare` (no global install) and `brew install gitflare`.

Per version:
- **v0.1** — `init`, `status`, `resync`, `detach`, `secrets`, `logs`.
- **v0.2** — `deploy`, `deploys list`, `rollback`.
- **v0.3** — `run <workflow>`, `sandbox` (spin up a Sandbox with current branch, drop into a shell with optional port forwards).
- **v0.4+** — `pr` and `issue` subcommands modeled on GitHub's `gh` CLI for muscle-memory transfer.

The CLI is intentionally not the daily-use surface. `gitflare sandbox` is the one new daily verb we want to introduce — "clean Linux box with my code mounted, on Cloudflare's network, in seconds" — because it's a capability that doesn't exist today, not because we're competing with `git`.

### Editor integration — later

VS Code / Cursor extension for in-editor PR review and "open in cloud sandbox." Not v0.x territory. Lower priority because `gitflare sandbox` + the web UI cover most of the value.

### Mental model

| Surface | Job | Frequency |
|---|---|---|
| `git` | Move code | Hourly |
| Web UI | Look at code, review code, manage issues | Daily |
| `gitflare` CLI | Set up, automate, escape hatches | Rarely |
| `gitflare sandbox` | Run code in a clean env | Daily (eventually) |

### Design principles (concrete, not vibes)

Vague directives like "make it look good" produce generic SaaS aesthetics by default. These are the rules:

- **Density over whitespace.** Information-dense control panels, not marketing pages. One repo page shows file tree, commits, deploys, CI, PRs — all visible at once.
- **Real numbers, real-time.** Latency to last sync. Bytes pushed this hour. Active Sandboxes. Operational truth, not marketing-grade summaries.
- **Type:** Inter for UI (Cloudflare uses it). JetBrains Mono or Berkeley Mono for code. No serifs anywhere.
- **Color:** restrained. Cloudflare orange (`#F38020`) only for primary actions. Grayscale + green/red for status. No decorative gradients.
- **Dark mode default**, light mode toggleable. This is a dev tool.
- **Diagrams in the docs are first-class.** Every concept (mirror flow, CI flow, Mesh routing) gets a diagram in the visual language of Cloudflare's own developer docs — labeled boxes, arrows with text, no decorative illustrations.
- **Animations only when informative.** The push-to-mirror animation on the landing page shows actual data flow. We don't animate buttons "for delight."
- **Empty states do real work.** A repo with no PRs shows the curl command, the web form link, and the keyboard shortcut. Empty states are where new users learn the product.

**Inspiration, in order:** Cloudflare dashboard, Linear, Vercel dashboard, Stripe API docs. Notably *not* GitHub's UI (too much chrome) and *not* GitLab's (too much marketing).

## 11. Auth and onboarding

Two credentials are at play: **GitHub** (read the user's repo, install a webhook) and **Cloudflare** (deploy into the user's account). They're requested in that order, deliberately: GitHub OAuth is familiar and zero-friction; Cloudflare token creation requires attention, so we earn that attention by showing value first.

The flow is the user's first impression of the product. It cannot be a black box.

### Step 0 — `gitflare.dev` landing

What the user sees:
- A one-line description: *"GitHub stays your source of truth. gitflare is the faster, always-up mirror on your own Cloudflare account."*
- A live architecture diagram (push → webhook → Artifacts → UI).
- A live status row: "GitHub: ✓ 200 OK • Cloudflare: ✓ all systems normal • gitflare nodes online: N".
- One button: **"Mirror a repo →"**
- Below the fold: how it works, pricing, self-host docs.

No newsletter signup, no testimonials, no "trusted by." Visitors here can read code.

### Step 1 — GitHub OAuth

Standard GitHub OAuth. Minimum scopes:
- `repo` (private + public read; needed for clone + API)
- `admin:repo_hook` (install the webhook)
- `user:email` (identity)

Explicitly *not* requested: `workflow`, `delete_repo`, anything write-heavy beyond webhook management.

### Step 2 — Pick a repo + see the contract

Searchable list of the user's GitHub repos. They pick one. Before we ask for the Cloudflare token, we show exactly what will happen:

> We'll mirror `sina/kimiflare` to your own Cloudflare account.
> This will use:
> • 1 Worker (free tier)
> • 1 Artifacts repo (beta, free)
> • 1 D1 database (~1 MB to start)
> • 1 webhook on your GitHub repo
>
> Estimated monthly cost: **$0** under normal usage.

This is the contract. The user knows what we're about to do before we ask for keys.

### Step 3 — Connect Cloudflare

Two paths, user picks; first option is the default-highlighted one:

**(a) Scoped API token (recommended).** We open the Cloudflare dashboard's token creation page with the URL pre-filled to include our exact required scopes. Cloudflare's own UI shows every permission, named, with descriptions. The user clicks "Create Token," copies it, pastes it into the gitflare page.

The v0.1 scope list:

| Scope | Why |
|---|---|
| Account → Workers Scripts: Edit | Deploy the Worker (includes Durable Objects management) |
| Account → Artifacts: Edit | Create + manage repos, import from upstream, mint tokens. Read is granted implicitly. |
| Account → Account Settings: Read | Resolve account ID and workers.dev subdomain |

That's it for v0.1 — three permissions. *Workers Routes* is a Zone-level permission and isn't needed unless the user brings a custom domain. R2/D1/KV are not used in v0.1; they appear below as later versions add them.

**Three scopes for v0.1. Every one named. No "Edit all of Cloudflare" hand-grenade tokens.** Each later version adds scopes; never replaces:
- v0.2 adds: `Workers KV Storage: Edit` (for cached deploy state)
- v0.3 adds: Sandbox-related scopes when those stabilize; `R2: Edit` (specifically *Workers R2 Storage*, for build cache); `D1: Edit` (for CI run history)
- v0.4 adds: `Cloudflare Access: Apps and Policies: Edit`
- v0.5 adds: `Cloudflare One Connector: Edit`, `Cloudflare Tunnel: Edit`
- Custom domains (any version): `Zone → Workers Routes: Edit`, `Zone → DNS: Edit`

When the user upgrades versions, we show a diff of the new scopes vs. the existing token and walk them through re-issuing.

**(b) Cloudflare OAuth ("Authorize app").** One-click flow if Cloudflare supports it for our app at the required scopes. Less transparent than path (a) — we offer it for the lazy path but recommend (a). Power users will pick (a); we don't fight that.

### Step 4 — Deploy from the user's machine

The deploy runs **locally on the user's laptop, not on our servers.** This is what makes "we never persist your token" honest.

The gitflare.dev page, after collecting the token, shows:

> ✓ Cloudflare account: `sina@example.com` (account `7a3c...`)
>
> Run this on your machine to deploy:
>
> ```
> npx gitflare init --session=eyJhbGc...
> ```
>
> The session is single-use, valid for 10 minutes, and stays on your machine.

The session is an encrypted blob containing the GitHub OAuth result, the Cloudflare token, and the repo choice. Our server sees the token in-browser briefly to construct the session blob, but does not store it. When `npx gitflare init` runs:

1. Decodes the session blob.
2. Connects directly to Cloudflare's API.
3. Provisions the Worker, Artifacts repo, D1, R2 bucket, Pages site.
4. Connects to GitHub's API, installs the webhook.
5. Writes the token to `~/.gitflare/credentials` (mode 0600). The path is printed so the user can see.
6. Prints the deployed subdomain. Done.

After this, GitFlare has no access to anything in the user's account. Uninstall = revoke token in Cloudflare dashboard + delete the Worker. Nothing of theirs remains in our systems because nothing was ever there.

### Three entry points, same destination

| Entry | Audience | Behavior |
|---|---|---|
| `gitflare.dev` (web) | First-time, most users | Guided OAuth + token + session handoff to CLI |
| `npx gitflare init <repo>` | Power users, no-browser preference | Walks the same flow in-terminal; opens browser only for OAuth steps |
| Self-host docs | Air-gapped / fully sovereign | Step-by-step manual token creation + `gitflare init --no-coordinator` |

All three terminate at: a working gitflare on the user's account.

### Auth boundaries by version

| Version | What GitFlare sees | What lives on the user's account |
|---|---|---|
| v0.1–v0.3 | Nothing. Token never persisted. | Everything: code, issues, runners, secrets. |
| v0.4 (single-tenant teams) | Same — still zero. | Same. Team identities are managed via Cloudflare Access in the user's account. |
| v0.5 (cross-tenant) | Coordination metadata only: PR threads spanning accounts, identity directory. Never repo contents. | Repo contents, runners, secrets, ACLs, Mesh policies. |
| v0.5+ coordinator (community-run only) | Only cross-tenant metadata (PR threads, identity bindings) for those who opt in; never repo contents. | Same. |

This is the privacy guarantee, stated in operational terms. It is non-negotiable through v0.5.

## 12. Milestones and development log

The roadmap in §4 is what we're shipping. This section is *where we are right now* — the live state of the build. Updated at the end of every milestone. If you're new to the repo and want to know "what's working today," read this section first.

### Milestone status

| ID | Milestone | Status | Notes |
|---|---|---|---|
| M0 | Foundation: monorepo, README, license, scaffold, milestones tracker | ✅ done | First commit. Logo in `assets/`. Four packages (cli, worker, web, shared) with minimal stubs. Diagnostics will resolve after `pnpm install`. |
| M1 | Worker mirror spike: webhook → Artifacts | ✅ done | Worker now has: HMAC verification, Hono routing, RepoDO (per-repo Durable Object that serializes sync ops + persists last-synced SHA per ref), `syncGithubToArtifacts` using isomorphic-git over a custom in-memory fs (`MemFs`), Artifacts binding type definitions, REPO_MAP var for github→artifacts name lookup. 10/10 unit tests pass (HMAC + memfs). All packages typecheck. End-to-end run on a real Cloudflare account waits for M2 (CLI provisioning). |
| M2 | CLI init flow | ✅ done | Full interactive provisioning: GitHub PAT verification (lists user + repo metadata), Cloudflare token verification with multi-account picker, contract preview before any side effect, Artifacts namespace ensure + repo import, wrangler.toml rewrite, `wrangler deploy` shell-out, secrets set via `wrangler secret put`, webhook install on GitHub (with duplicate-detection + replace), local config persisted at `~/.gitflare/credentials.json` mode 0600. 10/10 CLI tests pass (URL parser, repo name sanitizer, random hex). |
| M3 | Read-only web UI | ✅ done | Hono JSX served from the same Worker (one deploy, one URL). Landing page lists configured repos with: GitHub link, Artifacts clone URL, sync status pill, per-ref last-synced SHA + relative time. Cloudflare visual language: dark, Inter + JetBrains Mono, orange (#F38020) only for the brand mark. Plus `/api/refs` JSON endpoint. Separate `packages/web` removed — YAGNI for v0.1. |
| M4 | v0.1 cut: end-to-end working read replica | ✅ done | All three components compose cleanly: CLI provisions → Worker deploys → webhook fires → sync runs → UI shows synced state. [QUICKSTART.md](./QUICKSTART.md) walks the full flow. Live-validated against `sinameraji/kimiflare`. |
| M4.5 | Browseable dashboard | ✅ done | Top-level entries on the home page link to per-path tree/blob routes. Inside a directory: breadcrumb + parent link + clickable entries (links recurse). Inside a file: plain `<pre>` rendering with binary detection. README images rewritten to GitHub raw URLs for public repos. |
| M4.7 | Publish to npm | ✅ done | esbuild bundles the worker (~678 KB) into the CLI's `dist/`. CLI invokes wrangler directly via `require.resolve` (no `pnpm exec` runtime dep). Published as [`gitflare`](https://www.npmjs.com/package/gitflare). Anyone can now `npx gitflare init <repo>`. |
| M5 | Privacy via Cloudflare Access | ⏳ next | The dashboard URL is currently public. Put Access in front of the Worker (free up to 50 seats on Cloudflare One), gate `/` + `/r/*` + `/api/*` with SSO, leave `/webhooks/github` unauth (HMAC already gates it). Then private GitHub repos actually stay private. |

### What's in the repo right now (as of M0)

```
gitflare/
├── PLAN.md              ← design doc (this file)
├── README.md            ← project overview + logo
├── LICENSE              ← provisional / TBD
├── .gitignore
├── package.json         ← workspace root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── assets/
│   └── logo.png
├── QUICKSTART.md        ← end-to-end provisioning guide
└── packages/
    ├── shared/          ← shared TypeScript types
    ├── worker/          ← Hono Worker: full webhook→sync pipeline + JSX UI on the same deploy
    └── cli/             ← real `gitflare init` (GitHub + Cloudflare provisioning, wrangler shell-out, webhook install)
```

### Cadence

After each milestone:
1. Mark its row above ✅ done.
2. Update "what's in the repo" if structure changed.
3. Note any plan-level changes that arose (new open questions, scope cuts, surprises).
4. Move to the next milestone.

The intent of this section is that someone resuming the project after a long pause (or a new collaborator) can read §12 and know exactly where to pick up, without having to skim the rest of the doc.
