import type { Cart, Quantity } from "./cart.ts";
import type { OrderConditions } from "./order-conditions.ts";
import type { ProductDetails, ProductId, SearchResult } from "./product.ts";

/** What the retailer supports beyond the common base (search, cart, order conditions). */
export interface StoreCapabilities {
  /** get_product returns ingredients and origin. */
  readonly productDetails: boolean;
  /** find_stores / set_store: the agent can pick the store (otherwise, on the site). */
  readonly storeLocator: boolean;
  /** The minimum order amount can be read before checkout. */
  readonly minimumOrder: boolean;
  /** The slot booked by the user can be read. */
  readonly bookedSlot: boolean;
}

/** A retailer's store, as returned by its store locator. */
export interface StoreLocation {
  readonly id: string;
  readonly name: string;
  /** Drive pickup, walk-in pickup point or delivery only. */
  readonly serviceType: "drive" | "relay" | "delivery" | "other";
  readonly distanceKm: number | null;
  readonly postalCode: string | null;
}

/**
 * Port: the only boundary between the domain and an online store.
 * Three cart primitives; adding and removing derive from them (see application/).
 * Reads (product page, order conditions) and store selection, without booking anything.
 *
 * No method places an order: slot booking and payment remain a human action.
 * Implementations report failures with the errors of domain/errors.ts,
 * and a missing feature with NotSupportedError (consistent with `capabilities`).
 */
export interface GroceryStore {
  readonly capabilities: StoreCapabilities;
  search(query: string, limit: number): Promise<SearchResult>;
  /** Product page: ingredients and origin (read-only). */
  getProduct(id: ProductId): Promise<ProductDetails>;
  getCart(): Promise<Cart>;
  /** Sets a product's quantity (0 = removal). Idempotent. */
  setQuantity(id: ProductId, quantity: Quantity): Promise<void>;
  /** Store, slots and minimum order (read-only). */
  getOrderConditions(): Promise<OrderConditions>;
  /** Stores near a postcode or town, nearest first. */
  findStores(query: string): Promise<readonly StoreLocation[]>;
  /** Selects the active store among those returned by findStores. */
  selectStore(id: string): Promise<StoreLocation>;
}
