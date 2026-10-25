# Adding a retailer (Carrefour, Intermarché, Auchan…)

A retailer = a `src/infrastructure/retailers/<id>/` folder, a configuration entry, fixtures and a
`docs/retailers/<id>.md` page. The domain, the service, the MCP tools and the comparison do not change.

## 1. Assess the site (before writing code)

With the browser's developer tools, logged in to your account, write down in `docs/retailers/<id>.md`:

- **Protection**: anti-bot (DataDome, Akamai, captcha…) and behaviour at a human pace. A site that requires
  solving a captcha for each call is not plugged in: nothing is bypassed.
- **Rendering**: server HTML (selectors, like Super U), embedded JSON (widgets, like Leclerc), or a JSON API called
  by the page (the simplest and most stable).
- **Store**: how it is chosen (cookie, URL, API call); is there a store locator.
- **Cart**: does the change call set a quantity or add to it? CSRF token? Reading the cart.
- **Product page**: ingredients, allergens, origin.
- **Conditions**: next slot, booked slot, minimum order, readable without placing anything.
- The calls that **book, place or pay**: list them so they are never called.

## 2. Capture the reference pages

Add a `<id>()` function to `scripts/capture-fixtures.ts` (origin, home page, pages to capture and reduction), then
run `npm run fixtures -- <id>`. Reduce to what the parsers read; no session token. Use a test cart: cart pages
reflect your actual cart.

## 3. Write the (pure) parsers and their tests

`src/infrastructure/retailers/<id>/parsers.ts`: HTML/JSON in, domain objects out.

- Amounts as `Money` (`fromEurosAndCents`, `fromDecimalEuros`), price per kg as `UnitPrice`.
- Promotions: `kind` + `parseMechanic(text)` (extend its patterns, with a test, if the retailer has others).
- Slots: `parseSlotLabel(label, today)`.
- JSON data validated by a zod schema; unexpected format → `TransientError` ("the site may have changed").
- Blocking states: anti-bot → `SiteBlockedError`, session → `SessionExpiredError`, unknown → `ValidationError`.

## 4. Write the adapter

`<id>-store.ts` implements `GroceryStore` with a `PageHttp` (or a `PageHttpFactory` for several origins):

- Honest `capabilities`; what is missing throws `NotSupportedError`.
- `setQuantity` **sets** a quantity (idempotent); check the retailer's identifier format.
- No method books, places or pays.

## 5. Plug it in

- `src/config.ts`: a variant in `storeSchema` (`retailer: "<id>"`, its parameters, `minIntervalMs`).
- `src/composition.ts`: a `case` in `storeFor`.
- `test/support/fake-sites.ts`: a simulated site; `test/contract/grocery-store.contract.test.ts`: a subject.
- README (capability table), CHANGELOG.

## 6. Validate

```sh
npm run check                         # contract included
FR_GROCERY_CONFIG=… npm run doctor       # real site, read-only
LIVE_STORES=<id> npm run test:live    # real cart, left intact
```
