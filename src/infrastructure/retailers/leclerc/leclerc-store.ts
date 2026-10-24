// E.Leclerc Drive adapter of the GroceryStore port. Requests captured on the site: see docs/retailers/leclerc.md.
// Builds on the knowledge of the site's calls from the MIT project skunkobi/mcp-leclerc-drive (see NOTICE), rewritten and tested.

import type { Cart, Quantity } from "../../../domain/cart.ts";
import { ValidationError } from "../../../domain/errors.ts";
import type { GroceryStore, StoreCapabilities, StoreLocation } from "../../../domain/grocery-store.ts";
import type { OrderConditions } from "../../../domain/order-conditions.ts";
import type { ProductDetails, ProductId, SearchResult } from "../../../domain/product.ts";
import type { PageHttpFactory } from "../../http/page-http.ts";
import {
  assertMutationAccepted,
  type LeclercStoreLocation,
  parseAutocomplete,
  parseCartPage,
  parseConditionsPage,
  parseCoordinates,
  parseNearby,
  parseProductPage,
  parseSearchPage,
} from "./parsers.ts";
import type { LeclercSelection, SelectionRepository } from "./selection.ts";

export const LOCATOR_ORIGIN = "https://www.leclercdrive.fr";
const LOCATOR_API = "https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1";

/** Action type of the cart POST: 1 increases, 2 decreases or removes; iQuantite is the final quantity. */
const ACTION_INCREASE = 1;
const ACTION_DECREASE = 2;
/** Beyond this, the quantity read from the cart is too stale to choose the direction of the change. */
const CART_FRESHNESS_MS = 15_000;

function assertLeclercId(id: ProductId): void {
  if (!/^\d{1,12}$/.test(id))
    throw new ValidationError(`Invalid Leclerc product identifier: "${id}" (numeric expected).`);
}

export interface LeclercStoreOptions {
  readonly http: PageHttpFactory;
  readonly selection: SelectionRepository;
  readonly now?: () => Date;
}

export class LeclercStore implements GroceryStore {
  readonly capabilities: StoreCapabilities = {
    productDetails: true,
    storeLocator: true,
    minimumOrder: false,
    bookedSlot: false,
  };
  readonly #http: PageHttpFactory;
  readonly #selection: SelectionRepository;
  readonly #now: () => Date;
  #found = new Map<string, LeclercStoreLocation>();
  #lastCart: { readonly at: number; readonly cart: Cart } | null = null;

  constructor(options: LeclercStoreOptions) {
    this.#http = options.http;
    this.#selection = options.selection;
    this.#now = options.now ?? (() => new Date());
  }

  async search(query: string, limit: number): Promise<SearchResult> {
    const { status, body } = await this.#get(`/recherche.aspx?TexteRecherche=${encodeURIComponent(query)}`);
    const page = parseSearchPage(status, body);
    return { query, total: page.total, products: page.products.slice(0, limit) };
  }

  /** The URL label is cosmetic: only the identifier matters. */
  async getProduct(id: ProductId): Promise<ProductDetails> {
    assertLeclercId(id);
    const { status, body } = await this.#get(`/fiche-produits-${id}-produit.aspx`);
    return parseProductPage(status, body, id);
  }

  /** The cart is embedded in every store page; recherche.aspx without a term is the lightest. */
  async getCart(): Promise<Cart> {
    const { status, body } = await this.#get("/recherche.aspx");
    const cart = parseCartPage(status, body);
    this.#lastCart = { at: this.#now().getTime(), cart };
    return cart;
  }

  async getOrderConditions(): Promise<OrderConditions> {
    const { status, body } = await this.#get("/recherche.aspx");
    const page = parseConditionsPage(status, body, this.#now());
    const selection = this.#selection.current();
    return {
      store: selection.name ?? `store ${selection.storeId}`,
      bookedSlot: null,
      cartSlot: page.cartSlot,
      nextSlots: page.nextSlots,
      minimumOrders: null,
    };
  }

  /** POST panier.aspx?op=1 with the final quantity; the direction (increase / decrease) depends on the current quantity. */
  async setQuantity(id: ProductId, quantity: Quantity): Promise<void> {
    assertLeclercId(id);
    const current = (await this.#freshCart()).lines.find((l) => l.productId === id)?.quantity ?? 0;
    if (current === quantity) return;
    const selection = this.#selection.current();
    const payload = {
      eTypeAction: quantity > current ? ACTION_INCREASE : ACTION_DECREASE,
      iIdProduit: id,
      iQuantite: quantity,
      sNoPointLivraison: selection.storeId,
    };
    this.#lastCart = null;
    const { status, body } = await this.#client().request(`${basePath(selection)}/panier.aspx?op=1`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-Requested-With": "XMLHttpRequest",
        Accept: "application/json, text/javascript, */*; q=0.01",
      },
      body: `d=${encodeURIComponent(JSON.stringify(payload))}`,
    });
    assertMutationAccepted(status, body);
  }

  /** Three calls to the public store locator API, from a www.leclercdrive.fr page. */
  async findStores(query: string): Promise<readonly StoreLocation[]> {
    const http = this.#http(LOCATOR_ORIGIN, "/");
    const auto = await http.request(`${LOCATOR_API}/autocomplete?search=${encodeURIComponent(query)}&provider=Woosmap`);
    const place = parseAutocomplete(auto.status, auto.body);
    if (!place) return [];
    const coords = await http.request(
      `${LOCATOR_API}/autocomplete/coordinates?id=${encodeURIComponent(place.id)}&provider=Woosmap`,
    );
    const { latitude, longitude } = parseCoordinates(coords.status, coords.body);
    const postalCode = encodeURIComponent(place.postalCode ?? query);
    const near = await http.request(
      `${LOCATOR_API}/MapPoint/nearby?latitude=${latitude}&longitude=${longitude}&postalCode=${postalCode}`,
    );
    const stores = parseNearby(near.status, near.body);
    this.#found = new Map(stores.map((s) => [s.id, s]));
    return stores.map(({ retrievalPointId: _, host: __, ...location }) => location);
  }

  /**
   * Remembers the chosen store. The Leclerc session stays bound to the drive opened on the site: if requests
   * then answer "session expirée", the user opens this store on leclercdrive.fr.
   */
  async selectStore(id: string): Promise<StoreLocation> {
    const found = this.#found.get(id);
    if (!found) throw new ValidationError(`Unknown store ${id}: run find_stores first, then pick an id from the list.`);
    const [storeId = id] = id.split("-");
    const selection: LeclercSelection = {
      storeId,
      retrievalPointId: found.retrievalPointId,
      host: found.host,
      name: found.name,
    };
    this.#selection.save(selection);
    this.#lastCart = null;
    const { retrievalPointId: _, host: __, ...location } = found;
    return location;
  }

  async #freshCart(): Promise<Cart> {
    const last = this.#lastCart;
    if (last && this.#now().getTime() - last.at < CART_FRESHNESS_MS) return last.cart;
    return this.getCart();
  }

  #client() {
    const selection = this.#selection.current();
    return this.#http(`https://${selection.host}`, `${basePath(selection)}/recherche.aspx`);
  }

  #get(path: string) {
    return this.#client().request(`${basePath(this.#selection.current())}${path}`);
  }
}

/** Store path for the server: the name suffix of the site's URLs is cosmetic. */
function basePath(selection: LeclercSelection): string {
  return `/magasin-${selection.storeId}-${selection.retrievalPointId}`;
}
