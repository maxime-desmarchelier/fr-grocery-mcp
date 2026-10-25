// In-memory simulated store: same contract as the real sites, for tests and offline demos.

import type { Cart, CartLine, Quantity } from "../../../domain/cart.ts";
import { NotSupportedError, SessionExpiredError, ValidationError } from "../../../domain/errors.ts";
import type { GroceryStore, StoreCapabilities, StoreLocation } from "../../../domain/grocery-store.ts";
import { multiply, sum } from "../../../domain/money.ts";
import type { OrderConditions } from "../../../domain/order-conditions.ts";
import type { Product, ProductDetails, ProductId, SearchResult } from "../../../domain/product.ts";

/** Lowercase, no accents, normalized spaces: lenient search like on the sites. */
const normalizeText = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

const NO_CONDITIONS: OrderConditions = {
  bookedSlot: null,
  cartSlot: null,
  minimumOrders: null,
  nextSlots: [],
  store: null,
};

/** Known ingredients, allergens and origin of a product in the simulated catalogue. */
export type SimulatedDetails = Partial<Pick<ProductDetails, "ingredients" | "allergens" | "origin">>;

export interface InMemoryStoreOptions {
  readonly conditions?: OrderConditions;
  readonly details?: ReadonlyMap<ProductId, SimulatedDetails>;
  /** Stores returned by findStores; without a list, store search is not supported. */
  readonly locations?: readonly StoreLocation[];
}

export class InMemoryStore implements GroceryStore {
  readonly capabilities: StoreCapabilities;
  readonly #catalogue: readonly Product[];
  readonly #cart = new Map<ProductId, Quantity>();
  readonly #conditions: OrderConditions;
  readonly #details: ReadonlyMap<ProductId, SimulatedDetails>;
  readonly #locations: readonly StoreLocation[] | null;
  #selected: StoreLocation | null = null;
  /** Simulates an expired session. */
  expired = false;

  constructor(catalogue: readonly Product[], options: InMemoryStoreOptions = {}) {
    this.#catalogue = catalogue;
    this.#conditions = options.conditions ?? NO_CONDITIONS;
    this.#details = options.details ?? new Map();
    this.#locations = options.locations ?? null;
    this.capabilities = {
      bookedSlot: true,
      minimumOrder: this.#conditions.minimumOrders !== null,
      productDetails: true,
      storeLocator: this.#locations !== null,
    };
  }

  /** Store chosen by selectStore (null until one is). */
  get selected(): StoreLocation | null {
    return this.#selected;
  }

  async search(query: string, limit: number): Promise<SearchResult> {
    this.#guard();
    const words = normalizeText(query).split(" ");
    const found = this.#catalogue.filter((p) => words.every((w) => normalizeText(p.name).includes(w)));
    return { products: found.slice(0, limit), query, total: found.length };
  }

  async getProduct(id: ProductId): Promise<ProductDetails> {
    this.#guard();
    const { name } = this.#product(id);
    return { allergens: null, id, ingredients: null, name, origin: null, ...this.#details.get(id) };
  }

  async getCart(): Promise<Cart> {
    this.#guard();
    const lines: CartLine[] = [...this.#cart].map(([id, quantity]) => {
      const product = this.#product(id);
      return {
        lineTotal: product.price === null ? null : multiply(product.price, quantity),
        name: product.name,
        productId: id,
        quantity,
        unitPrice: product.unitPrice,
      };
    });
    const totals = lines.flatMap((l) => (l.lineTotal === null ? [] : [l.lineTotal]));
    return { lines, total: sum(totals) };
  }

  async setQuantity(id: ProductId, quantity: Quantity): Promise<void> {
    this.#guard();
    this.#product(id);
    if (quantity === 0) this.#cart.delete(id);
    else this.#cart.set(id, quantity);
  }

  async getOrderConditions(): Promise<OrderConditions> {
    this.#guard();
    return this.#conditions;
  }

  async findStores(query: string): Promise<readonly StoreLocation[]> {
    const locations = this.#locator();
    return locations.filter((l) => l.postalCode === query || normalizeText(l.name).includes(normalizeText(query)));
  }

  async selectStore(id: string): Promise<StoreLocation> {
    const location = this.#locator().find((l) => l.id === id);
    if (!location) throw new ValidationError(`Unknown store ${id}: run find_stores first.`);
    this.#selected = location;
    return location;
  }

  #product(id: ProductId): Product {
    const product = this.#catalogue.find((p) => p.id === id);
    if (!product) throw new ValidationError(`Product ${id} not in the catalogue.`);
    return product;
  }

  #locator(): readonly StoreLocation[] {
    this.#guard();
    if (this.#locations === null) throw new NotSupportedError("Store search not supported.");
    return this.#locations;
  }

  #guard(): void {
    if (this.expired) throw new SessionExpiredError("Simulated store");
  }
}
