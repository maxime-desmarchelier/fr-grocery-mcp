# Releasing

Releases use [release-please](https://github.com/googleapis/release-please), Conventional Commits and SemVer. npm is
the distribution artifact, GitHub Releases holds the notes and the official MCP Registry points to the same npm
version. There is no Docker image. Development runs TypeScript natively; `prepack` compiles `src/` to JavaScript in
`dist/` because Node does not support native TypeScript under `node_modules`.

## One-time setup

### GitHub

The `Release` workflow needs a `RELEASE_PLEASE_TOKEN` secret so that CI runs on release PRs despite `main` being
protected. Create a fine-grained personal access token restricted to this repository with **Contents: read and write**
and **Pull requests: read and write**, then add it under **Settings → Secrets and variables → Actions**. Also allow
GitHub Actions to create pull requests under **Settings → Actions → General**.

The token is only used to create release PRs, tags and GitHub releases. npm and the MCP Registry use OIDC, not stored
registry tokens.

### npm trusted publishing

npm requires a package to exist before a trusted publisher can be configured. The first release therefore has one
manual step:

1. Let release-please open the first release PR, then check out its branch.
2. Run `npm ci`, `npm run check`, `npm pack --dry-run` and `npm publish --access public`. Complete the npm 2FA prompt.
3. On npm, open the package settings and add a **GitHub Actions trusted publisher** with user
   `maxime-desmarchelier`, repository `fr-grocery-mcp`, workflow filename `release.yml`, no environment and the
   **npm publish** permission. Do this only when another release can be published within two days; an unvalidated
   trusted-publisher configuration expires after that delay.
4. Merge the release PR. The workflow detects that this exact npm version already exists, does not republish it, then
   publishes the MCP Registry metadata with GitHub OIDC.

Later releases use trusted publishing automatically, with npm provenance. The historical `v0.1.0` tag predates the npm
and MCP Registry metadata: do not publish that tag. The first npm release is the first release PR created after this
setup instead.

The MCP Registry uses the `io.github.maxime-desmarchelier` namespace through GitHub OIDC. No additional registry secret
is needed.

## Normal release flow

1. Merge work to `main` through normal PRs. Use `feat:` for a user-facing feature, `fix:` for a correction and `!` or
   `BREAKING CHANGE:` for an incompatible MCP contract change. Documentation, tests and chores do not create releases.
2. release-please opens or updates a release PR with the next version, `CHANGELOG.md`, `package.json`,
   `package-lock.json`, `.release-please-manifest.json` and both versions in `server.json`.
3. Review the version and polish the notes in the release PR if needed. Notes should describe effects for MCP users,
   not internal implementation details. If more work merges, review the regenerated notes again before releasing.
4. Merge the release PR. release-please creates `vX.Y.Z` and the GitHub Release; the same workflow then runs all checks,
   installs and smoke tests the actual npm tarball with a real MCP client, publishes npm and publishes `server.json`.
5. Check the npm package, GitHub Release and MCP Registry entry if any publication step reports a failure.

The workflow never runs the live tests or `doctor`: retailer availability must not block an unrelated release.

## SemVer policy

SemVer applies to the public MCP tools, their input/output schemas and the installation/runtime requirements:

- **PATCH**: parser and retailer corrections, bug fixes and compatible behavior corrections;
- **MINOR**: a retailer, tool or optional output field added compatibly;
- **MAJOR**: removing or renaming a tool or field, incompatible schema changes, or another incompatible public contract
  change. Before `1.0.0`, breaking changes bump MINOR and must be called out prominently in the notes;
- no release for documentation, tests, refactoring without user impact, CI or repository tooling alone.

`1.0.0` means that the tool schemas, cart behavior and installation are considered stable; it is not tied to a number of
supported retailers.

## Retrying a publication

To retry publication for a release whose tag already exists, run the **Release** workflow manually with `tag` set to
`vX.Y.Z`. The tag and all version files must match. The workflow runs checks again, skips npm if that exact version is
already present and retries the MCP Registry publication. Do not move a release tag or reuse an npm version for
different content.

For a failed release-please run, fix the underlying issue and rerun the workflow without a tag. For an incorrect
release PR, close it and remove its `autorelease: pending` label before rerunning release-please.
