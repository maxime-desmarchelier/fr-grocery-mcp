import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_QUANTITY_PER_LINE, ShoppingService } from "../../src/application/shopping-service.ts";
import { type Cart, parseQuantity, type Quantity } from "../../src/domain/cart.ts";
import { NotSupportedError, SessionExpiredError, ValidationError } from "../../src/domain/errors.ts";
import type { GroceryStore } from "../../src/domain/grocery-store.ts";
import { fromCents } from "../../src/domain/money.ts";
import type { OrderConditions } from "../../src/domain/order-conditions.ts";
import { type ProductId, parseProductId } from "../../src/domain/product.ts";
import { InMemoryStore } from "../../src/infrastructure/retailers/memory/in-memory-store.ts";
import { BOEUF, CATALOGUE, SPAGHETTI } from "../support/catalogue.ts";

const noSleep = async () => {};

/** Store delegating to the simulator, except for the overridden methods. */
function delegate(inner: InMemoryStore, overrides: Partial<GroceryStore>): GroceryStore {
  return {
    capabilities: inner.capabilities,
    findStores: (query) => inner.findStores(query),
    getCart: () => inner.getCart(),
    getOrderConditions: () => inner.getOrderConditions(),
    getProduct: (id) => inner.getProduct(id),
    search: (query, limit) => inner.search(query, limit),
    selectStore: (id) => inner.selectStore(id),
    setQuantity: (id, quantity) => inner.setQuantity(id, quantity),
    ...overrides,
  };
}
const q = parseQuantity;

function setup() {
  const store = new InMemoryStore(CATALOGUE);
  return { service: new ShoppingService(store, { sleep: noSleep }), store };
}

describe("ShoppingService", () => {
  it("searches with a trimmed term", async () => {
    const { service } = setup();
    const result = await service.search("  spaghetti ");
    assert.equal(result.query, "spaghetti");
    assert.deepEqual(
      result.products.map((p) => p.id),
      [SPAGHETTI.id],
    );
  });

  it("rejects an empty or too long search, or an out-of-range limit", () => {
    const { service } = setup();
    assert.throws(() => service.search("   "), ValidationError);
    assert.throws(() => service.search("x".repeat(101)), ValidationError);
    assert.throws(() => service.search("pâtes", 0), ValidationError);
    assert.throws(() => service.search("pâtes", 101), ValidationError);
  });

  it("adds to the existing quantity, then confirms by reading back", async () => {
    const { service } = setup();
    await service.add(SPAGHETTI.id, q(2));
    const change = await service.add(SPAGHETTI.id, q(1));
    assert.equal(change.expectedQuantity, 3);
    assert.equal(change.line?.quantity, 3);
    assert.equal(change.confirmed, true);
    assert.equal(change.cartTotal, 285);
  });

  it("sets an absolute quantity and removes", async () => {
    const { service } = setup();
    await service.add(SPAGHETTI.id, q(4));
    assert.equal((await service.setQuantity(SPAGHETTI.id, q(1))).line?.quantity, 1);
    const removed = await service.remove(SPAGHETTI.id);
    assert.equal(removed.line, null);
    assert.equal(removed.confirmed, true);
  });

  it("rejects adding 0 and a quantity beyond the cap", async () => {
    const { service } = setup();
    await assert.rejects(service.add(BOEUF.id, q(0)), ValidationError);
    await assert.rejects(service.setQuantity(BOEUF.id, q(MAX_QUANTITY_PER_LINE + 1)), ValidationError);
    await service.setQuantity(BOEUF.id, q(MAX_QUANTITY_PER_LINE));
    await assert.rejects(service.add(BOEUF.id, q(1)), ValidationError, "the running total counts too");
  });

  it("reads the cart again until the site reflects the change", async () => {
    // Store that takes two reads to reflect a change.
    const inner = new InMemoryStore(CATALOGUE);
    let lag = 0;
    const store: GroceryStore = delegate(inner, {
      getCart: async (): Promise<Cart> => (lag-- > 0 ? { lines: [], total: null } : inner.getCart()),
      setQuantity: async (id: ProductId, quantity: Quantity) => {
        lag = 2;
        await inner.setQuantity(id, quantity);
      },
    });
    const sleeps: number[] = [];
    const service = new ShoppingService(store, { confirmDelayMs: 10, sleep: async (ms) => void sleeps.push(ms) });
    const change = await service.setQuantity(SPAGHETTI.id, q(2));
    assert.equal(change.confirmed, true);
    assert.deepEqual(sleeps, [10, 10]);
  });

  it("reports an unconfirmed change without throwing", async () => {
    const inner = new InMemoryStore(CATALOGUE);
    const store = delegate(inner, { setQuantity: async () => {} }); // the site ignores the request
    const change = await new ShoppingService(store, { sleep: noSleep }).setQuantity(SPAGHETTI.id, q(2));
    assert.equal(change.confirmed, false);
    assert.equal(change.line, null);
  });

  it("reads the store's order conditions", async () => {
    const conditions: OrderConditions = {
      bookedSlot: null,
      cartSlot: null,
      minimumOrders: [{ amount: fromCents(5000), mode: "drive" }],
      nextSlots: [],
      store: "super u ville test",
    };
    const service = new ShoppingService(new InMemoryStore(CATALOGUE, { conditions }), { sleep: noSleep });
    assert.deepEqual(await service.getOrderConditions(), conditions);
    assert.equal(service.capabilities.minimumOrder, true);
  });

  it("reads a catalogue product page, with its ingredients if the store knows them", async () => {
    const details = new Map([[SPAGHETTI.id, { ingredients: "Semoule de blé dur (GLUTEN).", origin: null }]]);
    const service = new ShoppingService(new InMemoryStore(CATALOGUE, { details }), { sleep: noSleep });
    assert.deepEqual(await service.getProduct(SPAGHETTI.id), {
      allergens: null,
      id: SPAGHETTI.id,
      ingredients: "Semoule de blé dur (GLUTEN).",
      name: SPAGHETTI.name,
      origin: null,
    });
    assert.equal((await service.getProduct(BOEUF.id)).ingredients, null);
    await assert.rejects(service.getProduct(parseProductId("42")), ValidationError);
  });

  it("propagates an expired session", async () => {
    const { store, service } = setup();
    store.expired = true;
    await assert.rejects(service.getCart(), SessionExpiredError);
  });

  it("store search and selection, inputs validated", async () => {
    const location = {
      distanceKm: 1,
      id: "123456",
      name: "Testville",
      postalCode: "00000",
      serviceType: "drive",
    } as const;
    const store = new InMemoryStore(CATALOGUE, { locations: [location] });
    const service = new ShoppingService(store, { sleep: noSleep });
    assert.deepEqual(await service.findStores(" 00000 "), [location]);
    assert.deepEqual(await service.selectStore("123456"), location);
    assert.equal(store.selected, location);
    assert.throws(() => service.findStores("9"), ValidationError);
    assert.throws(() => service.selectStore("../x"), ValidationError);
    await assert.rejects(service.selectStore("1"), ValidationError);
    await assert.rejects(setup().service.findStores("00000"), NotSupportedError);
  });
});
