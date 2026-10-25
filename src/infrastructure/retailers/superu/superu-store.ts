// Super U adapter of the GroceryStore port. Requests captured on the site: see docs/retailers/superu.md.

import type { Cart, Quantity } from "../../../domain/cart.ts";
import { NotSupportedError, TransientError, ValidationError } from "../../../domain/errors.ts";
import type { GroceryStore, StoreCapabilities, StoreLocation } from "../../../domain/grocery-store.ts";
import type { OrderConditions } from "../../../domain/order-conditions.ts";
import type { Product, ProductDetails, ProductId, SearchResult } from "../../../domain/product.ts";
import type { PageHttp } from "../../http/page-http.ts";
import {
  assertNotBlocked,
  parseCartPage,
  parseMinimumOrder,
  parseProductPage,
  parseSearchPage,
  parseSlotInfoPage,
  SUPERU_NAME,
} from "./parsers.ts";

export const SUPERU_ORIGIN = "https://www.coursesu.com";
export const SUPERU_HOME_PATH = "/drive/home";

const SUPERU_PRODUCT_ID = /^\d{1,20}$/;

const SET_QUANTITY_PATH = "/on/demandware.store/Sites-DigitalU-Site/fr_FR/Cart-AddProduct?format=ajax";
const SLOT_INFO_PATH = "/on/demandware.store/Sites-DigitalU-Site/fr_FR/Home-IncludeNavigationSlotTimeInfo";
const PAGE_SIZE = 18;
const MAX_PAGES = 10;

/** Super U identifiers are numeric; any other format would end up in a URL or a form. */
function assertSuperUId(id: ProductId): void {
  if (!SUPERU_PRODUCT_ID.test(id))
    throw new ValidationError(`Invalid Super U product identifier: "${id}" (numeric expected).`);
}

export interface SuperUStoreOptions {
  /** Today's date, to infer the year of slots. */
  readonly today?: () => Date;
}

export class SuperUStore implements GroceryStore {
  readonly capabilities: StoreCapabilities = {
    bookedSlot: true,
    minimumOrder: true,
    productDetails: true,
    storeLocator: false,
  };
  readonly #http: PageHttp;
  readonly #today: () => Date;
  #csrfToken: string | null = null;

  constructor(http: PageHttp, options: SuperUStoreOptions = {}) {
    this.#http = http;
    this.#today = options.today ?? (() => new Date());
  }

  async search(query: string, limit: number): Promise<SearchResult> {
    const products = new Map<string, Product>();
    let total = 0;
    for (let page = 0; page < MAX_PAGES && products.size < limit; page++) {
      const start = page * PAGE_SIZE;
      const path = `/recherche?q=${encodeURIComponent(query)}${start ? `&start=${start}` : ""}`;
      const { status, body } = await this.#http.request(path);
      const result = parseSearchPage(status, body);
      this.#csrfToken = result.csrfToken ?? this.#csrfToken;
      if (page === 0) total = result.total;
      if (result.products.length === 0) break;
      for (const p of result.products) if (!products.has(p.id)) products.set(p.id, p);
      if (products.size >= total) break;
    }
    return { products: [...products.values()].slice(0, limit), query, total };
  }

  /** Product page: the site ignores the URL label, only the identifier matters. */
  async getProduct(id: ProductId): Promise<ProductDetails> {
    assertSuperUId(id);
    const { status, body } = await this.#http.request(`/p/produit/${id}.html`);
    return parseProductPage(status, body, id);
  }

  async getCart(): Promise<Cart> {
    const { status, body } = await this.#http.request("/panier");
    const page = parseCartPage(status, body);
    this.#csrfToken = page.csrfToken ?? this.#csrfToken;
    return { lines: page.lines, total: page.total };
  }

  /** Header store / slot banner and minimum shown on /panier: two GETs, nothing is booked. */
  async getOrderConditions(): Promise<OrderConditions> {
    const slots = await this.#http.request(SLOT_INFO_PATH);
    const info = parseSlotInfoPage(slots.status, slots.body, this.#today());
    const cart = await this.#http.request("/panier");
    return { ...info, cartSlot: null, minimumOrders: parseMinimumOrder(cart.status, cart.body) };
  }

  /** POST Cart-AddProduct with update=true SETS the quantity (checked on the site, 0 = removal). */
  async setQuantity(id: ProductId, quantity: Quantity): Promise<void> {
    assertSuperUId(id);
    if (!this.#csrfToken) await this.getCart();
    if (!this.#csrfToken) throw new TransientError("CSRF token not found on the cart page.");
    const form = new URLSearchParams({
      csrf_token: this.#csrfToken,
      fullview: "true",
      isLuckyProduct: "false",
      location: "search",
      modifiableOrderID: "",
      operationId: "",
      pageId: "",
      pageType: "Search result",
      pid: id,
      Quantity: String(quantity),
      quantity: String(quantity),
      requestedQuantity: "",
      sponsoringCampaignId: "",
      sponsoringType: "",
      update: "true",
    });
    const { status, body } = await this.#http.request(SET_QUANTITY_PATH, {
      body: form.toString(),
      headers: {
        Accept: "application/json, text/javascript, */*; q=0.01",
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
      },
      method: "POST",
    });
    assertNotBlocked(status, body);
    if (status < 200 || status >= 300) {
      this.#csrfToken = null; // token may be stale: read again on the next attempt
      throw new TransientError(`Cart change refused (HTTP ${status}).`);
    }
  }

  async findStores(): Promise<readonly StoreLocation[]> {
    throw notSupported();
  }

  async selectStore(): Promise<StoreLocation> {
    throw notSupported();
  }
}

const notSupported = () =>
  new NotSupportedError(
    `${SUPERU_NAME}: the store is chosen on coursesu.com (get_order_conditions shows the active store).`,
  );
