import type { Cart, Quantity } from "../../domain/cart.ts";
import { ShopError } from "../../domain/errors.ts";
import type { GroceryStore, StoreCapabilities, StoreLocation } from "../../domain/grocery-store.ts";
import type { OrderConditions } from "../../domain/order-conditions.ts";
import type { ProductDetails, ProductId, SearchResult } from "../../domain/product.ts";

export interface RetryOptions {
  readonly retries?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Calls fn, retrying errors flagged as retryable, with exponential backoff. */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 2, baseDelayMs = 500, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = options;
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!(error instanceof ShopError && error.retryable) || attempt >= retries) throw error;
      await sleep(baseDelayMs * 2 ** attempt);
    }
  }
}

/**
 * Decorator: same contract as the decorated store, retrying transient failures.
 * An anti-bot block (SiteBlockedError) is never retried.
 */
export class RetryingStore implements GroceryStore {
  readonly #inner: GroceryStore;
  readonly #options: RetryOptions;

  constructor(inner: GroceryStore, options: RetryOptions = {}) {
    this.#inner = inner;
    this.#options = options;
  }

  get capabilities(): StoreCapabilities {
    return this.#inner.capabilities;
  }

  search(query: string, limit: number): Promise<SearchResult> {
    return withRetry(() => this.#inner.search(query, limit), this.#options);
  }

  getProduct(id: ProductId): Promise<ProductDetails> {
    return withRetry(() => this.#inner.getProduct(id), this.#options);
  }

  getCart(): Promise<Cart> {
    return withRetry(() => this.#inner.getCart(), this.#options);
  }

  setQuantity(id: ProductId, quantity: Quantity): Promise<void> {
    // Idempotent (absolute quantity): retrying cannot double an addition.
    return withRetry(() => this.#inner.setQuantity(id, quantity), this.#options);
  }

  getOrderConditions(): Promise<OrderConditions> {
    return withRetry(() => this.#inner.getOrderConditions(), this.#options);
  }

  findStores(query: string): Promise<readonly StoreLocation[]> {
    return withRetry(() => this.#inner.findStores(query), this.#options);
  }

  selectStore(id: string): Promise<StoreLocation> {
    return withRetry(() => this.#inner.selectStore(id), this.#options);
  }
}
