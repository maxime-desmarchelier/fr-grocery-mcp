// Domain -> data returned to the agent: amounts in euros, field names in snake_case.

import { z } from "zod";
import type { CartChange } from "../../application/shopping-service.ts";
import type { CartComparison, CartSummary, StoreFailure, StoreStatus } from "../../application/store-overview.ts";
import type { Cart, CartLine } from "../../domain/cart.ts";
import type { StoreLocation } from "../../domain/grocery-store.ts";
import { type Money, toEuros } from "../../domain/money.ts";
import type { NextSlot, OrderConditions } from "../../domain/order-conditions.ts";
import type { Product, ProductDetails, SearchResult, UnitPrice } from "../../domain/product.ts";
import { bestOffer, type Mechanic, type Promotion } from "../../domain/promotion.ts";
import type { SlotTime } from "../../domain/slot.ts";

const euros = (amount: Money | null): number | null => (amount === null ? null : toEuros(amount));

// ---- Schemas ------------------------------------------------------------------------------------

const unitPriceSchema = z.object({ eur: z.number(), per: z.enum(["kg", "l", "piece"]) }).nullable();

const mechanicSchema = z
  .object({
    type: z.enum(["percent_off", "nth_percent_off", "loyalty_percent", "loyalty_amount"]),
    nth: z.number().nullable().describe("rank of the discounted unit (2 = the 2nd)"),
    percent: z.number().nullable(),
    amount_eur: z.number().nullable().describe("amount credited per unit"),
  })
  .nullable()
  .describe("quantified mechanic; null if the text could not be interpreted (read details)");

const promotionSchema = z.object({
  kind: z
    .enum(["immediate", "multibuy", "loyalty"])
    .describe(
      "immediate: already deducted from the price; multibuy: depends on the quantity; loyalty: loyalty card credit",
    ),
  label: z.string(),
  valid_until: z.string().nullable().describe("JJ/MM"),
  details: z.array(z.string()),
  regular_price_eur: z.number().nullable(),
  mechanic: mechanicSchema,
});

export const productSchema = z.object({
  id: z.string(),
  name: z.string(),
  price_eur: z.number().nullable().describe("price of one unit at checkout, immediate discounts deducted"),
  unit_price: unitPriceSchema,
  available: z.boolean(),
  promotions: z.array(promotionSchema),
  best_offer: z
    .object({ quantity: z.number(), net_unit_price_eur: z.number() })
    .nullable()
    .describe("net cost per unit (bundles and loyalty credit included) at the quantity that triggers the offer"),
});

const storeInput = { store: z.string() };

export const searchOutput = {
  ...storeInput,
  query: z.string(),
  total: z.number().describe("products reported by the site, across all pages"),
  products: z.array(productSchema),
};

export const productDetailsOutput = {
  ...storeInput,
  id: z.string(),
  name: z.string(),
  ingredients: z
    .string()
    .nullable()
    .describe("ingredient list as displayed (allergens in capitals); null for a raw product"),
  allergens: z.string().nullable().describe("separate allergen statement, if the site provides it"),
  origin: z.string().nullable().describe("origin declared on the product page, if any"),
};

const cartLineSchema = z.object({
  product_id: z.string(),
  name: z.string(),
  quantity: z.number(),
  line_total_eur: z.number().nullable(),
  unit_price: unitPriceSchema,
});

export const cartOutput = {
  ...storeInput,
  lines: z.array(cartLineSchema),
  total_eur: z.number().nullable(),
};

export const cartChangeOutput = {
  ...storeInput,
  product_id: z.string(),
  expected_quantity: z.number(),
  confirmed: z.boolean().describe("true if the cart read back holds the targeted quantity"),
  line: cartLineSchema.nullable(),
  cart_total_eur: z.number().nullable(),
};

const slotSchema = z
  .object({
    label: z.string(),
    start: z.string().nullable().describe("AAAA-MM-JJTHH:MM, heure locale"),
    end: z.string().nullable(),
  })
  .nullable();

const nextSlotSchema = z.object({
  mode: z.enum(["drive", "delivery"]),
  slot: slotSchema,
  available: z.boolean(),
  full: z.boolean(),
});

const conditionsSchema = z.object({
  store: z.string().nullable().describe("selected store"),
  booked_slot: slotSchema.describe("slot firmly booked by the user"),
  cart_slot: slotSchema.describe("pickup date attached to the cart, not guaranteed as a booking"),
  next_slots: z.array(nextSlotSchema),
  minimum_orders: z
    .array(z.object({ mode: z.enum(["drive", "delivery"]), eur: z.number() }))
    .nullable()
    .describe("null: the site does not expose it, check at checkout"),
});

const failureSchema = z.object({ error: z.string(), message: z.string(), retryable: z.boolean() }).nullable();

export const orderConditionsOutput = {
  stores: z.array(
    z.object({ store: z.string(), name: z.string(), conditions: conditionsSchema.nullable(), failure: failureSchema }),
  ),
};

const capabilitiesSchema = z.object({
  product_details: z.boolean(),
  store_locator: z.boolean(),
  minimum_order: z.boolean(),
  booked_slot: z.boolean(),
});

export const listStoresOutput = {
  stores: z.array(
    z.object({
      store: z.string(),
      name: z.string(),
      capabilities: capabilitiesSchema,
      session_ok: z.boolean().nullable().describe("null if the session was not checked (check: false)"),
      current_store: z.string().nullable(),
      failure: failureSchema,
    }),
  ),
};

const locationSchema = z.object({
  id: z.string().describe("to pass to set_store"),
  name: z.string(),
  service_type: z.enum(["drive", "relay", "delivery", "other"]),
  distance_km: z.number().nullable(),
  postal_code: z.string().nullable(),
});

export const findStoresOutput = { ...storeInput, query: z.string(), locations: z.array(locationSchema) };
export const setStoreOutput = { ...storeInput, selected: locationSchema };

export const compareCartsOutput = {
  mode: z.enum(["drive", "delivery"]),
  cheapest: z.string().nullable().describe("retailer with the cheapest non-empty cart"),
  stores: z.array(
    z.object({
      store: z.string(),
      name: z.string(),
      total_eur: z.number().nullable(),
      line_count: z.number().nullable(),
      item_count: z.number().nullable(),
      minimum_order_eur: z.number().nullable(),
      missing_to_minimum_eur: z.number().nullable().describe("0 if the minimum is reached, null if unknown"),
      next_slots: z.array(nextSlotSchema),
      lines: z.array(cartLineSchema),
      failure: failureSchema,
    }),
  ),
};

// ---- Presentation -------------------------------------------------------------------------------

const unitPrice = (u: UnitPrice | null) => (u === null ? null : { eur: toEuros(u.price), per: u.per });

const mechanic = (m: Mechanic | null) => {
  if (m === null) return null;
  return {
    type: m.type,
    nth: m.type === "nth_percent_off" ? m.nth : null,
    percent: m.type === "loyalty_amount" ? null : m.percent,
    amount_eur: m.type === "loyalty_amount" ? toEuros(m.amount) : null,
  };
};

const promotion = (p: Promotion) => ({
  kind: p.kind,
  label: p.label,
  valid_until: p.validUntil,
  details: [...p.details],
  regular_price_eur: euros(p.regularPrice),
  mechanic: mechanic(p.mechanic),
});

const product = (p: Product) => {
  const offer = p.price !== null && p.promotions.length > 0 ? bestOffer(p.price, p.promotions) : null;
  return {
    id: p.id,
    name: p.name,
    price_eur: euros(p.price),
    unit_price: unitPrice(p.unitPrice),
    available: p.available,
    promotions: p.promotions.map(promotion),
    best_offer: offer && { quantity: offer.quantity, net_unit_price_eur: toEuros(offer.netUnitPrice) },
  };
};

const cartLine = (l: CartLine) => ({
  product_id: l.productId,
  name: l.name,
  quantity: l.quantity,
  line_total_eur: euros(l.lineTotal),
  unit_price: unitPrice(l.unitPrice),
});

const slot = (s: SlotTime | null) => (s === null ? null : { label: s.label, start: s.start, end: s.end });

const nextSlot = (s: NextSlot) => ({ mode: s.mode, slot: slot(s.slot), available: s.available, full: s.full });

const conditions = (c: OrderConditions) => ({
  store: c.store,
  booked_slot: slot(c.bookedSlot),
  cart_slot: slot(c.cartSlot),
  next_slots: c.nextSlots.map(nextSlot),
  minimum_orders: c.minimumOrders?.map((m) => ({ mode: m.mode, eur: toEuros(m.amount) })) ?? null,
});

const failure = (f: StoreFailure | null) => (f === null ? null : { ...f });

const location = (l: StoreLocation) => ({
  id: l.id,
  name: l.name,
  service_type: l.serviceType,
  distance_km: l.distanceKm,
  postal_code: l.postalCode,
});

export const presentSearch = (store: string, r: SearchResult) => ({
  store,
  query: r.query,
  total: r.total,
  products: r.products.map(product),
});

export const presentProductDetails = (store: string, p: ProductDetails) => ({
  store,
  id: p.id,
  name: p.name,
  ingredients: p.ingredients,
  allergens: p.allergens,
  origin: p.origin,
});

export const presentCart = (store: string, c: Cart) => ({
  store,
  lines: c.lines.map(cartLine),
  total_eur: euros(c.total),
});

export const presentChange = (store: string, c: CartChange) => ({
  store,
  product_id: c.productId,
  expected_quantity: c.expectedQuantity,
  confirmed: c.confirmed,
  line: c.line === null ? null : cartLine(c.line),
  cart_total_eur: euros(c.cartTotal),
});

export const presentOrderConditions = (statuses: readonly StoreStatus[]) => ({
  stores: statuses.map((s) => ({
    store: s.id,
    name: s.name,
    conditions: s.conditions && conditions(s.conditions),
    failure: failure(s.failure),
  })),
});

export const presentStores = (statuses: readonly StoreStatus[], checked: boolean) => ({
  stores: statuses.map((s) => ({
    store: s.id,
    name: s.name,
    capabilities: {
      product_details: s.capabilities.productDetails,
      store_locator: s.capabilities.storeLocator,
      minimum_order: s.capabilities.minimumOrder,
      booked_slot: s.capabilities.bookedSlot,
    },
    session_ok: checked ? s.failure === null : null,
    current_store: s.conditions?.store ?? null,
    failure: failure(s.failure),
  })),
});

export const presentLocations = (store: string, query: string, locations: readonly StoreLocation[]) => ({
  store,
  query,
  locations: locations.map(location),
});

export const presentSelection = (store: string, selected: StoreLocation) => ({ store, selected: location(selected) });

const summary = (s: CartSummary) => ({
  store: s.id,
  name: s.name,
  total_eur: euros(s.cart?.total ?? null),
  line_count: s.cart?.lines.length ?? null,
  item_count: s.cart ? s.cart.lines.reduce((n, l) => n + l.quantity, 0) : null,
  minimum_order_eur: euros(s.minimumOrder),
  missing_to_minimum_eur: euros(s.missingToMinimum),
  next_slots: s.conditions?.nextSlots.map(nextSlot) ?? [],
  lines: s.cart?.lines.map(cartLine) ?? [],
  failure: failure(s.failure),
});

export const presentComparison = (c: CartComparison) => ({
  mode: c.mode,
  cheapest: c.cheapest,
  stores: c.stores.map(summary),
});
