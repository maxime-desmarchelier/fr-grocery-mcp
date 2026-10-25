// Shared contract of the GroceryStore port, run against EVERY adapter (sites simulated by the fixtures).
// A new retailer is plugged in only once it passes this contract: same capabilities, same errors.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuantity } from "../../src/domain/cart.ts";
import { NotSupportedError, ShopError, ValidationError } from "../../src/domain/errors.ts";
import type { GroceryStore } from "../../src/domain/grocery-store.ts";
import { fromCents } from "../../src/domain/money.ts";
import { parseProductId } from "../../src/domain/product.ts";
import { LeclercStore } from "../../src/infrastructure/retailers/leclerc/leclerc-store.ts";
import { MemorySelection } from "../../src/infrastructure/retailers/leclerc/selection.ts";
import { InMemoryStore } from "../../src/infrastructure/retailers/memory/in-memory-store.ts";
import { SuperUStore } from "../../src/infrastructure/retailers/superu/superu-store.ts";
import { CATALOGUE } from "../support/catalogue.ts";
import { FakeHttp } from "../support/fake-http.ts";
import { leclercSite, superuSite } from "../support/fake-sites.ts";

interface Subject {
  readonly name: string;
  readonly make: () => GroceryStore;
  /** A product whose page exists, and a well-formed but unknown identifier. */
  readonly knownProduct: string;
  readonly unknownProduct: string;
  readonly searchTerm: string;
}

const subjects: readonly Subject[] = [
  {
    knownProduct: "960853",
    make: () =>
      new InMemoryStore(CATALOGUE, {
        conditions: {
          bookedSlot: null,
          cartSlot: null,
          minimumOrders: [{ amount: fromCents(5000), mode: "drive" }],
          nextSlots: [],
          store: "simulated",
        },
        locations: [{ distanceKm: 0, id: "1", name: "Simulated", postalCode: "00000", serviceType: "drive" }],
      }),
    name: "simulateur",
    searchTerm: "spaghetti",
    unknownProduct: "123",
  },
  {
    knownProduct: "960853",
    make: () => new SuperUStore(new FakeHttp(superuSite)),
    name: "Super U",
    searchTerm: "spaghetti",
    unknownProduct: "1",
  },
  {
    knownProduct: "7459",
    make: () =>
      new LeclercStore({
        http: () => new FakeHttp(leclercSite),
        selection: new MemorySelection({
          host: "fd7-courses.leclercdrive.fr",
          retrievalPointId: "123456",
          storeId: "123456",
        }),
      }),
    name: "E.Leclerc Drive",
    searchTerm: "spaghetti",
    unknownProduct: "999999999",
  },
];

for (const subject of subjects) {
  describe(`contrat GroceryStore : ${subject.name}`, () => {
    it("search: honours the limit, complete products", async () => {
      const result = await subject.make().search(subject.searchTerm, 3);
      assert.equal(result.query, subject.searchTerm);
      assert.ok(result.products.length > 0 && result.products.length <= 3);
      assert.ok(result.total >= result.products.length);
      for (const p of result.products) {
        assert.equal(parseProductId(p.id), p.id);
        assert.ok(p.name.length > 0);
        assert.ok(p.price === null || p.price > 0);
        assert.ok(Array.isArray(p.promotions));
      }
    });

    it("product page: known, unknown, malformed identifier", async () => {
      const store = subject.make();
      const details = await store.getProduct(parseProductId(subject.knownProduct));
      assert.equal(details.id, subject.knownProduct);
      assert.ok(details.name.length > 0);
      await assert.rejects(store.getProduct(parseProductId(subject.unknownProduct)), ValidationError);
    });

    it("cart: lines with positive quantities, consistent total", async () => {
      const cart = await subject.make().getCart();
      for (const line of cart.lines) assert.ok(line.quantity > 0 && line.name.length > 0);
      assert.ok(cart.total === null || cart.total >= 0);
    });

    it("quantity: set then remove without error (idempotent)", async () => {
      const store = subject.make();
      const id = parseProductId(subject.knownProduct);
      await store.setQuantity(id, parseQuantity(2));
      await store.setQuantity(id, parseQuantity(2));
      await store.setQuantity(id, parseQuantity(0));
    });

    it("conditions: consistent with the declared capabilities", async () => {
      const store = subject.make();
      const conditions = await store.getOrderConditions();
      assert.equal(conditions.minimumOrders !== null, store.capabilities.minimumOrder);
      if (!store.capabilities.bookedSlot) assert.equal(conditions.bookedSlot, null);
      for (const next of conditions.nextSlots) assert.ok(next.mode === "drive" || next.mode === "delivery");
    });

    it("stores: NotSupportedError if unsupported, otherwise search then select", async () => {
      const store = subject.make();
      if (!store.capabilities.storeLocator) {
        await assert.rejects(store.findStores("00000"), NotSupportedError);
        await assert.rejects(store.selectStore("1"), NotSupportedError);
        return;
      }
      const [first] = await store.findStores("00000");
      assert.ok(first, "at least one store");
      assert.deepEqual(await store.selectStore(first.id), first);
      await assert.rejects(store.selectStore("000000"), ShopError);
    });
  });
}
