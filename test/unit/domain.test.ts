import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type Cart, findLine, parseQuantity, quantityAfterAdding, quantityOf } from "../../src/domain/cart.ts";
import {
  NotSupportedError,
  SessionExpiredError,
  ShopError,
  SiteBlockedError,
  TransientError,
  ValidationError,
} from "../../src/domain/errors.ts";
import {
  fromCents,
  fromDecimalEuros,
  fromEurosAndCents,
  multiply,
  percentOf,
  subtract,
  sum,
  toEuros,
} from "../../src/domain/money.ts";
import { minimumFor } from "../../src/domain/order-conditions.ts";
import { parseProductId } from "../../src/domain/product.ts";

describe("Money", () => {
  it("computes in integer cents, without floating-point errors", () => {
    assert.equal(toEuros(sum([fromCents(10), fromCents(20)])), 0.3);
    assert.equal(toEuros(fromEurosAndCents(1, 84)), 1.84);
    assert.equal(multiply(fromCents(95), 3), 285);
  });

  it("rejects negative or fractional amounts", () => {
    assert.throws(() => fromCents(-1), RangeError);
    assert.throws(() => fromCents(1.5), RangeError);
    assert.throws(() => fromDecimalEuros(Number.NaN), RangeError);
  });

  it("converts a site decimal, computes a percentage and a floored difference", () => {
    assert.equal(fromDecimalEuros(0.93), 93);
    assert.equal(fromDecimalEuros(6.43), 643);
    assert.equal(percentOf(fromCents(467), 40), 187);
    assert.equal(subtract(fromCents(100), fromCents(30)), 70);
    assert.equal(subtract(fromCents(100), fromCents(300)), 0);
  });
});

describe("ProductId", () => {
  it("accepts a retailer identifier, spaces trimmed", () => {
    assert.equal(parseProductId(" 960853 "), "960853");
    assert.equal(parseProductId("SKU-12.a_b"), "SKU-12.a_b");
  });

  for (const bad of ["", "../panier", "a b", "-12", "1".repeat(65)]) {
    it(`rejects "${bad}"`, () => assert.throws(() => parseProductId(bad), ValidationError));
  }
});

describe("Quantity", () => {
  it("accepts non-negative integers", () => {
    assert.equal(parseQuantity(0), 0);
    assert.equal(parseQuantity(60), 60);
  });

  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    it(`rejects ${bad}`, () => assert.throws(() => parseQuantity(bad), ValidationError));
  }
});

describe("Cart", () => {
  const id = parseProductId("960853");
  const cart: Cart = {
    lines: [
      { lineTotal: fromCents(190), name: "Spaghetti", productId: id, quantity: parseQuantity(2), unitPrice: null },
    ],
    total: fromCents(190),
  };

  it("finds a line and its quantity", () => {
    assert.equal(findLine(cart, id)?.name, "Spaghetti");
    assert.equal(quantityOf(cart, id), 2);
  });

  it("is 0 for an absent product", () => {
    const other = parseProductId("1");
    assert.equal(findLine(cart, other), null);
    assert.equal(quantityOf(cart, other), 0);
  });

  it("computes the target quantity after an addition", () => {
    assert.equal(quantityAfterAdding(cart, id, parseQuantity(3)), 5);
  });
});

describe("Errors", () => {
  it("tell whether a retry makes sense", () => {
    assert.ok(new TransientError("x") instanceof ShopError);
    assert.equal(new TransientError("x").retryable, true);
    assert.equal(new ValidationError("x").retryable, false);
    assert.equal(new ValidationError("x").name, "ValidationError");
    assert.equal(new NotSupportedError("x").retryable, false);
  });

  it("name the retailer concerned", () => {
    assert.match(new SessionExpiredError("Super U").message, /^Super U session expired: log in again/);
    assert.match(new SiteBlockedError("E.Leclerc Drive").message, /^E\.Leclerc Drive blocked the requests/);
    assert.equal(new SiteBlockedError("X").retryable, false);
  });
});

describe("OrderConditions", () => {
  it("minimum order per mode, null if not exposed", () => {
    const base = { bookedSlot: null, cartSlot: null, nextSlots: [], store: null };
    const known = { ...base, minimumOrders: [{ amount: fromCents(5000), mode: "drive" as const }] };
    assert.equal(minimumFor(known, "drive"), 5000);
    assert.equal(minimumFor(known, "delivery"), null);
    assert.equal(minimumFor({ ...base, minimumOrders: null }, "drive"), null);
  });
});
