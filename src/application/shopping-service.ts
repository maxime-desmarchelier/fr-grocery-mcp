import { type Cart, type CartLine, findLine, type Quantity, quantityAfterAdding } from "../domain/cart.ts";
import { ValidationError } from "../domain/errors.ts";
import type { GroceryStore, StoreCapabilities, StoreLocation } from "../domain/grocery-store.ts";
import type { Money } from "../domain/money.ts";
import type { OrderConditions } from "../domain/order-conditions.ts";
import type { ProductDetails, ProductId, SearchResult } from "../domain/product.ts";

export const DEFAULT_SEARCH_LIMIT = 20;
/** Per-line cap: beyond it, it is almost certainly an agent mistake (wrong unit, duplicate…). */
export const MAX_QUANTITY_PER_LINE = 50;
export const MAX_SEARCH_LIMIT = 100;

/** Result of a cart change, read back from the site. */
export interface CartChange {
  readonly productId: ProductId;
  /** Quantity targeted by the change. */
  readonly expectedQuantity: Quantity;
  /** Line read back after the change (null if the product is no longer in the cart). */
  readonly line: CartLine | null;
  /** True if the cart read back holds the targeted quantity. */
  readonly confirmed: boolean;
  readonly cartTotal: Money | null;
}

export interface ShoppingServiceOptions {
  /** Extra read-backs if the site is slow to reflect a change. */
  readonly confirmAttempts?: number;
  readonly confirmDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * Use cases exposed to the agent. No business decision about recipes or quantities:
 * the agent chooses, the service executes and verifies.
 */
export class ShoppingService {
  readonly #store: GroceryStore;
  readonly #confirmAttempts: number;
  readonly #confirmDelayMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(store: GroceryStore, options: ShoppingServiceOptions = {}) {
    this.#store = store;
    this.#confirmAttempts = options.confirmAttempts ?? 2;
    this.#confirmDelayMs = options.confirmDelayMs ?? 1000;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  search(query: string, limit: number = DEFAULT_SEARCH_LIMIT): Promise<SearchResult> {
    const term = query.trim();
    if (term.length === 0 || term.length > 100)
      throw new ValidationError("Empty or too long search (1 to 100 characters).");
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new ValidationError(`Invalid limit: ${limit} (1 to ${MAX_SEARCH_LIMIT}).`);
    }
    return this.#store.search(term, limit);
  }

  getProduct(id: ProductId): Promise<ProductDetails> {
    return this.#store.getProduct(id);
  }

  getCart(): Promise<Cart> {
    return this.#store.getCart();
  }

  getOrderConditions(): Promise<OrderConditions> {
    return this.#store.getOrderConditions();
  }

  get capabilities(): StoreCapabilities {
    return this.#store.capabilities;
  }

  findStores(query: string): Promise<readonly StoreLocation[]> {
    const term = query.trim();
    if (term.length < 2 || term.length > 60)
      throw new ValidationError("Postcode or town expected (2 to 60 characters).");
    return this.#store.findStores(term);
  }

  selectStore(id: string): Promise<StoreLocation> {
    const value = id.trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(value)) throw new ValidationError(`Invalid store identifier: "${id}"`);
    return this.#store.selectStore(value);
  }

  /** Adds units to the quantity already present (the site itself can only set a quantity). */
  async add(id: ProductId, quantity: Quantity): Promise<CartChange> {
    if (quantity === 0) throw new ValidationError("Adding 0 units: nothing to do.");
    const target = quantityAfterAdding(await this.#store.getCart(), id, quantity);
    return this.setQuantity(id, target);
  }

  async setQuantity(id: ProductId, quantity: Quantity): Promise<CartChange> {
    if (quantity > MAX_QUANTITY_PER_LINE) {
      throw new ValidationError(`Quantity ${quantity} refused: cap of ${MAX_QUANTITY_PER_LINE} units per product.`);
    }
    await this.#store.setQuantity(id, quantity);
    return this.#confirm(id, quantity);
  }

  remove(id: ProductId): Promise<CartChange> {
    return this.setQuantity(id, 0 as Quantity);
  }

  async #confirm(id: ProductId, expected: Quantity): Promise<CartChange> {
    let cart = await this.#store.getCart();
    for (let attempt = 0; attempt < this.#confirmAttempts && !matches(cart, id, expected); attempt++) {
      await this.#sleep(this.#confirmDelayMs);
      cart = await this.#store.getCart();
    }
    return {
      productId: id,
      expectedQuantity: expected,
      line: findLine(cart, id),
      confirmed: matches(cart, id, expected),
      cartTotal: cart.total,
    };
  }
}

function matches(cart: Cart, id: ProductId, expected: Quantity): boolean {
  return (findLine(cart, id)?.quantity ?? 0) === expected;
}
