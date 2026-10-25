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
    amount_eur: z.number().nullable().describe("amount credited per unit"),
    nth: z.number().nullable().describe("rank of the discounted unit (2 = the 2nd)"),
    percent: z.number().nullable(),
    type: z.enum(["percent_off", "nth_percent_off", "loyalty_percent", "loyalty_amount"]),
  })
  .nullable()
  .describe("quantified mechanic; null if the text could not be interpreted (read details)");

const promotionSchema = z.object({
  details: z.array(z.string()),
  kind: z
    .enum(["immediate", "multibuy", "loyalty"])
    .describe(
      "immediate: already deducted from the price; multibuy: depends on the quantity; loyalty: loyalty card credit",
    ),
  label: z.string(),
  mechanic: mechanicSchema,
  regular_price_eur: z.number().nullable(),
  valid_until: z.string().nullable().describe("JJ/MM"),
});

export const productSchema = z.object({
  available: z.boolean(),
  best_offer: z
    .object({ net_unit_price_eur: z.number(), quantity: z.number() })
    .nullable()
    .describe("net cost per unit (bundles and loyalty credit included) at the quantity that triggers the offer"),
  id: z.string(),
  name: z.string(),
  price_eur: z.number().nullable().describe("price of one unit at checkout, immediate discounts deducted"),
  promotions: z.array(promotionSchema),
  unit_price: unitPriceSchema,
});

const storeInput = { store: z.string() };

export const searchOutput = {
  ...storeInput,
  products: z.array(productSchema),
  query: z.string(),
  total: z.number().describe("products reported by the site, across all pages"),
};

export const productDetailsOutput = {
  ...storeInput,
  allergens: z.string().nullable().describe("separate allergen statement, if the site provides it"),
  id: z.string(),
  ingredients: z
    .string()
    .nullable()
    .describe("ingredient list as displayed (allergens in capitals); null for a raw product"),
  name: z.string(),
  origin: z.string().nullable().describe("origin declared on the product page, if any"),
};

const cartLineSchema = z.object({
  line_total_eur: z.number().nullable(),
  name: z.string(),
  product_id: z.string(),
  quantity: z.number(),
  unit_price: unitPriceSchema,
});

export const cartOutput = {
  ...storeInput,
  lines: z.array(cartLineSchema),
  total_eur: z.number().nullable(),
};

export const cartChangeOutput = {
  ...storeInput,
  cart_total_eur: z.number().nullable(),
  confirmed: z.boolean().describe("true if the cart read back holds the targeted quantity"),
  expected_quantity: z.number(),
  line: cartLineSchema.nullable(),
  product_id: z.string(),
};

const slotSchema = z
  .object({
    end: z.string().nullable(),
    label: z.string(),
    start: z.string().nullable().describe("AAAA-MM-JJTHH:MM, heure locale"),
  })
  .nullable();

const nextSlotSchema = z.object({
  available: z.boolean(),
  full: z.boolean(),
  mode: z.enum(["drive", "delivery"]),
  slot: slotSchema,
});

const conditionsSchema = z.object({
  booked_slot: slotSchema.describe("slot firmly booked by the user"),
  cart_slot: slotSchema.describe("pickup date attached to the cart, not guaranteed as a booking"),
  minimum_orders: z
    .array(z.object({ eur: z.number(), mode: z.enum(["drive", "delivery"]) }))
    .nullable()
    .describe("null: the site does not expose it, check at checkout"),
  next_slots: z.array(nextSlotSchema),
  store: z.string().nullable().describe("selected store"),
});

const failureSchema = z.object({ error: z.string(), message: z.string(), retryable: z.boolean() }).nullable();

export const orderConditionsOutput = {
  stores: z.array(
    z.object({ conditions: conditionsSchema.nullable(), failure: failureSchema, name: z.string(), store: z.string() }),
  ),
};

const capabilitiesSchema = z.object({
  booked_slot: z.boolean(),
  minimum_order: z.boolean(),
  product_details: z.boolean(),
  store_locator: z.boolean(),
});

export const listStoresOutput = {
  stores: z.array(
    z.object({
      capabilities: capabilitiesSchema,
      current_store: z.string().nullable(),
      failure: failureSchema,
      name: z.string(),
      session_ok: z.boolean().nullable().describe("null if the session was not checked (check: false)"),
      store: z.string(),
    }),
  ),
};

const locationSchema = z.object({
  distance_km: z.number().nullable(),
  id: z.string().describe("to pass to set_store"),
  name: z.string(),
  postal_code: z.string().nullable(),
  service_type: z.enum(["drive", "relay", "delivery", "other"]),
});

export const findStoresOutput = { ...storeInput, locations: z.array(locationSchema), query: z.string() };
export const setStoreOutput = { ...storeInput, selected: locationSchema };

export const compareCartsOutput = {
  cheapest: z.string().nullable().describe("retailer with the cheapest non-empty cart"),
  mode: z.enum(["drive", "delivery"]),
  stores: z.array(
    z.object({
      failure: failureSchema,
      item_count: z.number().nullable(),
      line_count: z.number().nullable(),
      lines: z.array(cartLineSchema),
      minimum_order_eur: z.number().nullable(),
      missing_to_minimum_eur: z.number().nullable().describe("0 if the minimum is reached, null if unknown"),
      name: z.string(),
      next_slots: z.array(nextSlotSchema),
      store: z.string(),
      total_eur: z.number().nullable(),
    }),
  ),
};

// ---- Presentation -------------------------------------------------------------------------------

const unitPrice = (u: UnitPrice | null) => (u === null ? null : { eur: toEuros(u.price), per: u.per });

const mechanic = (m: Mechanic | null) => {
  if (m === null) return null;
  return {
    amount_eur: m.type === "loyalty_amount" ? toEuros(m.amount) : null,
    nth: m.type === "nth_percent_off" ? m.nth : null,
    percent: m.type === "loyalty_amount" ? null : m.percent,
    type: m.type,
  };
};

const promotion = (p: Promotion) => ({
  details: [...p.details],
  kind: p.kind,
  label: p.label,
  mechanic: mechanic(p.mechanic),
  regular_price_eur: euros(p.regularPrice),
  valid_until: p.validUntil,
});

const product = (p: Product) => {
  const offer = p.price !== null && p.promotions.length > 0 ? bestOffer(p.price, p.promotions) : null;
  return {
    available: p.available,
    best_offer: offer && { net_unit_price_eur: toEuros(offer.netUnitPrice), quantity: offer.quantity },
    id: p.id,
    name: p.name,
    price_eur: euros(p.price),
    promotions: p.promotions.map(promotion),
    unit_price: unitPrice(p.unitPrice),
  };
};

const cartLine = (l: CartLine) => ({
  line_total_eur: euros(l.lineTotal),
  name: l.name,
  product_id: l.productId,
  quantity: l.quantity,
  unit_price: unitPrice(l.unitPrice),
});

const slot = (s: SlotTime | null) => (s === null ? null : { end: s.end, label: s.label, start: s.start });

const nextSlot = (s: NextSlot) => ({ available: s.available, full: s.full, mode: s.mode, slot: slot(s.slot) });

const conditions = (c: OrderConditions) => ({
  booked_slot: slot(c.bookedSlot),
  cart_slot: slot(c.cartSlot),
  minimum_orders: c.minimumOrders?.map((m) => ({ eur: toEuros(m.amount), mode: m.mode })) ?? null,
  next_slots: c.nextSlots.map(nextSlot),
  store: c.store,
});

const failure = (f: StoreFailure | null) => (f === null ? null : { ...f });

const location = (l: StoreLocation) => ({
  distance_km: l.distanceKm,
  id: l.id,
  name: l.name,
  postal_code: l.postalCode,
  service_type: l.serviceType,
});

export const presentSearch = (store: string, r: SearchResult) => ({
  products: r.products.map(product),
  query: r.query,
  store,
  total: r.total,
});

export const presentProductDetails = (store: string, p: ProductDetails) => ({
  allergens: p.allergens,
  id: p.id,
  ingredients: p.ingredients,
  name: p.name,
  origin: p.origin,
  store,
});

export const presentCart = (store: string, c: Cart) => ({
  lines: c.lines.map(cartLine),
  store,
  total_eur: euros(c.total),
});

export const presentChange = (store: string, c: CartChange) => ({
  cart_total_eur: euros(c.cartTotal),
  confirmed: c.confirmed,
  expected_quantity: c.expectedQuantity,
  line: c.line === null ? null : cartLine(c.line),
  product_id: c.productId,
  store,
});

export const presentOrderConditions = (statuses: readonly StoreStatus[]) => ({
  stores: statuses.map((s) => ({
    conditions: s.conditions && conditions(s.conditions),
    failure: failure(s.failure),
    name: s.name,
    store: s.id,
  })),
});

export const presentStores = (statuses: readonly StoreStatus[], checked: boolean) => ({
  stores: statuses.map((s) => ({
    capabilities: {
      booked_slot: s.capabilities.bookedSlot,
      minimum_order: s.capabilities.minimumOrder,
      product_details: s.capabilities.productDetails,
      store_locator: s.capabilities.storeLocator,
    },
    current_store: s.conditions?.store ?? null,
    failure: failure(s.failure),
    name: s.name,
    session_ok: checked ? s.failure === null : null,
    store: s.id,
  })),
});

export const presentLocations = (store: string, query: string, locations: readonly StoreLocation[]) => ({
  locations: locations.map(location),
  query,
  store,
});

export const presentSelection = (store: string, selected: StoreLocation) => ({ selected: location(selected), store });

const summary = (s: CartSummary) => ({
  failure: failure(s.failure),
  item_count: s.cart ? s.cart.lines.reduce((n, l) => n + l.quantity, 0) : null,
  line_count: s.cart?.lines.length ?? null,
  lines: s.cart?.lines.map(cartLine) ?? [],
  minimum_order_eur: euros(s.minimumOrder),
  missing_to_minimum_eur: euros(s.missingToMinimum),
  name: s.name,
  next_slots: s.conditions?.nextSlots.map(nextSlot) ?? [],
  store: s.id,
  total_eur: euros(s.cart?.total ?? null),
});

export const presentComparison = (c: CartComparison) => ({
  cheapest: c.cheapest,
  mode: c.mode,
  stores: c.stores.map(summary),
});
