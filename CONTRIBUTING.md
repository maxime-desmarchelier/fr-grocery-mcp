# Contributing

Thanks for considering a contribution. This is a small project with a narrow purpose: give an agent **domain-level**
access to French online grocery sites, and never place an order.

## Before you start

- Open an issue first for anything larger than a typo or a small fix, so the design can be agreed on.
- For a security problem, do **not** open an issue: follow [SECURITY.md](SECURITY.md).
- By contributing you agree that your work is released under the [MIT license](LICENSE).

## Setup

Node 26 (or later) is needed. The toolchain is declared in [mise.toml](mise.toml) and pinned in `mise.lock`, so
everyone and CI install the same version.

```sh
git clone https://github.com/maxime-desmarchelier/fr-grocery-mcp
cd fr-grocery-mcp
mise install --locked            # Node from mise.lock; or install Node 26 yourself
npm ci
mise run check                   # same as npm run check: typecheck, lint, tests with coverage
mise run lint                    # linters and hygiene checks on the whole repository (hk check --all)
```

If you already have a global mise config with unpinned tools, `mise install --locked` may report them as missing from
the lockfile: run `mise lock --global` once, or install the project tools with `mise install node`.

`npm run check` (typecheck + Biome + tests with coverage thresholds) must pass before any commit is proposed. CI runs
the same two things: `hk check --all` (the linters and hygiene checks, on the whole repository) and
`npm run test:coverage`.
Tests never touch the real sites; `npm run doctor` and `npm run test:live` do, at your own risk and only when you ask
for it.

Changing the Node version means bumping it in `mise.toml`, `package.json` (`engines`, `@types/node`) and refreshing
`mise.lock` with `mise lock`.

## Git hooks

[hk](https://hk.jdx.dev) runs the linters that are already in the toolchain, on the files a commit touches:

```sh
mise x -- hk install --global --mise   # once per machine, Git 2.54+; no-op in repos without hk.pkl
mise x -- hk check                     # check the files you are about to commit
mise x -- hk check --all               # check the whole repository
mise x -- hk fix                       # apply the fixes without staging them
mise x -- hk run pre-commit --plan     # show what the pre-commit hook would do
```

`pre-commit` runs every step of [hk.pkl](hk.pkl) — `biome`, `tsc`, the `hk util` hygiene checks (merge-conflict
markers, private keys, trailing whitespace, final newline, line endings, large files, case conflicts, submodules,
smart quotes), the markdown linter (`rumdl`), `mise fmt`, and the GitHub Actions checks (`jactionlint`, `pinact`,
`zizmor`) — applies their fixes and stages the result; anything you left unstaged is stashed and restored. It refuses
to commit on `main`.

A second hook, `commit-msg`, enforces [Conventional Commits](https://www.conventionalcommits.org/) on the message.
`HK=0 git commit …` skips both, and `hk install` without `--global` installs them for this repository only.

`test/fixtures/**` is excluded from the text checks: those pages are captured from the sites, and their bytes are what
the parsers are tested against (`npm run fixtures`).

CI runs the same linters and hygiene checks with `hk check --all`. The branch guard (`no_commit_to_branch`) is declared
only in the `pre-commit` hook: it is a commit-time guard, not a property of the code, so it refuses a commit on `main`
but does not block a full check or a CI run.

The linters come from `node_modules`, not from mise: run `npm ci` first. hk itself is pinned in `mise.toml`, and its
Pkl imports in `hk.pkl` must carry the **same version** — bumping `hk` does not rewrite those URLs, so change both by
hand. hk has no macOS Intel build, so on an Intel Mac install just the runtime with `mise install node`.

## GitHub Actions

Workflows are linted with [jactionlint](https://github.com/jdx/jactionlint) (actionlint, plus the shellcheck pass on
`run:` blocks), audited with [zizmor](https://docs.zizmor.sh), and every `uses:` is **pinned to a full commit SHA**
with the readable version in a comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A tag can be moved; a SHA cannot. Dependabot keeps proposing the bumps (it rewrites both the SHA and the comment), and
`hk fix` re-pins anything that slipped through. Changing the version by hand is still possible: put the new SHA and its
comment, then run `hk check`.

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
- Biome is stricter than its default preset: type-aware rules (`domains.types`), `noFloatingPromises`, `noMisusedPromises`,
  `noUndeclaredDependencies`, `useTopLevelRegex`, and object keys sorted (`assist.source.useSortedKeys`). A new rule is
  either green or not enabled.
- Four lint choices are deliberate and should not be "fixed" without discussing them:
  - `useTopLevelRegex` is off under `test/**`: hoisting a regex out of an assertion only hurts readability.
  - `useAwait` is not enabled: the `GroceryStore` port is asynchronous, so `async` methods without I/O are normal
    (the in-memory store, the fakes). `noFloatingPromises` covers the mistake that actually matters.
  - `noSecrets` is not enabled: it flags domain strings and fixtures. GitHub secret scanning and push protection,
    plus the `detect_private_key` hook, play that role.
  - `useLiteralKeys` stays off: `noPropertyAccessFromIndexSignature` makes `record["key"]` mandatory for index signatures.

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
