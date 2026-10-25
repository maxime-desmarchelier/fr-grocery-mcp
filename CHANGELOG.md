# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), versions: [SemVer](https://semver.org/).

## [Unreleased]

### Added

- Security policy, contribution guide, issue and pull request templates, code owners.
- Git hooks with [hk](https://hk.jdx.dev) (`hk.pkl`): Biome and the type checker run on the files a commit touches,
  apply their fixes and stage them.

### Changed

- Node 26 is now the supported runtime (`engines`, CI, `mise.toml`); `@types/node` aligned on 26.x.
- The Biome configuration is stricter: type-aware rules, `noFloatingPromises`, `noMisusedPromises`,
  `noUndeclaredDependencies`, `useTopLevelRegex`, sorted object keys, and the regexes of `src/` and `scripts/`
  hoisted to the module scope.
- The toolchain is pinned in `mise.lock` (multi-platform) and CI installs it with `jdx/mise-action`, so the Node
  version is declared in one place only.

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
