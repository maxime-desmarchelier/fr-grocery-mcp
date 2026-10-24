// Read-only health check of each configured retailer, against the real sites.
// Usage: npm run doctor   (debugging Chrome logged in to the sites, FR_GROCERY_CONFIG for Leclerc)
// Checks the session, the active store, the next slot, a search and a product page:
// run it weekly, or as soon as a tool fails, to find out which site changed.

import { listStores } from "../src/application/store-overview.ts";
import { buildRegistry } from "../src/composition.ts";
import { loadConfig } from "../src/config.ts";
import { CdpBrowser } from "../src/infrastructure/browser/cdp-browser.ts";

const config = loadConfig();
const browser = new CdpBrowser({ port: config.chromePort, timeoutMs: config.timeoutMs });
const registry = buildRegistry(config, (origin, home) => browser.tab(origin, home));
let failures = 0;

const step = async (label: string, fn: () => Promise<string>) => {
  try {
    console.error(`  ✓ ${label}: ${await fn()}`);
  } catch (error) {
    failures++;
    console.error(`  ✗ ${label}: ${error instanceof Error ? `${error.name} — ${error.message}` : String(error)}`);
  }
};

try {
  for (const status of await listStores(registry, true)) {
    const { service } = registry.get(status.id);
    console.error(`${status.name} (${status.id})`);
    if (status.failure) {
      failures++;
      console.error(`  ✗ session: ${status.failure.error} — ${status.failure.message}`);
      continue;
    }
    const next = status.conditions?.nextSlots.find((s) => s.slot)?.slot;
    console.error(`  ✓ session: ${status.conditions?.store ?? "unknown store"}, next slot ${next?.start ?? "?"}`);
    await step("search", async () => {
      const { products, total } = await service.search("spaghetti", 5);
      if (products.length === 0) throw new Error("no product");
      return `${total} products, ${products.filter((p) => p.price !== null).length}/${products.length} with a price`;
    });
    await step("product page", async () => {
      const [first] = (await service.search("spaghetti", 1)).products;
      if (!first) throw new Error("no product");
      const details = await service.getProduct(first.id);
      if (!details.ingredients) throw new Error(`no ingredients for ${first.id}`);
      return details.name;
    });
    await step("cart", async () => {
      const cart = await service.getCart();
      return `${cart.lines.length} lines, total ${cart.total === null ? "?" : (cart.total / 100).toFixed(2)} €`;
    });
  }
} finally {
  browser.close();
}
process.exitCode = failures === 0 ? 0 : 1;
