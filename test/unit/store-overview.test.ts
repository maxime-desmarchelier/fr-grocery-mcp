import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ShoppingService } from "../../src/application/shopping-service.ts";
import { compareCarts, listStores } from "../../src/application/store-overview.ts";
import { StoreRegistry } from "../../src/application/store-registry.ts";
import { parseQuantity } from "../../src/domain/cart.ts";
import { ValidationError } from "../../src/domain/errors.ts";
import { fromCents } from "../../src/domain/money.ts";
import type { OrderConditions } from "../../src/domain/order-conditions.ts";
import { InMemoryStore } from "../../src/infrastructure/retailers/memory/in-memory-store.ts";
import { BOEUF, CATALOGUE, SPAGHETTI } from "../support/catalogue.ts";

const conditions = (minimum: number | null): OrderConditions => ({
  bookedSlot: null,
  cartSlot: null,
  minimumOrders: minimum === null ? null : [{ amount: fromCents(minimum), mode: "drive" }],
  nextSlots: [
    {
      available: true,
      full: false,
      mode: "drive",
      slot: { end: null, label: "Lundi 26 octobre à 07h00", start: "2026-10-26T07:00" },
    },
  ],
  store: "store",
});

function registry(...stores: { id: string; store: InMemoryStore }[]) {
  return new StoreRegistry(
    stores.map(({ id, store }) => ({
      id,
      name: id.toUpperCase(),
      service: new ShoppingService(store, { sleep: async () => {} }),
    })),
  );
}

describe("StoreRegistry", () => {
  it("keeps the configuration order and finds a retailer", () => {
    const r = registry({ id: "leclerc", store: new InMemoryStore([]) }, { id: "superu", store: new InMemoryStore([]) });
    assert.deepEqual(r.ids, ["leclerc", "superu"]);
    assert.equal(r.get("superu").name, "SUPERU");
    assert.throws(() => r.get("carrefour"), /Unknown retailer: "carrefour"\. Retailers: leclerc, superu\./);
  });

  it("rejects an empty list, a duplicate or an invalid identifier", () => {
    assert.throws(() => new StoreRegistry([]), ValidationError);
    const store = new InMemoryStore([]);
    assert.throws(() => registry({ id: "superu", store }, { id: "superu", store }), /Duplicate retailer/);
    assert.throws(() => registry({ id: "Super U", store }), /Invalid/);
  });
});

describe("listStores", () => {
  it("capabilities only, or session status checked retailer by retailer", async () => {
    const expired = new InMemoryStore(CATALOGUE);
    expired.expired = true;
    const r = registry(
      { id: "leclerc", store: new InMemoryStore(CATALOGUE, { conditions: conditions(null) }) },
      { id: "superu", store: expired },
    );

    const quick = await listStores(r, false);
    assert.deepEqual(
      quick.map((s) => [s.id, s.conditions, s.failure]),
      [
        ["leclerc", null, null],
        ["superu", null, null],
      ],
    );

    const [leclerc, superu] = await listStores(r, true);
    assert.equal(leclerc?.conditions?.store, "store");
    assert.equal(leclerc?.capabilities.minimumOrder, false);
    assert.equal(superu?.conditions, null);
    assert.equal(superu?.failure?.error, "SessionExpiredError");
  });
});

describe("compareCarts", () => {
  it("ranks carts by total, computes the gap to the minimum, isolates failures", async () => {
    const cheap = new InMemoryStore(CATALOGUE, { conditions: conditions(5000) });
    const dear = new InMemoryStore(CATALOGUE, { conditions: conditions(null) });
    const broken = new InMemoryStore(CATALOGUE);
    broken.expired = true;
    await cheap.setQuantity(SPAGHETTI.id, parseQuantity(2));
    await dear.setQuantity(BOEUF.id, parseQuantity(1));
    const r = registry({ id: "dear", store: dear }, { id: "broken", store: broken }, { id: "cheap", store: cheap });

    const comparison = await compareCarts(r, "drive");
    assert.equal(comparison.cheapest, "cheap");
    assert.deepEqual(
      comparison.stores.map((s) => [
        s.id,
        s.cart?.total ?? null,
        s.minimumOrder,
        s.missingToMinimum,
        s.failure?.error ?? null,
      ]),
      [
        ["cheap", 190, 5000, 4810],
        ["dear", 899, null, null],
        ["broken", null, null, null],
      ].map((row) => [...row, row[0] === "broken" ? "SessionExpiredError" : null]),
    );
  });

  it("empty cart: never chosen as the cheapest; failed conditions without losing the cart", async () => {
    const empty = new InMemoryStore(CATALOGUE);
    const full = new InMemoryStore(CATALOGUE);
    await full.setQuantity(BOEUF.id, parseQuantity(1));
    const r = registry({ id: "empty", store: empty }, { id: "full", store: full });
    assert.equal((await compareCarts(r, "delivery")).cheapest, "full");

    const flaky = new InMemoryStore(CATALOGUE);
    await flaky.setQuantity(BOEUF.id, parseQuantity(1));
    const service = new ShoppingService(flaky);
    const original = service.getOrderConditions.bind(service);
    service.getOrderConditions = () => Promise.reject(new Error("panne"));
    const [summary] = (await compareCarts(new StoreRegistry([{ id: "flaky", name: "F", service }]), "drive")).stores;
    assert.equal(summary?.cart?.total, 899);
    assert.equal(summary?.failure?.error, "InternalError");
    assert.equal((await original()).store, null);
  });
});
