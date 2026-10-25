// Cross-retailer use cases: status of each retailer and cart comparison.
// Retailers are queried one after the other (a single Chrome, a human pace).

import type { Cart } from "../domain/cart.ts";
import { ShopError } from "../domain/errors.ts";
import type { StoreCapabilities } from "../domain/grocery-store.ts";
import { type Money, subtract } from "../domain/money.ts";
import { type FulfilmentMode, minimumFor, type OrderConditions } from "../domain/order-conditions.ts";
import type { RegisteredStore, StoreRegistry } from "./store-registry.ts";

/** A retailer's failure, isolated so it does not block the others. */
export interface StoreFailure {
  readonly error: string;
  readonly message: string;
  readonly retryable: boolean;
}

function failureOf(error: unknown): StoreFailure {
  if (error instanceof ShopError) return { error: error.name, message: error.message, retryable: error.retryable };
  return { error: "InternalError", message: error instanceof Error ? error.message : String(error), retryable: false };
}

async function attempt<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; failure: null } | { value: null; failure: StoreFailure }> {
  try {
    return { failure: null, value: await fn() };
  } catch (error) {
    return { failure: failureOf(error), value: null };
  }
}

export interface StoreStatus {
  readonly id: string;
  readonly name: string;
  readonly capabilities: StoreCapabilities;
  /** Conditions read if `check` was requested and the session responds. */
  readonly conditions: OrderConditions | null;
  readonly failure: StoreFailure | null;
}

/** A retailer's capabilities and, if `check`, its order conditions (proof that the session responds). */
export async function statusOf(store: RegisteredStore, check: boolean): Promise<StoreStatus> {
  const base = { capabilities: store.service.capabilities, id: store.id, name: store.name };
  if (!check) return { ...base, conditions: null, failure: null };
  const { value, failure } = await attempt(() => store.service.getOrderConditions());
  return { ...base, conditions: value, failure };
}

export async function listStores(registry: StoreRegistry, check: boolean): Promise<readonly StoreStatus[]> {
  const statuses: StoreStatus[] = [];
  for (const store of registry.all()) statuses.push(await statusOf(store, check));
  return statuses;
}

export interface CartSummary {
  readonly id: string;
  readonly name: string;
  readonly cart: Cart | null;
  readonly conditions: OrderConditions | null;
  /** Minimum for the requested mode; null if the site does not expose it. */
  readonly minimumOrder: Money | null;
  /** Amount missing to reach the minimum (0 if reached, null if unknown). */
  readonly missingToMinimum: Money | null;
  readonly failure: StoreFailure | null;
}

export interface CartComparison {
  readonly mode: FulfilmentMode;
  /** Summaries sorted from the cheapest cart to the most expensive; failures last. */
  readonly stores: readonly CartSummary[];
  /** Retailer with the cheapest cart among those that responded (null if none). */
  readonly cheapest: string | null;
}

async function summarize(store: RegisteredStore, mode: FulfilmentMode): Promise<CartSummary> {
  const base = { id: store.id, name: store.name };
  const cart = await attempt(() => store.service.getCart());
  if (cart.failure) {
    return { ...base, cart: null, conditions: null, failure: cart.failure, minimumOrder: null, missingToMinimum: null };
  }
  // Optional conditions: a failure here does not invalidate the cart.
  const conditions = await attempt(() => store.service.getOrderConditions());
  const minimumOrder = conditions.value ? minimumFor(conditions.value, mode) : null;
  const total = cart.value.total;
  return {
    ...base,
    cart: cart.value,
    conditions: conditions.value,
    failure: conditions.failure,
    minimumOrder,
    missingToMinimum: minimumOrder !== null && total !== null ? subtract(minimumOrder, total) : null,
  };
}

/**
 * Reads each retailer's cart and ranks them by total.
 * Carts hold different products: the agent compares the lines, the server provides reliable totals.
 */
export async function compareCarts(registry: StoreRegistry, mode: FulfilmentMode): Promise<CartComparison> {
  const summaries: CartSummary[] = [];
  for (const store of registry.all()) summaries.push(await summarize(store, mode));
  const rank = (s: CartSummary): number => s.cart?.total ?? Number.POSITIVE_INFINITY;
  const sorted = summaries.toSorted((a, b) => rank(a) - rank(b));
  const cheapest = sorted.find((s) => s.cart !== null && s.cart.total !== null && s.cart.lines.length > 0)?.id ?? null;
  return { cheapest, mode, stores: sorted };
}
