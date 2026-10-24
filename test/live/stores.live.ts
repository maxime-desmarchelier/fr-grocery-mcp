// Tests against the REAL sites, outside `npm test`. Run with: npm run test:live
// Prerequisites: Chrome started with --remote-debugging-port, logged in to the sites; FR_GROCERY_CONFIG for Leclerc.
// LIVE_STORES=leclerc limits to the listed retailers. The cart test picks a cheap item NOT in the cart,
// changes it then removes it: the user's cart is left as it was.

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { buildRegistry } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { parseQuantity } from "../../src/domain/cart.ts";
import { CdpBrowser } from "../../src/infrastructure/browser/cdp-browser.ts";

const config = loadConfig();
const browser = new CdpBrowser({ port: config.chromePort, timeoutMs: config.timeoutMs });
const registry = buildRegistry(config, (origin, home) => browser.tab(origin, home));
const only = process.env["LIVE_STORES"]?.split(",");
after(() => browser.close());

for (const { id, name, service } of registry.all().filter((s) => !only || only.includes(s.id))) {
  describe(`${name} (live)`, { timeout: 180_000 }, () => {
    it("search: complete products, promotions read", async () => {
      const { products, total } = await service.search("chocolat", 60);
      assert.ok(total >= products.length && products.length > 18);
      for (const p of products) assert.ok(p.id.length > 0 && p.name.length > 0);
      assert.ok(
        products.some((p) => p.promotions.length > 0),
        "at least one chocolate on promotion",
      );
    });

    it("product page: ingredients of a processed product", async () => {
      const { products } = await service.search("spaghetti", 1);
      const details = await service.getProduct(products[0]?.id ?? assert.fail("no product"));
      assert.match(details.ingredients ?? "", /blé/i);
    });

    it("conditions: store and structured next slot", async () => {
      const conditions = await service.getOrderConditions();
      assert.ok(conditions.store);
      assert.ok(
        conditions.nextSlots.some((s) => s.slot?.start),
        "at least one dated slot",
      );
    });

    it("cart: cumulative addition, set quantity, removal, initial cart intact", async () => {
      const before = await service.getCart();
      const { products } = await service.search("sel fin", 30);
      const target = products.find(
        (p) => p.available && p.price !== null && !before.lines.some((l) => l.productId === p.id),
      );
      assert.ok(target, `${id}: a product available and not in the cart`);
      try {
        await service.add(target.id, parseQuantity(1));
        const added = await service.add(target.id, parseQuantity(1));
        assert.equal(added.confirmed, true);
        assert.equal(added.line?.quantity, 2, "ajout cumulatif");
        const set = await service.setQuantity(target.id, parseQuantity(1));
        assert.equal(set.line?.quantity, 1, "quantity set");
      } finally {
        assert.equal((await service.remove(target.id)).line, null, "product removed");
      }
      const afterCart = await service.getCart();
      assert.deepEqual(
        afterCart.lines.map((l) => [l.productId, l.quantity]),
        before.lines.map((l) => [l.productId, l.quantity]),
      );
    });
  });
}
