# Architecture

Hexagonal architecture: the domain depends on nothing, each layer depends only on the inner layers.
A single MCP server, one adapter per retailer.

```
interface/mcp  ──▶  application  ──▶  domain  ◀──  infrastructure
(MCP tools,         (service per      (model,       retailers/{superu,leclerc,memory}
 store param)        retailer,         port)        http/ (pace, retries)
                     registry,                      browser/ (Chrome CDP)
                     comparison)
                         ▲
composition.ts ──────────┘  from the configuration to the decorated retailers; main.ts plugs Chrome in
```

| Layer             | Content                                                                                                                                                                                                     | Rule                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| `domain/`         | `Money` (cents), `ProductId`, `Quantity`, `Product`, `Promotion` (quantified mechanics, net cost), `SlotTime` (dated slots), `Cart`, `OrderConditions`, `GroceryStore` port and `StoreCapabilities`, errors | pure: no I/O, no dependency |
| `application/`    | `ShoppingService` (one retailer: cumulative addition, confirmation by read-back), `StoreRegistry`, `listStores`, `compareCarts`                                                                             | knows only the port         |
| `infrastructure/` | `retailers/*` (adapters + pure parsers), `http/` (`PageHttp`, `ThrottledHttp`, `RetryingStore`), `browser/CdpBrowser`                                                                                       | implements the port         |
| `interface/mcp/`  | tools, input/output schemas, presentation in euros, error translation                                                                                                                                       | no business logic           |

Call chain: MCP tool → `ShoppingService` → `RetryingStore` → adapter → `ThrottledHttp` → Chrome tab.

## Decisions

**One server, N adapters, a constant set of tools.** The number of tools does not grow with the retailers (the
`store` parameter is an enum built from the configuration). A single process owns Chrome: one queue serializes
every request, and each retailer has its own tab, found by domain, so a retailer never navigates another's tab.

**Same capabilities, or an explicit absence.** Every adapter implements the whole port. What the site does not
support throws `NotSupportedError`, declared in `capabilities` (read by `list_stores`). The `test/contract/` suite
checks this contract on every adapter.

**The server exposes only domain primitives.** Recipes, quantities and product choices belong to the agent. The
server provides reliable facts: prices in cents, quantified promotions, net cost, dated slots, compared totals.
Lines of carts from different retailers are not matched: that is the agent's job.

**The cart has only three methods** (`search`, `getCart`, `setQuantity`), plus reads (`getProduct`,
`getOrderConditions`) and store selection. The sites can only _set_ a quantity: cumulative addition and removal
derive from it in the application. Since `setQuantity` is idempotent, a retry cannot double an addition.

**Every change is confirmed by reading the cart back.** A site may answer 200 without applying the request; the
agent gets `confirmed` instead of blind trust.

**Typed promotions.** `immediate` (already in the price), `multibuy` (depends on the quantity), `loyalty` (credit
on the card). The site's text is interpreted into a mechanic (`nth_percent_off`, `loyalty_percent`…) by a pure
function shared by the retailers; `bestOffer` gives the net cost per unit at the quantity that triggers the offer.
Unrecognized text keeps `mechanic: null`: the agent then reads `details`.

**Dated slots.** Labels ("Lundi 26 octobre à 07h00", "Dim. 25/10 de 08h30 à 09h00") are turned into
`YYYY-MM-DDTHH:MM`, the year inferred from today's date: the agent filters retailers by slot without parsing text.

**Amounts in integer cents, branded types** (`Money`, `ProductId`, `Quantity`). Conversion to euros happens only
on output. A site's decimal prices (Leclerc: `0.93`) are rounded to the cent on input.

**Page data parsed in Node.** The browser only runs `fetch` with the user's session; the parsers are pure
functions tested on real pages (`test/fixtures/<retailer>`, reduced and without session data). A site's JSON data
is validated by a zod schema: an unexpected format gives a `TransientError` "the site may have changed" rather than
a wrong result.

**No bypassing.** Human pace (`ThrottledHttp`, delay per retailer), an anti-bot block (`SiteBlockedError`) stops
instead of retrying, no tool books a slot or places an order.

**No dubious signal.** The `.notavailable` block of the Super U cart is present on every line (hidden with CSS):
it is not read. The Leclerc minimum is not exposed when logged out: `minimumOrders: null`, never 0.

**TypeScript run natively by Node 26** (type stripping): no build, `tsc` (TypeScript 7) only type-checks.
`erasableSyntaxOnly` forbids non-erasable syntax (enums, parameter properties).

## Tests

| Level       | Files                 | Against                                                                                                                      |
| ----------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| unit        | `test/unit/`          | domain (promotions, slots), service, registry, comparison, parsers (real fixtures), adapters (fake HTTP), decorators, config |
| contract    | `test/contract/`      | the same `GroceryStore` contract on the simulator and on every adapter (sites simulated by the fixtures)                     |
| integration | `test/integration/`   | real MCP client: simulated retailers, real adapters on simulated sites, stdio subprocess                                     |
| live        | `test/live/` (not CI) | real sites, the user's cart left intact; `npm run doctor` read-only                                                          |

CI requires 90% line and 85% branch coverage. Excluded from coverage: the Chrome connection
(`infrastructure/browser`, covered by the live tests and the doctor) and `main.ts` (covered by the stdio test).
