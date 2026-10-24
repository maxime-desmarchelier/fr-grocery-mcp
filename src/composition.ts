// Wiring: from the configuration to the plugged-in retailers, each with its own pace and retries.
// The HTTP client is injected (Chrome in production, a fake client in tests).

import { ShoppingService, type ShoppingServiceOptions } from "./application/shopping-service.ts";
import { type RegisteredStore, StoreRegistry } from "./application/store-registry.ts";
import type { Config, StoreConfig } from "./config.ts";
import type { GroceryStore } from "./domain/grocery-store.ts";
import type { PageHttp, PageHttpFactory } from "./infrastructure/http/page-http.ts";
import { RetryingStore, type RetryOptions } from "./infrastructure/http/retrying-store.ts";
import { ThrottledHttp } from "./infrastructure/http/throttled-http.ts";
import { LeclercStore } from "./infrastructure/retailers/leclerc/leclerc-store.ts";
import { LECLERC_NAME } from "./infrastructure/retailers/leclerc/parsers.ts";
import { FileSelection, type SelectionRepository } from "./infrastructure/retailers/leclerc/selection.ts";
import { SUPERU_NAME } from "./infrastructure/retailers/superu/parsers.ts";
import { SUPERU_HOME_PATH, SUPERU_ORIGIN, SuperUStore } from "./infrastructure/retailers/superu/superu-store.ts";

export interface CompositionOptions {
  readonly service?: ShoppingServiceOptions;
  readonly retry?: RetryOptions;
  /** No request spacing (tests). */
  readonly unthrottled?: boolean;
  readonly selection?: (fallback: Extract<StoreConfig, { retailer: "leclerc" }>["store"]) => SelectionRepository;
}

/** One spacing queue per origin and retailer, shared by all its calls. */
function throttledFactory(http: PageHttpFactory, minIntervalMs: number, unthrottled: boolean): PageHttpFactory {
  const clients = new Map<string, PageHttp>();
  return (origin, homePath) => {
    let client = clients.get(origin);
    if (!client) {
      const tab = http(origin, homePath);
      client = unthrottled ? tab : new ThrottledHttp(tab, { minIntervalMs, jitterMs: Math.round(minIntervalMs / 2) });
      clients.set(origin, client);
    }
    return client;
  };
}

function storeFor(config: Config, store: StoreConfig, http: PageHttpFactory, options: CompositionOptions) {
  const factory = throttledFactory(http, store.minIntervalMs, options.unthrottled ?? false);
  switch (store.retailer) {
    case "superu":
      return { id: "superu", name: SUPERU_NAME, store: new SuperUStore(factory(SUPERU_ORIGIN, SUPERU_HOME_PATH)) };
    case "leclerc": {
      const selection =
        options.selection?.(store.store) ?? new FileSelection(`${config.stateDir}/leclerc-store.json`, store.store);
      return { id: "leclerc", name: LECLERC_NAME, store: new LeclercStore({ http: factory, selection }) };
    }
  }
}

export function buildRegistry(config: Config, http: PageHttpFactory, options: CompositionOptions = {}): StoreRegistry {
  const stores: RegisteredStore[] = config.stores.map((entry) => {
    const { id, name, store } = storeFor(config, entry, http, options);
    const decorated: GroceryStore = new RetryingStore(store, options.retry);
    return { id, name, service: new ShoppingService(decorated, options.service) };
  });
  return new StoreRegistry(stores);
}
