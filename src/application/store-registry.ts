import { ValidationError } from "../domain/errors.ts";
import type { ShoppingService } from "./shopping-service.ts";

const RETAILER_ID = /^[a-z][a-z0-9-]{1,31}$/;

/** Retailer plugged into the server. */
export interface RegisteredStore {
  /** Short identifier passed to the tools ("superu", "leclerc"). */
  readonly id: string;
  /** Display name ("Super U", "E.Leclerc Drive"). */
  readonly name: string;
  readonly service: ShoppingService;
}

/** Available retailers, in the configuration's order of preference. */
export class StoreRegistry {
  readonly #stores: ReadonlyMap<string, RegisteredStore>;

  constructor(stores: readonly RegisteredStore[]) {
    if (stores.length === 0) throw new ValidationError("No retailer configured.");
    const byId = new Map<string, RegisteredStore>();
    for (const store of stores) {
      if (!RETAILER_ID.test(store.id)) throw new ValidationError(`Invalid retailer identifier: ${store.id}`);
      if (byId.has(store.id)) throw new ValidationError(`Duplicate retailer: ${store.id}`);
      byId.set(store.id, store);
    }
    this.#stores = byId;
  }

  /** At least one identifier: usable as is for a schema enum. */
  get ids(): [string, ...string[]] {
    const [first, ...rest] = this.#stores.keys();
    return [first as string, ...rest];
  }

  all(): readonly RegisteredStore[] {
    return [...this.#stores.values()];
  }

  get(id: string): RegisteredStore {
    const store = this.#stores.get(id);
    if (!store) throw new ValidationError(`Unknown retailer: "${id}". Retailers: ${this.ids.join(", ")}.`);
    return store;
  }
}
