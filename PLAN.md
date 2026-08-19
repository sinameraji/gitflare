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
| Cross-account collaboration network | **Mesh** | See §6. This is the unlock for Stage 4+. |
| Feature flags (internal) | **Flagship** | Rollout control for our own staged ramps. |
| Edge-rendered UI | **Pages / Workers + Astro or Remix** | "Cloudflare vibe." Server-rendered, fast first paint. |

What we actually build is **the social layer + the UI + the glue**: PRs, issues, reviews, identity, the mirror sync, the workflow runner, the policy surfaces on top of Mesh. Everything else is rented from Cloudflare.

## 4. Roadmap by stage

> **Stages are not npm versions.** These are roadmap *stages* — bundles of scope written before any code. The npm package (`gitflare`) follows semver via release-please: every `feat:` commit bumps the minor, whatever the feature is. The two happened to line up for 0.1/0.2/0.3 (read replica / CD / core CI); from npm 0.4.0 onward there is no correspondence (0.4.0 and 0.5.0 shipped Stage 3's GitHub-down mode). Read "Stage 5" as a name, never as "npm 0.5". *(Renamed from "v0.x" on 2026-08-19 for exactly this reason.)*

The stages are not equal in size. Stage 1–Stage 3 are roughly the same amount of work as Stage 4 alone. Each version is shippable on its own — if we stop after any one of them, the thing is still useful.

---

### Stage 1 — Read replica (self-host, single user) *(formerly "v0.1")*

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
- How do we render issue/PR cross-references (`#123`, `@alice`) when the linked accounts don't exist in gitflare yet? Probably: link out to GitHub until Stage 4 identity bridge.

**Shipped vs deferred (recorded 2026-08-19, against v0.3.1).** Shipped: webhook → Artifacts sync of the pushed branch, `git clone` from the mirror, dashboard with refs + last-synced state, file browser with syntax highlighting, README rendering (images proxied through the Worker), `init`/`status`, optional Cloudflare Access on the UI/API. **Deferred → M10** (never built; the webhook already subscribes to the relevant events but the Worker acks and ignores them): read-only issues/PR mirror, commit log, blame, tag/release list (tag pushes are skipped; only branch refs are mirrored), the "GitHub: 200 OK / 503" health row, LFS. The Stage 1 cut was narrower than this section — the read replica shipped without the metadata mirror, and that was the right call for a solo user; nothing here blocks adding it later.

---

### Stage 2 — Deploy without GitHub (CD) *(formerly "v0.2")*

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
- ~~Do we trigger from GitHub webhook only, or also from a push to gitflare's Artifacts remote?~~ Resolved (M9): both. Artifacts emits `cf.artifacts.repo.pushed` events via Queues event subscriptions; a queue consumer on the same Worker dispatches CI/CD from pushes to the mirror. Until M9 lands, the escape hatch is manual (`gitflare ci run` / `deploy run`).
- D1 migration safety: do we require explicit approval per migration, or trust the user's wrangler config?

---

### Stage 3 — Generic CI (tests, lint, build) + GitHub-down mode *(formerly "v0.3")*

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

### Stage 4 — Multi-user, single-tenant (teams on one account) *(formerly "v0.4" — not scheduled, see below)*

> **Status (2026-08-19): not scheduled.** Stages 1–3 deliver the founding vision — "a backup plan for your GitHub repos" — and are complete at their core (remaining items live in M10). Stages 4–6 describe a different product (a GitHub-shaped collaboration surface: PR/issue storage for users, identities, a coordinator). They stay here as the design of record, but nothing is planned against them until Sina decides GitFlare should become that product. Don't read them as "next".

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

**Out of scope for Stage 4:**
- Cross-tenant collaboration (Alice's account ↔ Bob's account). That's v0.5.
- Public repos visible to non-logged-in internet users (some basics, but discovery/search/forks-from-strangers comes in Stage 5).
- Marketplace, apps, OAuth provider role.

**Success criteria:**
- A 5-person team uses gitflare for a full sprint without touching github.com, while their GitHub mirror stays in sync.
- A force-pushed PR's review threads survive the rebase the same way GitHub's do.

**Open questions:**
- Email notifications: do we run our own SMTP path or use a third party (Resend, Postmark)? Probably third party for v0.4.
- The bidirectional sync of reviews is genuinely hard. We may ship one-way (gitflare → GitHub) first and add the reverse in Stage 4.1.

---

### Stage 5 — Cross-tenant collaboration (Mesh enters) *(formerly "v0.5" — not scheduled)*

**Goal:** Alice (her Cloudflare account) and Bob (his Cloudflare account) collaborate on a repo. Each owns their own storage, runners, and bills. They share a project.

This is the version that justifies the "BYO Cloudflare keys + still collaborate" thesis. See §6 for the deep dive on Mesh.

**Scope:**

**The federation model:**
- Each gitflare user runs gitflare on their own Cloudflare account (the *node*). Their repos, issues, runners live there.
- A small **coordination service** (which Cloudflare-account it runs on is a choice — see §6) holds the cross-tenant graph: who-can-see-what, PR threads that span two nodes, the user identity directory.
- The coordination service is open-source and self-hostable. Anyone can run it. A user can move between coordinators — a shared one, a community-run one, their own — without changing repos.

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

**Out of scope for Stage 5:**
- Replacing GitHub's social graph (stars, followers, trending). We mirror stars-from-GitHub but don't compete on social discovery yet.
- Anonymous-of-the-internet contributing without an account. PRs require a gitflare identity.

**Success criteria:**
- Alice and Bob, on separate Cloudflare accounts, complete a full PR cycle (open, review, comment, force-push, merge) entirely on gitflare, with neither touching the other's account credentials.
- Network path is verified Mesh-only; tcpdump shows no public-internet hops between their nodes.

**Open questions:**
- Who runs the coordination service? There's no GitFlare business to bill it to, so the options are (a) "bring your own Cloudflare account, the CLI deploys the coordinator there" — the user pays Cloudflare directly, same as everything else — or (b) a federation of community-run coordinators. Leaning (a).
- How do we handle a coordinator being offline? Each node should still serve its own repos read-only. PRs that span nodes degrade gracefully — "waiting for coordinator" rather than "broken."

---

### Stage 6 — Public repos and discovery *(formerly "v0.6" — not scheduled)*

**Goal:** A public repo on gitflare is as good a developer experience as a public repo on GitHub. Forking, drive-by contributions, search, code navigation.

Scope is mostly UX polish + a discovery surface. Not architecturally novel after Stage 5, so leaving the detail thin for now.

---

### Stage 7 — Production-ready, fully open source *(formerly "v1.0")*

The point at which we'd stop calling this beta. Hardening, polish, multi-region durability for the metadata layers we own (Artifacts already replicates itself). GitFlare stays fully open source — no hosted product, no paid tier; every user runs it on their own Cloudflare account. The roadmap here depends entirely on what we learn from Stage 1–Stage 6 so leaving it as a placeholder.

---

## 5. The mirror-forever invariant

Every version of gitflare must preserve this property:

> If a user disconnects gitflare tomorrow, their GitHub repo is in a state that loses nothing important. Conversely, if GitHub disappears tomorrow, gitflare has everything needed to keep operating.

Concretely:
- Every PR/issue/comment created on gitflare is mirrored to GitHub (when bound) within seconds, via the GitHub API, using the linked user's OAuth token.
- Every git ref pushed to gitflare is mirrored to GitHub (when bound). Failed pushes retry with exponential backoff and surface as a banner in the UI.
- The sync is observable: a "Sync status" page shows last-synced-at, lag, and any errors per direction.
- A user can `gitflare detach <repo>` to formally break the binding. After detach, gitflare is canonical; GitHub becomes a frozen archive.

This is non-negotiable through v0.5. After Stage 5, users who want a fully detached experience can have it; defaults still favor the mirror.

*Implementation status (2026-08-19, M9):* the git-ref half of this invariant is live for branches. Forward (GitHub → mirror) runs on the webhook; reverse (mirror → GitHub) runs from a per-repo Durable Object alarm, fast-forward only, never force, never delete, retrying 30 s · 2ⁿ up to 1 h and marking `stalled` after 7 days; a protected branch is `rejected`, a divergence is `conflict` — both surface on the dashboard and via `gitflare sync status`, and `gitflare sync now` re-attempts on demand. `gitflare detach` and the PR/issue/comment half remain Stage 4 work; tags and branch deletes are not propagated yet (M10).

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
- The default Mesh org is one the project operates as a free convenience so cross-tenant collab works out of the box; joining it is opt-in, and we never see repo contents — only the policy plane.

**What this rules out (deliberately):**
- We don't need a central reverse proxy fronting every user's repos. Mesh *is* the routing layer.
- We don't need to invent an auth protocol. Cloudflare Access + Mesh identities is the auth protocol.
- We don't need a global ACL store for cross-tenant repos. Each user's account stores their own policies; Mesh enforces them at the connection layer.

### Risks specific to Mesh

- **Vendor lock-in is now extreme.** If Cloudflare ever deprecates or repositions Mesh, the federation story breaks. Mitigation: keep a fallback "public HTTPS + signed-token auth" mode that works without Mesh, for self-hosted users.
- **Mesh is new (April 2026).** Real-world behavior at scale, latency profile across regions, and policy-eval semantics aren't yet battle-tested in third-party products. We have direct access to the Cloudflare team building these primitives, so this is a manageable risk — we plan a Stage 4.5 spike to stress-test Mesh for our exact access patterns and feed any gaps back to them before committing Stage 5's architecture.
- **Cost to users.** Mesh is part of Cloudflare One. Free tier covers 50 seats. Beyond that, users pay Cloudflare per seat, directly — GitFlare never sits in the billing path, so there's nothing to absorb or pass through. BYO keys means BYO Mesh bill. What we owe users is making that cost legible before they hit it.

## 7. Things we are deliberately not doing

- Building our own git server. Artifacts exists.
- Hosting non-Cloudflare deploy targets (AWS, Fly, Vercel). The pitch is depth on Cloudflare.
- macOS/Windows/iOS CI runners. Linux only. Hard line.
- A GitHub Actions marketplace clone. Our workflow format is intentionally smaller.
- Replacing GitHub's social graph (stars, followers, trending) in the first year.
- An LLM-chat-with-your-repo feature in the early stages. Cool, but a distraction from the trust story.
- A mobile app.

## 8. Open questions to resolve before Stage 1 starts

1. **Domain.** Working assumption: `gitflare.dev` for the marketing + onboarding surface. Per-user instances live at `<repo>.<account>.gitflare.dev` (or a custom domain the user brings). Confirm availability and budget. *(2026-08-19: still no domain, and no plan to get one for now — the CLI is the only surface; see §11 (b).)*
2. ~~**Pricing model.**~~ Resolved: **there isn't one.** GitFlare is not being monetized — no hosted tier, no per-seat, no paid coordinator. Every user runs it on their own Cloudflare account and pays Cloudflare directly for what they use. This is a standing constraint on the design, not a placeholder: anything that only works if there's a company collecting revenue behind it doesn't belong in the plan.
3. ~~**License.**~~ Resolved: **MIT**. GitFlare is and stays fully open source — no plans for a hosted commercial offering or relicensing. Everyone runs it on their own Cloudflare account, on the same terms.
4. **What "issues mirror" actually shows in v0.1.** Re-render from D1 (highest fidelity, most work), embed GitHub's UI in an iframe (lowest fidelity, fastest), or re-render read-only with link-out for actions (the middle path, currently leaning here).
5. **Artifacts pricing in GA.** The one primitive in our stack without published pricing. Worth getting an early signal from the Artifacts team given our direct access.
6. **Token-persistence policy.** §11 commits to "Cloudflare token never persists on gitflare servers" — we should formalize this as a written policy and have it reviewed before launch, since it constrains how a shared coordinator (Stage 4+) can be architected.

## 9. Suggested next steps

1. **Validate Artifacts public beta status and quotas.** Public beta was targeted for early May 2026 — confirm it's open and that one account can hold our expected repo volume.
2. **Build a 200-line spike of the Stage 1 webhook → Artifacts mirror.** This is the smallest thing that proves the core architecture is real. If it doesn't fall out cleanly in a weekend, the bigger plan needs rethinking.
3. **Write the workflow format spec.** Even though it's Stage 2+, the format shape constrains Stage 1 UI choices (e.g., where workflow files live in the repo browser).
4. **Mesh spike.** Stand up two Cloudflare accounts, enroll both in a Mesh org, prove that account A's Worker can serve a private endpoint to account B with per-identity policy enforcement. This is the riskiest unknown. Do it before committing to v0.5.

## 10. Surfaces and UX

gitflare has three surfaces. They have different jobs and don't compete with each other.

### `git` itself — unchanged

The user keeps using `git push`, `git pull`, `git clone` exactly as today. gitflare doesn't wrap or replace `git`. At install time we *optionally* add a second `pushurl` to `.git/config` for the GitHub-down escape hatch — opt-in, removable by `gitflare uninstall`. *(Status 2026-08-19: not yet built; lands in M9 as `gitflare remote add|remove` plus a `gitflare credential` git credential helper that mints short-lived Artifacts tokens, rather than as part of `init`.)* Anything that requires devs to learn a new push verb is dead on arrival.

### The web UI — daily-use surface for humans

Edge-rendered (Astro or Remix on Pages), served from the user's account subdomain.

Per version:
- **Stage 1** — repo browser, file viewer with syntax highlighting, commit log, blame, branches/tags, releases, README rendering, sync status. Issues + PRs visible but read-only.
- **Stage 2** — adds Deployments: live log streaming, rollback, environment + Workers Secrets management.
- **Stage 3** — adds Workflows: run history, logs, retry, cancel. "Open this commit in a Sandbox."
- **Stage 4** — full PR creation/review UI, issue CRUD, comments/reactions/threads, notifications, stacked-diff review, "Open PR in sandbox" (Sandbox + ArtifactFS + in-browser editor).
- **Stage 5** — cross-tenant invites, federated PR view, public directory.
- **Stage 6** — discovery, search, profile pages.

Aesthetic intent: Cloudflare dashboard vibe — dense, fast, technical. Not GitHub marketing. The product is for people who know git.

### The `gitflare` CLI — install, admin, scripting

Distributed as `npx gitflare` (no global install) and `brew install gitflare`.

Per version:
- **Stage 1** — `init`, `status`, `resync`, `detach`, `secrets`, `logs`. *(Status 2026-08-19: `init` + `status` shipped; `resync`/`detach`/`secrets`/`logs` deferred → M10. `access enable|disable` was added here instead.)*
- **Stage 2** — `deploy`, `deploys list`, `rollback`. *(Shipped as `deploy enable|disable|run|list|rollback`.)*
- **Stage 3** — `run <workflow>`, `sandbox` (spin up a Sandbox with current branch, drop into a shell with optional port forwards). *(Shipped as `ci enable|disable|run|list|cancel` — `run` takes no workflow name, it runs the repo's `ci.yml` at the current Artifacts HEAD; `sandbox` deferred → M10. M9 adds `sync enable|disable|now|status` and `remote add|remove`.)*
- **Stage 4+** — `pr` and `issue` subcommands modeled on GitHub's `gh` CLI for muscle-memory transfer.

The CLI is intentionally not the daily-use surface. `gitflare sandbox` is the one new daily verb we want to introduce — "clean Linux box with my code mounted, on Cloudflare's network, in seconds" — because it's a capability that doesn't exist today, not because we're competing with `git`.

### Editor integration — later

VS Code / Cursor extension for in-editor PR review and "open in cloud sandbox." Not early-stage territory. Lower priority because `gitflare sandbox` + the web UI cover most of the value.

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
- Below the fold: how it works, what it costs you on Cloudflare, self-host docs.

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

The Stage 1 scope list:

| Scope | Why |
|---|---|
| Account → Workers Scripts: Edit | Deploy the Worker (includes Durable Objects management) |
| Account → Artifacts: Edit | Create + manage repos, import from upstream, mint tokens. Read is granted implicitly. |
| Account → Account Settings: Read | Resolve account ID and workers.dev subdomain |

That's it for Stage 1 — three permissions. *Workers Routes* is a Zone-level permission and isn't needed unless the user brings a custom domain. R2/D1/KV are not used in Stage 1; they appear below as later versions add them.

**Three scopes for v0.1. Every one named. No "Edit all of Cloudflare" hand-grenade tokens.** Each later version adds scopes; never replaces:
- Stage 2 adds: `Workers KV Storage: Edit` (for cached deploy state)
- Stage 3 adds: the account-level **Containers** permission (needed the moment `gitflare ci enable` puts a `[[containers]]` block in the Worker config — exact permission name to be confirmed on the first live run; `ci enable` warns about this up front). Later in Stage 3: `R2: Edit` (specifically *Workers R2 Storage*, for build cache); `D1: Edit` (for CI run history)
- Stage 4 adds: `Cloudflare Access: Apps and Policies: Edit`
- Stage 5 adds: `Cloudflare One Connector: Edit`, `Cloudflare Tunnel: Edit`
- Custom domains (any version): `Zone → Workers Routes: Edit`, `Zone → DNS: Edit`

When the user upgrades versions, we show a diff of the new scopes vs. the existing token and walk them through re-issuing.

**(b) Cloudflare OAuth ("Authorize app").** ~~One-click flow if Cloudflare supports it for our app at the required scopes.~~ **Not planned (decided 2026-08-19).** Cloudflare does support it now — self-managed OAuth clients (GA 2026-06) with a PKCE flow for CLIs, scopes that map 1:1 to the permissions above, and a consent screen that returns the chosen account — but a *public* client (one any Cloudflare user can authorize) requires a registered OAuth client, a logo, a client URL on a domain we control with DNS-TXT verification, and public visibility is permanent. GitFlare has no domain and doesn't want to own an OAuth client registration, so path (a) — a scoped API token the user creates and pastes — stays the only path. Nothing rules OAuth out later; it's just not on the roadmap and nothing should depend on it. (Cheap improvement available any time without OAuth: link to the token page with the permissions pre-filled via `permissionGroupKeys=`.)

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

*Status 2026-08-19: only the second entry point exists — `gitflare init` in the terminal, with a GitHub PAT rather than OAuth. The `gitflare.dev` web flow and the `--session` handoff are deferred (the CLI flag is a stub that falls back to interactive). Nothing below is wrong as a target; it just isn't built.*

| Entry | Audience | Behavior |
|---|---|---|
| `gitflare.dev` (web) | First-time, most users | Guided OAuth + token + session handoff to CLI |
| `npx gitflare init <repo>` | Power users, no-browser preference | Walks the same flow in-terminal; opens browser only for OAuth steps |
| Self-host docs | Air-gapped / fully sovereign | Step-by-step manual token creation + `gitflare init --no-coordinator` |

All three terminate at: a working gitflare on the user's account.

### Auth boundaries by version

| Version | What GitFlare sees | What lives on the user's account |
|---|---|---|
| Stage 1–Stage 3 | Nothing. Token never persisted. | Everything: code, issues, runners, secrets. |
| Stage 4 (single-tenant teams) | Same — still zero. | Same. Team identities are managed via Cloudflare Access in the user's account. |
| Stage 5 (cross-tenant) | Coordination metadata only: PR threads spanning accounts, identity directory. Never repo contents. | Repo contents, runners, secrets, ACLs, Mesh policies. |
| Stage 5+ coordinator (community-run only) | Only cross-tenant metadata (PR threads, identity bindings) for those who opt in; never repo contents. | Same. |

This is the privacy guarantee, stated in operational terms. It is non-negotiable through v0.5.

## 12. Milestones and development log

The roadmap in §4 is what we're shipping. This section is *where we are right now* — the live state of the build. Updated at the end of every milestone. If you're new to the repo and want to know "what's working today," read this section first.

**Where to pick up (2026-08-19, evening).** M0–**M9** are done: M9 "GitHub-down mode" shipped and was live-validated the same day (row below), so the founding loop — mirror → CI/CD without GitHub → GitHub catches up — is closed. npm publishes via OIDC trusted publishing (0.3.2 and 0.4.0 went out that way; check `npm view gitflare version`, not the npm web page, which caches). Next is **M10** (backlog below) — pick by demand; the M9 soak items (auth/backoff path, `stalled`, a real multi-day outage) come first. Honest stage-level state vs §4: Stage 1 ≈ 70 % (metadata mirror + log/blame/tags never built — see the note under §4 Stage 1), Stage 2 ≈ 85 % (Pages + D1 paths not yet run live), Stage 3 ≈ 50 %, Stage 4+ not started; ≈ 20 % of the full Stage 1–7 vision overall, ≈ ⅔ of the solo-developer arc (Stages 1–3). Stages 4–6 are now marked **not scheduled** (see §4).

### Milestone status

| ID | Milestone | Status | Notes |
|---|---|---|---|
| M0 | Foundation: monorepo, README, license, scaffold, milestones tracker | ✅ done | First commit. Logo in `assets/`. Four packages (cli, worker, web, shared) with minimal stubs. Diagnostics will resolve after `pnpm install`. |
| M1 | Worker mirror spike: webhook → Artifacts | ✅ done | Worker now has: HMAC verification, Hono routing, RepoDO (per-repo Durable Object that serializes sync ops + persists last-synced SHA per ref), `syncGithubToArtifacts` using isomorphic-git over a custom in-memory fs (`MemFs`), Artifacts binding type definitions, REPO_MAP var for github→artifacts name lookup. 10/10 unit tests pass (HMAC + memfs). All packages typecheck. End-to-end run on a real Cloudflare account waits for M2 (CLI provisioning). |
| M2 | CLI init flow | ✅ done | Full interactive provisioning: GitHub PAT verification (lists user + repo metadata), Cloudflare token verification with multi-account picker, contract preview before any side effect, Artifacts namespace ensure + repo import, wrangler.toml rewrite, `wrangler deploy` shell-out, secrets set via `wrangler secret put`, webhook install on GitHub (with duplicate-detection + replace), local config persisted at `~/.gitflare/credentials.json` mode 0600. 10/10 CLI tests pass (URL parser, repo name sanitizer, random hex). |
| M3 | Read-only web UI | ✅ done | Hono JSX served from the same Worker (one deploy, one URL). Landing page lists configured repos with: GitHub link, Artifacts clone URL, sync status pill, per-ref last-synced SHA + relative time. Cloudflare visual language: dark, Inter + JetBrains Mono, orange (#F38020) only for the brand mark. Plus `/api/refs` JSON endpoint. Separate `packages/web` removed — YAGNI for v0.1. |
| M4 | Stage 1 cut: end-to-end working read replica | ✅ done | All three components compose cleanly: CLI provisions → Worker deploys → webhook fires → sync runs → UI shows synced state. [QUICKSTART.md](./QUICKSTART.md) walks the full flow. Live-validated against `sinameraji/kimiflare`. |
| M4.5 | Browseable dashboard | ✅ done | Top-level entries on the home page link to per-path tree/blob routes. Inside a directory: breadcrumb + parent link + clickable entries (links recurse). Inside a file: plain `<pre>` rendering with binary detection. README images rewritten to GitHub raw URLs for public repos. |
| M4.7 | Publish to npm | ✅ done | esbuild bundles the worker (~678 KB) into the CLI's `dist/`. CLI invokes wrangler directly via `require.resolve` (no `pnpm exec` runtime dep). Published as [`gitflare`](https://www.npmjs.com/package/gitflare). Anyone can now `npx gitflare init <repo>`. |
| M5 | Privacy via Cloudflare Access | 🧪 implemented, not yet live-validated | Worker: `accessGuard` middleware verifies the `Cf-Access-Jwt-Assertion` JWT (RS256 via WebCrypto + JWKS cache, no `jose`) and gates `/` + `/r/*` + `/api/*`; enforces only when `ACCESS_AUD` var is set, so public mirrors stay open. `/webhooks/github` + `/health` left unauth. 8 unit tests. CLI: opt-in `gitflare access enable/disable` creates/deletes a self-hosted Access app + allow-list policy and redeploys with `ACCESS_AUD`/`ACCESS_TEAM_DOMAIN` vars. **Caveat:** this gates the dashboard/API only — `git clone` hits Artifacts directly (`*.artifacts.cloudflare.net`), so it is NOT Access-gated; private-clone is a later (Stage 4+) item per §6/§11. **TODO before ✅:** verify the live Access apps/policies API shapes + `aud` field, and that `*.workers.dev` hosts are accepted, against a real account. |
| M5.5 | Stage 1 polish | 🧪 implemented | Syntax highlighting in the blob viewer (highlight.js core + ~20 curated grammars, server-side; 512 KB cap with `<pre>` fallback; bundle 681→901 KB). README image proxy: new `GET /r/:name/raw/*` serves blob bytes from the Artifacts mirror so images render for private repos and survive GitHub outages — README rewriting now points there instead of `raw.githubusercontent.com`. Styled empty/error states (`ui/states.tsx`): home shows the `npx gitflare init` command, browse 404/500 render through the layout with a way back. |
| M6 | Stage 2 CD (MVP slice) | 🧪 implemented | **Self-deploy model (user chose Worker-Secret path).** On push, after sync, the webhook fires `DeployDO` (`waitUntil`), which clones the repo, parses `.gitflare/deploy.yml`, and uploads the pre-built `cloudflare/deploy { kind: worker }` entry via the Workers Scripts multipart API. History in `DeployDO`; Deployments UI; CLI `gitflare deploy enable/disable` stores `CF_DEPLOY_TOKEN` + `CD_ENABLED`. Superseded by M7. |
| M7 | Stage 2 CD — complete (per §4) | ✅ live-validated (worker 2026-07-17; Pages + D1 2026-08-19) | Everything in §4 Stage 2: **(1)** real YAML-subset parser (`deploy/yaml.ts`, no heavyweight dep) → **worker bindings** (vars/KV/R2/D1/DO/services) in the Scripts metadata; **(2)** **Pages** deploys via Direct Upload (upload-token → check-missing → upload → create-deployment), with per-branch **previews** (`production_branch`); **(3)** **D1 migrations** applied in order via the D1 query API, opt-in (`apply: true`), idempotent (applied set tracked per-DB in the DO); **(4)** **live deploy-log streaming** over a hibernatable WebSocket (`/r/:name/deployments/stream`) with the Deployments page subscribing; **(5)** **manual / GitHub-down trigger** `gitflare deploy run` + `/control/deploy/run` (auth'd by a `CONTROL_SECRET`, outside Access); **(6)** `gitflare deploy list` + `gitflare deploy rollback [--to <id>]` (rollback redeploys a previous successful commit via a full clone; migrations are forward-only and skipped). 56 unit tests across yaml/workflow/cf-deploy/highlight/access. **Live status (2026-07-17):** the **worker** deploy path (`uploadWorkerScript`: Scripts multipart upload + bindings + the workers.dev-subdomain enable fix) is validated — the Stage 3 CI deploy job delegates through this exact code and shipped a reachable worker (see M8). The **sync** the deploy runs on top of is validated too (the `JsRpcProperty` remote fix). **Pages + D1 live-validated 2026-08-19** (kimiflare, branch `gitflare-cd-test`): a push ran `deploy.yml` at the pushed sha, applied `0001_init.sql` to a D1 database (row verified via the query API), and `deployPages()` shipped a production deploy + two branch previews that serve at `*.pages.dev`. Two bugs found and fixed on the way: (1) the push path cloned the DEFAULT branch, so a `deploy.yml` on any other branch read as "no .gitflare/deploy.yml" and Pages previews from feature branches could never run — now cloned strictly at the pushed sha (also closes the "known quirk" race below); (2) Pages asset keys were 64-char sha256 hex — the API accepted the upload but every request 500'd at serve time; keys are now 32-hex like wrangler's. Note: the deploy token needs **Cloudflare Pages: Edit** for Pages deploys (the "Edit Cloudflare Workers" template has D1 but not Pages — kimiflare's token hit `[10000] Authentication error` on `upload-token`). Known quirk (kept in M8): the Stage 2 push path reads workflow/content at the clone's HEAD while recording the webhook sha — same-branch seconds-apart race only; the Stage 3 CI path reads strictly at the pushed sha by construction. |
| M8 | Stage 3 core CI — sandbox jobs, needs-gated deploys | ✅ core live-validated (2026-07-17, `sinameraji/kimiflare`) | **Format** (`.gitflare/ci.yml`, parsed by `src/ci/workflow.ts` reusing the yaml.ts subset + the shared `cloudflare/deploy` step validator): `on`/`branches`, `jobs:` with `needs:` (parse-time unknown/cycle validation, Kahn topo order), `run:` steps (multi-line via new `\|`/`\|-` block-scalar support in yaml.ts), per-job `env:` + `timeout_minutes` (default 15, max 60); a job is either a run job or a deploy job (mixing = parse error). **Execution**: new `CiDO` (binding `CI`, migration v3) — POST `/run` answers 202 and the pipeline runs as detached DO work; ONE sandbox per run (`@cloudflare/sandbox@0.12.3`, image pinned to match) cloned once from the Artifacts mirror via env-scoped `http.extraHeader` auth (token never in argv/.git/config/stderr; every log line scrubbed for the secret + its base64), then jobs execute in topo order with streamed line-buffered logs (hibernatable WS at `/r/:name/ci/stream`, cap 1000 lines/job). **Deploy jobs delegate to DeployDO** (`mode: "ci"`, strict at-sha ref-aware clone via new `cloneRepoAtRef`, feature branches included) so deploy history/rollback stay in one place; `DeployRecord` gains `workflow`/`job` for cross-format rollback. **Artifact handover**: worker entries built by run jobs are read out of the sandbox (5 MB cap) and shipped via `entryOverrides` — deploys ship what CI built, not the stale committed file. **Safety**: alarm watchdog fails interrupted/over-budget runs + destroys orphaned sandboxes; cancel (CLI `gitflare ci cancel`, `/control/ci/cancel`, runs-page button); push-storm supersede; fail-closed — committed ci.yml + CI disabled means deploy.yml does NOT run ungated; delegated deploys count as green ONLY on `status: "success"` (a "CD not enabled" skip fails the job loudly). **Status postback** via the legacy Commit Status API (context `gitflare/ci`; classic PAT can't use Checks), soft-fail. **CLI**: `gitflare ci enable/disable/run/list/cancel`; enable provisions `[[containers]]` (public `docker.io/cloudflare/sandbox` image — no local Docker; `--instance-type`, default `standard-1`); migrations v3+v4 are emitted UNconditionally so cross-machine redeploys never miss applied tags; CONTROL_SECRET reuse is symmetric with `deploy enable`; disable drops only `CI_ENABLED` (idle containers cost $0). 51 new unit tests (97 total worker-side). Worker bundle 901 KB → 1557 KB (sandbox SDK +433 KB, capnweb +104 KB, containers +75 KB); ~400 KB gzipped, fine for Workers limits. **Deliberate deviations from §4 Stage 3**: `runtime: worker` rejected with a clear error (Dynamic Workers can't run npm — no Linux userland); per-job `image:` rejected (containers pin the image at Worker-deploy time); ArtifactFS mount not used (sandbox `git clone`; cold container start pulls the image from Docker Hub — minutes, not the §4 \<500ms); jobs in one run share a sandbox/workspace (GHA users expect isolation — M10); Pages artifact handover, R2 build cache, Browser Run, Actions importer, per-job status contexts, `gitflare sandbox` verb → M10. **Post-review hardening** (a 4-lens adversarial review of the diff, 18 findings, all verifier-confirmed): FIXED — watchdog/pipeline verdict races (a `finalizedRunIds` fence stops a lagging coroutine resurrecting a run the watchdog failed, and the watchdog no longer erases a concurrent cancel); a fallback alarm armed in `begin()` so eviction before the deadline alarm can't leave a zombie "running" record; `ARTIFACTS.get` moved inside the try (+ a last-resort commit status) so a push can't vanish traceless; tag/non-branch pushes skipped at the webhook (were minting failed runs + red statuses); artifact handover gated on the whole `needs` closure of run jobs succeeding (was shipping a failed build's output); the dead "fall back to deploy.yml" path on missing SANDBOX replaced with an honest fail-closed error; delegated-deploy response mapping extracted to a tested pure fn (`ci/delegation.ts`, all four shapes incl. skipped-is-not-green); the remote-URL allowlist tightened to reject shell metacharacters; duplicate webhook deliveries de-duped by branch+sha; dashboard cancel gated behind Access (was open on public mirrors — CLI `gitflare ci cancel` uses CONTROL_SECRET); CONTROL_SECRET now always (re)written on enable and config persisted the moment the Worker goes live (was strandable across machines / on a partial enable). RESIDUAL (documented, not yet fixed — acceptable for a not-live-validated milestone): a run still queued in-memory when the DO is evicted (e.g. by a redeploy) is dropped with no record; webhook delivery order isn't guaranteed by GitHub, so the supersede optimization is best-effort (out-of-order delivery can run the older sha last); cancel is a no-op during a run's brief pre-clone window and cannot un-ship a deploy job that already returned success (the run message says so). **Live-validated end-to-end** (2026-07-17, `sinameraji/kimiflare` on a real Workers Paid account): `gitflare ci enable` provisions the `[[containers]]` app from wrangler TOML; a push → webhook → sync → CI run #1 succeeded in 12s — the Sandbox booted (`node v22`), cloned the mirror at the pushed sha with a short-lived read token (URL logged WITHOUT credentials — env-scoped auth + scrubbing confirmed), and ran all 4 `run:` steps with streamed line-buffered logs, resolved env vars, and captured exit codes. Findings fixed along the way (all on this branch): (1) container deploy needs BOTH **Account → Cloudchamber:Edit** and **Account → Containers:Edit** token permissions (Containers alone → `Forbidden`); (2) the container app name can't contain consecutive dashes, so we emit an explicit sanitized `name` (the `owner--repo` worker name has `--`); (3) a latent M1 sync bug — `artifactsRepo.remote` on the current Artifacts beta is a lazy RPC proxy that stringifies to `[object JsRpcProperty]`; now threads the REPO_MAP remote string (would have broken any live Stage 2 deploy too); (4) the push webhook awaited the full sync and blew past GitHub's 10s delivery timeout on a real repo (504 + redeliveries) — now responds 202 immediately, sync + dispatch in `waitUntil`; (5) commit-status postback soft-fails observably (the run logs *why* — here, an expired GITHUB_TOKEN). Config also cross-checked via `wrangler deploy --dry-run` (both CI-provisioned and default TOML resolve all four DO exports incl. unbound-Sandbox migration v4). **Deploy-job delegation also validated** (2026-07-17): a two-job `ci.yml` (a `run` job builds `dist/worker.js` in the sandbox — NOT committed — then a `needs`-gated deploy job) ran green end-to-end; the log shows `using CI-built dist/worker.js (103 bytes)` → the sandbox artifact flowed through `entryOverrides` to `DeployDO` and shipped, and the deployed worker served the CI-built body at **HTTP 200**. This surfaced + fixed a **latent Stage 2 bug**: `DeployDO`'s raw Scripts-API upload never enabled the `workers.dev` subdomain (wrangler does; the API doesn't), so deployed workers 404'd — `uploadWorkerScript` now enables it and returns the reachable URL. Commit statuses also confirmed rendering on GitHub once a fresh `GITHUB_TOKEN` was set. **Not yet exercised live** (deferred soak): the alarm watchdog firing, cancel mid-run, and hour-scale runs / `sleepAfter` container-activity behavior. |
| M9 | "GitHub-down mode is real": auto-trigger on Artifacts push + reverse sync to GitHub + `pushurl` fan-out | ✅ shipped + live-validated (2026-08-19, `sinameraji/kimiflare`) | **Goal** (§5 invariant): `git push` to the mirror while github.com is down → CI/CD runs automatically → when GitHub is back, branch refs fast-forward back to GitHub. **Design**: Artifacts `cf.artifacts.repo.pushed` events → Queues event subscription → queue consumer on the same Worker (`export default { fetch, queue }`) → RepoDO `POST /artifacts-push` classifies own-vs-external (an `outbound:<ref>` marker written *before* every forward push, plus `ref:` sha equality) → dispatch CI/deploy with mode `artifacts-push` (DeployDO gains branch+sha dedupe like CiDO) and record a `reverse:<ref>` entry worked off by a RepoDO **alarm** (`sync/reverse-sync.ts`: `listServerRefs` both sides → noop if equal → `cloneBranchReaching` with GitHub's tips as anchors → `git.push` fast-forward only, never force/delete; rejects classified `conflict` / `rejected` (protected branch) / `auth` / `error`, backoff 30 s·2ⁿ capped 1 h, `stalled` after 7 days). `/sync` short-circuits when the mirror already has the sha (`dispatch:false`) so the webhook echo of our own GitHub push doesn't loop. **CLI**: `gitflare sync enable|disable [--purge]|now [--ref]|status` (REST-provisions queue + subscription — wrangler can't yet scope an `artifacts.repo` subscription; new token permission **Queues → Edit**; vars `SYNC_ENABLED`, `WORKER_URL`; `[[queues.consumers]]` in the generated TOML) and `gitflare remote add|remove` (GitHub-first `pushurl` fan-out + `gitflare credential`, a git credential helper minting 600 s write tokens via REST from the saved CF token). **UI**: per-ref status in both directions + a banner for refs waiting to reach GitHub. **Scope cuts**: branches only — tag and delete events are acked and never propagated (→ M10). **Also fixes** the latent forward-sync shallow-depth bug (a >50-commit push hits a false `not-fast-forward`). **Spikes first** on the real account: S1 subscription REST shape + which pushes emit events, S2 queue naming + permission, S3 Artifacts token REST/TTL + native-git Basic auth, S4 isomorphic-git push semantics (same-sha, protected branch, shallow boundary). **PRs** (all merged 2026-08-19): #14 engine + RepoDO state machine + DeployDO dedupe → #16 queue consumer + `sync enable|disable|now|status` → #18 `remote add|remove` + `gitflare credential` → #19 forward-sync anchor fix → docs. **Spike results** (real account): subscription REST body needs `source:{type:"artifacts.repo",namespace,repo_name}` (snake_case; the event itself carries camelCase `source.repoName`); `pushed` events fire for branch push, tag push, branch/tag delete (`after` = zeros) AND same-sha pushes (`before`==`after` — treated as no-ops); commits truncated at 20 with `commitsTruncated`/`totalCommitsCount`; Artifacts token REST `POST /artifacts/namespaces/{ns}/tokens {repo,scope,ttl}` → `{id, plaintext(?expires=…), expires_at}`, TTL 60 s–1 y, native git Basic auth `x:<plaintext>` works; Queues on the Free plan; queue names may contain `--`; isomorphic-git same-sha push is accepted by Artifacts, and a shallow window that excludes the remote tip yields a false `not-fast-forward` (reproduced). **Live validation**: `sync enable` provisioned queue + subscription + consumer and redeployed (OAuth token with queues:write sufficed; API tokens need Queues → Edit); a **mirror-only push** was recorded (source `artifacts`, reverse `pending`) within 10 s, dispatched exactly one pipeline run (mode `artifacts-push`), and was on GitHub within 20 s (`synced`); the webhook echo of that push short-circuited (`already-mirrored`, no second run); `remote add` + one `git push` landed both legs through the credential helper with exactly one pipeline run (the Artifacts event was recognised as own); `sync status` shows both directions; **divergence** (A on GitHub, B on the mirror) → `conflict` with a clear message, GitHub untouched, forward sync refused — nothing forced; delete on the mirror → RepoDO forgot the ref, nothing propagated. **Found + fixed on the way**: the forward sync had been failing on kimiflare `main` since May — the mirror sat at the import sha while GitHub advanced ~150 commits, because a shallow window that excludes the mirror's tip trips isomorphic-git's local fast-forward check; now the sync asks the mirror for its tip and deepens until it's inside (#19; a 103-commit fast-forward synced in ~20 s live) — the next real push to `main` heals it. **Not yet exercised live**: `auth`/backoff retries, `stalled` after 7 days, `sync disable --purge`, a genuine outage. |
| M10 | Backlog: Stage 3 remainder + Stage 1 completeness + validation debt | 📋 backlog (unordered) | Re-homed from M8's deferrals: per-job sandbox isolation, Pages build-artifact handover, R2 build cache keyed on lockfile hash, Browser Run for E2E, GitHub Actions importer, per-job commit-status contexts, `gitflare sandbox`. From M9: tag + branch-delete sync. From §4 Stage 1: ~~read-only issues/PR mirror~~ (2026-08-19: MetaDO — webhook-fed, alarm-driven GitHub-API import; issues/PRs/comments/reviews/releases with link-outs), ~~commit log~~ (2026-08-19, via the Artifacts binding's `log()`), blame, ~~tag list~~ (2026-08-19: tags sync on push + `gitflare sync tags` backfill; reverse tag sync and tag deletes still not propagated), ~~release list~~ (2026-08-19), ~~GitHub health row~~ (2026-08-19), LFS; CLI `resync`/`detach`/`secrets`/`logs`. Validation debt: ~~Pages Direct Upload, D1 migrations~~ (done 2026-08-19), Access apps/policies, CI watchdog + cancel soak, M9 auth/backoff path. Each item is independent — pick by demand. |

### What's in the repo right now (as of v0.3.1)

```
gitflare/
├── PLAN.md              ← design doc (this file)
├── README.md            ← project overview + logo
├── LICENSE              ← MIT
├── CHANGELOG.md         ← generated by Release Please
├── QUICKSTART.md        ← end-to-end provisioning guide + GitHub-down drill
├── .github/workflows/   ← ci.yml (typecheck/test/build) · release-please.yml (release PR + npm OIDC publish)
├── .gitignore
├── package.json         ← workspace root (pnpm)
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── assets/
│   └── logo.png
└── packages/
    ├── worker/          ← Hono Worker: webhook→sync, DeployDO (CD), CiDO (CI), Access guard, JSX UI — one deploy
    └── cli/             ← `gitflare` CLI: init/status/access/deploy/ci; bundles the worker with esbuild for npm
```

### Cadence

After each milestone:
1. Mark its row above ✅ done.
2. Update "what's in the repo" if structure changed.
3. Note any plan-level changes that arose (new open questions, scope cuts, surprises).
4. Move to the next milestone.

The intent of this section is that someone resuming the project after a long pause (or a new collaborator) can read §12 and know exactly where to pick up, without having to skim the rest of the doc.
