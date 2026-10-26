# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions: [SemVer](https://semver.org/).

## [0.2.0](https://github.com/maxime-desmarchelier/fr-grocery-mcp/compare/v0.1.1...v0.2.0) (2026-10-26)


### Added

* application services and MCP server on an in-memory retailer ([867fccf](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/867fccffdf6405d1692961283f2de4a62fd2bfd0))
* **infra:** drive Chrome over CDP, throttle requests and retry transient failures ([2350901](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/23509011a9e8ce3c67ebd04a1ba2c953c8f8190d))
* **leclerc:** E.Leclerc Drive adapter, store search and selection ([e24d099](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/e24d099ae84a19285fc2d23f0c012bd1870ab27c))
* **superu:** Super U adapter with pure parsers and real page fixtures ([f3a9a79](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/f3a9a79c0282b6cdfa1206fcd7496f867951eb07))


### Fixed

* keep the branch guard in the pre-commit hook ([#14](https://github.com/maxime-desmarchelier/fr-grocery-mcp/issues/14)) ([e6c98ad](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/e6c98ad0f82fc430ca6ff4700d546fefe13206c5))
* skip the branch guard when CI runs the hooks ([#13](https://github.com/maxime-desmarchelier/fr-grocery-mcp/issues/13)) ([0859a50](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/0859a50d18836e53f1c8e4bc8afda0c47fb5a4fc))

## [0.1.1](https://github.com/maxime-desmarchelier/fr-grocery-mcp/compare/v0.1.0...v0.1.1) (2026-10-26)


### Fixed

* keep the branch guard in the pre-commit hook ([#14](https://github.com/maxime-desmarchelier/fr-grocery-mcp/issues/14)) ([81c86e2](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/81c86e230a04c7e7921d13675022ebddd3312540))
* skip the branch guard when CI runs the hooks ([#13](https://github.com/maxime-desmarchelier/fr-grocery-mcp/issues/13)) ([a1f1dc5](https://github.com/maxime-desmarchelier/fr-grocery-mcp/commit/a1f1dc5a2860ceb204545fb811fa80173530d2ed))

## [0.1.0] - 2026-10-25

First public release: a single MCP server for several French online grocery services ("drive"), with
E.Leclerc Drive and Super U adapters.

### Added

- **E.Leclerc Drive** adapter: search, product page (ingredients, allergens, origin), cart, next pickup slot
  and cart pickup date, store search and selection (remembered in `~/.fr-grocery-mcp/leclerc-store.json`).
  Real reference pages and tests; see `docs/retailers/leclerc.md`.
- **Super U** adapter: search, product page (ingredients, origin), cart, next slots, booked slot, minimum
  order amounts. See `docs/retailers/superu.md`.
- `store` parameter on every retailer tool (an enum built from the configuration).
- `list_stores(check)`: retailers, capabilities and the status of each session.
- `compare_carts(mode)`: total, lines, minimum and missing amount, next slots per retailer, cheapest first.
- `find_stores` / `set_store` for any retailer that supports it (`NotSupportedError` otherwise).
- Typed promotions (`immediate`, `multibuy`, `loyalty`) with a quantified mechanic and `best_offer` (net cost
  per unit, bundles and loyalty credit included).
- Dated slots (`start` / `end` as `YYYY-MM-DDTHH:MM`); `get_order_conditions` without `store` queries every
  retailer.
- Cart changes confirmed by reading the cart back (`confirmed`), so a site answering 200 without applying the
  request is not reported as a success.
- Typed results (`outputSchema`, `structuredContent`), tool annotations and server `instructions`.
- Hexagonal architecture: pure domain, one adapter per retailer, pure parsers tested on real pages.
- Contract suite in `test/contract/` run against every adapter; unit, contract and integration tests with no
  access to the sites.
- `npm run doctor` (real sites, read-only), `npm run test:live` (real sites, opt-in), `npm run fixtures`
  (recapture a retailer's reference pages), `mise run chrome` (debug Chrome on a dedicated profile).
- Documentation: `docs/architecture.md`, `docs/adding-a-retailer.md`, `docs/retailers/<id>.md`.

### Security

- Every request goes through the user's own browser session, one at a time and spaced out.
- No anti-bot protection is bypassed: a `SiteBlockedError` stops the server and is never retried.
- No tool books a slot, places an order or pays.
