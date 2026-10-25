# Security policy

## Supported versions

| Version | Supported |
| ------- | --------- |
| 0.1.x   | yes       |

Only the latest release on `main` receives fixes.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private vulnerability reporting:

1. Go to the [Security tab](https://github.com/maxime-desmarchelier/fr-grocery-mcp/security/advisories/new) of the
   repository.
2. Click **Report a vulnerability** and describe the problem.

You can expect an acknowledgement within 7 days and a first assessment within 30 days. Once a fix is available, the
advisory is published with credit to the reporter, unless you prefer to stay anonymous.

## Scope

This server drives the user's own logged-in browser session; it stores no credentials and holds no account of its
own. Reports are most useful when they concern:

- personal data leaking into logs, error messages, fixtures or the state directory;
- a way for retailer-provided content (product pages, cart payloads, configuration) to escape parsing and reach the
  agent or the filesystem;
- a request pattern that could get a user's account flagged, or a protection bypass the code allows.

Out of scope by design, and therefore not treated as vulnerabilities:

- the absence of any order placement, slot booking or payment: no tool performs them;
- the absence of captcha solving or anti-bot bypass: a `SiteBlockedError` stops the server on purpose;
- anything requiring the retailer's own credentials: they never leave the browser.

## Good practice for users

- Keep the dedicated Chrome profile used by the server logged in to the retailer sites only.
- The state directory (`~/.fr-grocery-mcp`) contains the selected store, not credentials: do not share it anyway.
- Update with `git pull` and rerun `npm ci` after a security fix.
