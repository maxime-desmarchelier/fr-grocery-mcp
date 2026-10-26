# Instructions for coding agents

Multi-retailer MCP server (E.Leclerc Drive, Super U) in TypeScript, run natively by Node 26 in development. `prepack`
compiles `src/` to JavaScript in `dist/` for npm; never publish raw TypeScript.
Read `docs/architecture.md`; for a new retailer, `docs/adding-a-retailer.md`.

## Commands

- `npm run check`: typecheck + lint + tests (unit, contract, integration) with coverage. Must pass before any
  commit.
- `npm run doctor`: real sites, read-only (`FR_GROCERY_CONFIG` for Leclerc).
- `npm run test:live`: real sites, only at the user's request (temporarily changes their cart).
- `npm run format`: Biome formatting.

## Rules

- No tool, method or request that places an order, books a slot or pays.
- No bypassing of protection: human pace, an anti-bot block stops everything (`SiteBlockedError`, never
  retried), no captcha solving.
- The domain (`src/domain`) stays pure: no import of infrastructure, Node or any library.
- No business logic in `src/interface/mcp`: validate, call the service, present.
- Every adapter implements the whole `GroceryStore` port; what the site does not support throws
  `NotSupportedError` and is declared in `capabilities`. The `test/contract/` suite covers every adapter.
- Relative imports with the `.ts` extension. No `enum`, `namespace` or parameter properties
  (`erasableSyntaxOnly`).
- Amounts as `Money` (cents) throughout the code; euros only in the presenters.
- External data (a site's JSON, the configuration) validated by a zod schema.
- A change on a site: capture the fixtures again (`npm run fixtures -- <retailer>`), adapt the parsers and
  their tests, update `docs/retailers/<retailer>.md`.
- stdout is reserved for the MCP protocol: diagnostics on stderr only.
- Commits in Conventional Commits format, in English. Release PRs and versioning are automated with release-please;
  see `docs/releasing.md`. Do not edit versions or `CHANGELOG.md` by hand.
