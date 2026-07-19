# Changelog

## [0.3.1](https://github.com/sinameraji/gitflare/compare/gitflare-v0.3.0...gitflare-v0.3.1) (2026-07-17)


### Bug Fixes

* **deploy:** enable workers.dev subdomain on worker deploy ([460cf86](https://github.com/sinameraji/gitflare/commit/460cf86ee54099104f4d3d8b6b7c329e4d9469e8))
* **deploy:** enable workers.dev subdomain on worker deploy ([d5ae143](https://github.com/sinameraji/gitflare/commit/d5ae1434fd1a3d8fc02002aecf36465500198b8f))

## [0.3.0](https://github.com/sinameraji/gitflare/compare/gitflare-v0.2.0...gitflare-v0.3.0) (2026-07-17)


### Features

* v0.3 core CI (M8) — .gitflare/ci.yml jobs on Cloudflare Sandboxes ([1e84a7d](https://github.com/sinameraji/gitflare/commit/1e84a7df6c2965d377833bc47171b363cd061d25))
* v0.3 core CI (M8) — .gitflare/ci.yml jobs on Cloudflare Sandboxes ([4c377e0](https://github.com/sinameraji/gitflare/commit/4c377e0fab3c55e2c072e703dc91a0e46f00548a))


### Bug Fixes

* **ci:** harden M8 against review findings (watchdog races, auth, artifact gating) ([84c5dbe](https://github.com/sinameraji/gitflare/commit/84c5dbef2bf1e1f3b9a45a589b53ba05ab1987ed))
* **ci:** name both Cloudchamber + Containers Edit permissions in the enable error ([47a089c](https://github.com/sinameraji/gitflare/commit/47a089c0cc45542a54039ef96dc3a7e831604361))
* **ci:** set explicit container app name to avoid consecutive-dash rejection ([41e9f89](https://github.com/sinameraji/gitflare/commit/41e9f89fcbabecb7518351ed00860ff75f020db7))
* **ci:** use standard-1 instance type; validate wrangler config via dry-run ([84031ab](https://github.com/sinameraji/gitflare/commit/84031ab3a3123e6f12c014628c267832ba4fb017))
* **sync:** use REPO_MAP remote string, not artifactsRepo.remote (RPC proxy) ([e4d9b9a](https://github.com/sinameraji/gitflare/commit/e4d9b9ac838534b644b185d07cecf43010998cdc))
* **webhook:** respond 202 immediately; surface status-postback failures ([db31ebc](https://github.com/sinameraji/gitflare/commit/db31ebc1e445f980ffd5e8565ed71ef9d8438e03))

## [0.2.0](https://github.com/sinameraji/gitflare/compare/gitflare-v0.1.3...gitflare-v0.2.0) (2026-06-08)


### Features

* Cloudflare Access (M5), blob highlighting + image proxy, and v0.2 CD ([3ef2f16](https://github.com/sinameraji/gitflare/commit/3ef2f16f0e1600fbe9e069f50aab6bb00b3df9ab))
* Cloudflare Access (M5), blob highlighting + image proxy, v0.2 CD, and release automation ([c1bced6](https://github.com/sinameraji/gitflare/commit/c1bced6416a92a49baa952cafdcf21c6f0de2947))
* complete v0.2 CD — bindings, Pages, D1 migrations, live logs, run/list/rollback ([cbe0dde](https://github.com/sinameraji/gitflare/commit/cbe0dde8db9491c0c0140839c8e1c2caaaad5772))
* complete v0.2 CD — bindings, Pages, D1 migrations, live logs, run/list/rollback ([0fec1b7](https://github.com/sinameraji/gitflare/commit/0fec1b79de54c60e61d52f5335a52b9c9175ee6a))
