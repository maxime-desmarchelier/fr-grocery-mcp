# Contributing

Thanks for considering a contribution. This is a small project with a narrow purpose: give an agent **domain-level**
access to French online grocery sites, and never place an order.

## Before you start

- Open an issue first for anything larger than a typo or a small fix, so the design can be agreed on.
- For a security problem, do **not** open an issue: follow [SECURITY.md](SECURITY.md).
- By contributing you agree that your work is released under the [MIT license](LICENSE).

## Setup

Node 24 (or later) is needed. The versions used by the project are pinned in [mise.toml](mise.toml).

```sh
git clone https://github.com/maxime-desmarchelier/fr-grocery-mcp
cd fr-grocery-mcp
npm ci
npm run check
```

`npm run check` (typecheck + Biome + tests with coverage thresholds) is exactly what CI runs: it must pass before any
commit is proposed. Tests never touch the real sites; `npm run doctor` and `npm run test:live` do, at your own risk
and only when you ask for it.

## Code rules

The full reasoning is in [AGENTS.md](AGENTS.md) and [docs/architecture.md](docs/architecture.md). The ones that
matter in review:

- **No tool, method or request may place an order, book a slot or pay.** This is the core guarantee of the project.
- **No bypassing of protections**: human pace, one request at a time, a block stops everything (`SiteBlockedError`,
  never retried), no captcha solving.
- The domain (`src/domain`) stays pure: no import of infrastructure, Node or any library.
- No business logic in `src/interface/mcp`: validate, call the service, present.
- Every adapter implements the whole `GroceryStore` port; what a site does not support throws `NotSupportedError`
  and is declared in `capabilities`. The contract suite in `test/contract/` must pass for each adapter.
- Relative imports with the `.ts` extension. No `enum`, `namespace` or parameter properties (`erasableSyntaxOnly`).
- Amounts are `Money` (cents) throughout; euros only in the presenters.
- External data (a site's JSON, the configuration) is validated by a zod schema.

## Adding or fixing a retailer

Retailer sites change without notice. When one does:

1. Capture the pages again: `npm run fixtures -- <retailer>`.
2. Adapt the parsers and their unit tests next to the existing fixtures.
3. Keep the adapter thin: the site-specific knowledge belongs in `parsers.ts`.
4. Update `docs/retailers/<retailer>.md` with what changed.
5. Make sure `npm run check` passes.

A new retailer follows [docs/adding-a-retailer.md](docs/adding-a-retailer.md) and must not regress the existing ones.

## Commits and pull requests

- Commits follow [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `test:`,
  `chore:`), in English. French is fine for retailer-facing labels only.
- One topic per pull request; keep diffs small and focused.
- Update `CHANGELOG.md` under `## [Unreleased]` for anything a user can notice.
- Fill in the pull request template: what changed, how it was tested, and confirm that no order can be placed.
- `main` is protected: pull requests are required and CI must be green before merging. There is a single maintainer,
  so a review is not mandatory, but the CI check is.
