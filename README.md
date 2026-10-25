# fr-grocery-mcp

An [MCP](https://modelcontextprotocol.io) server that gives an agent **domain-level** access to the online grocery
services ("drive") of French retailers: **E.Leclerc Drive** and **Super U** (coursesu.com) today, others through a
new adapter. Search products, read their composition, manage the cart, read slots and minimum order amounts,
compare carts. Nothing else.

The reasoning (recipes, ingredients, quantities for N people, product choice, price/promotion trade-offs) belongs
to the agent. For example:

> Order what I need to cook spaghetti bolognese and a four-cheese pizza for 4, at the cheapest of Leclerc and Super U.

The agent builds the list, searches each ingredient at each retailer, fills the carts, then compares them.
**The order is never placed**: slot booking and payment are left to the user, on the site.

> [!WARNING]
> This project is not affiliated with, endorsed by or supported by E.Leclerc, Système U or any retailer. It drives
> **your own logged-in browser session**, at a human pace, for personal use. Retailer sites change without notice
> and their terms of use apply: use it at your own risk.

## Tools

Every retailer tool takes `store` (`leclerc`, `superu`: an enum generated from the configuration).

| Tool                                         | Effect                                                                                                                                                        | Annotations             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| `list_stores(check=false)`                   | plugged-in retailers and capabilities; with `check`, status of each session and active store                                                                  | read-only               |
| `search_products(store, query, limit=20)`    | products: `id`, label, `price_eur`, `unit_price` (€/kg, €/l, €/piece), `available`, typed `promotions`, `best_offer` (net cost, bundles and loyalty included) | read-only               |
| `get_product(store, product_id)`             | product page: `ingredients` (allergens in capitals; `null` for a raw product), declared `allergens`, `origin`                                                 | read-only               |
| `get_cart(store)`                            | lines (`product_id`, `name`, `quantity`, `line_total_eur`, `unit_price`) and `total_eur`                                                                      | read-only               |
| `get_order_conditions(store?)`               | store, booked slot, slot attached to the cart, **dated** next slots (ISO `start`), minimums; `store` omitted = every retailer                                 | read-only               |
| `add_to_cart(store, product_id, quantity=1)` | adds to the quantity already present                                                                                                                          |                         |
| `set_quantity(store, product_id, quantity)`  | sets the quantity (0 = removal)                                                                                                                               | idempotent              |
| `remove_from_cart(store, product_id)`        | removes the product                                                                                                                                           | destructive, idempotent |
| `find_stores(store, query)`                  | stores around a postcode or town (if the retailer supports it)                                                                                                | read-only               |
| `set_store(store, store_id)`                 | selects and remembers the active store                                                                                                                        | idempotent              |
| `compare_carts(mode="drive")`                | each retailer's cart: total, lines, minimum and missing amount, next slots; sorted from cheapest to most expensive                                            | read-only               |

Every change reads the cart back and returns `confirmed`: true if the site holds the targeted quantity.
Results are typed (`outputSchema` + `structuredContent`) and the server sends `instructions` describing the flow to
the agent. A cap of 50 units per product guards against unit mistakes.

Errors (`isError`, `error` field): `ValidationError` (fix the call), `NotSupportedError` (the retailer does not
support it), `SessionExpiredError` (log in again in Chrome), `SiteBlockedError` (anti-bot: stop),
`TransientError` (retried automatically, then reported).

Product labels, promotion texts and search terms stay in French, as on the sites.

### Capabilities per retailer

| Capability                     | E.Leclerc Drive                   | Super U                            |
| ------------------------------ | --------------------------------- | ---------------------------------- |
| Search, cart, promotions       | yes (immediate, multibuy, Ticket) | yes (immediate, multibuy, Carte U) |
| Product page                   | ingredients, allergens, origin    | ingredients, origin                |
| Store selection from the agent | `find_stores` / `set_store`       | no: on the site                    |
| Minimum order                  | not exposed when logged out       | yes                                |
| Slots                          | next slot, cart date              | next slots, booked slot            |

## Requirements

- Node ≥ 26 (runs TypeScript natively: no build step). With [mise](https://mise.jdx.dev): `mise install --locked`
  installs the version recorded in `mise.lock`.
- A Chrome started with `--remote-debugging-port=9222` and logged in to the sites (`mise run chrome` starts a
  dedicated profile in `~/.fr-grocery-mcp/chrome`). One tab per site is found, or opened, by its domain.

Requests go through the browser session, one at a time and spaced out: the server replays what the site does on a
click (see [docs/retailers/](docs/retailers/)). No protection is bypassed: an anti-bot block stops the server, it
is never retried.

### Configuration

`FR_GROCERY_CONFIG` points to a JSON file. Without a file, only Super U is plugged in.

```json
{
  "chrome": { "port": 9222, "timeoutMs": 30000 },
  "stores": [
    {
      "retailer": "leclerc",
      "store": {
        "storeId": "123456",
        "retrievalPointId": "123456",
        "host": "fd7-courses.leclercdrive.fr",
        "name": "My Leclerc Drive"
      }
    },
    { "retailer": "superu", "minIntervalMs": 300 }
  ]
}
```

The order of the retailers is the order of preference. `minIntervalMs` sets the spacing between requests (default:
1000 ms for Leclerc, 300 ms for Super U). Your Leclerc store's values can be found with `find_stores` /
`set_store`: the store picked with `set_store` is remembered in `$FR_GROCERY_STATE_DIR/leclerc-store.json`
(default `~/.fr-grocery-mcp`) and takes precedence over the configuration. `FR_GROCERY_CHROME_PORT` overrides the port of
the file. The Super U store is chosen on coursesu.com.

## Usage

Claude Code (`.mcp.json`):

```json
{
  "mcpServers": {
    "fr-grocery-mcp": {
      "command": "node",
      "args": ["/path/to/fr-grocery-mcp/src/main.ts"],
      "env": { "FR_GROCERY_CONFIG": "/path/to/fr-grocery-mcp.json" }
    }
  }
}
```

Manual inspection: `npm run inspect` (MCP Inspector).

## Development

```sh
npm ci
npm run check                      # typecheck + lint + tests with coverage thresholds (what CI runs)
npm test                           # unit, adapter contract, integration (no access to the sites)
npm run doctor                     # real sites, read-only: session, search, product page, cart per retailer
npm run test:live                  # real sites: changes then removes an item that is not in the cart
LIVE_STORES=leclerc npm run test:live
npm run fixtures -- leclerc        # captures a retailer's reference pages again
npm run format                     # Biome
```

Architecture and technical choices: [docs/architecture.md](docs/architecture.md).
Adding a retailer: [docs/adding-a-retailer.md](docs/adding-a-retailer.md).

## Contributing

Issues and pull requests are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md) for the setup, the code rules and what
`npm run check` must show before a pull request. `main` is protected and CI must be green.

## Security

Please report vulnerabilities privately through the repository's Security tab, never in a public issue: see
[SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). The E.Leclerc Drive adapter builds on knowledge from
[mcp-leclerc-drive](https://github.com/skunkobi/mcp-leclerc-drive) (MIT): see [NOTICE](NOTICE).
