// MCP server: exposes each retailer's shopping use cases to an agent.
// Thin layer: validates inputs, calls the service, formats the output. No business logic here.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { DEFAULT_SEARCH_LIMIT, MAX_QUANTITY_PER_LINE, MAX_SEARCH_LIMIT } from "../../application/shopping-service.ts";
import { compareCarts, listStores, statusOf } from "../../application/store-overview.ts";
import type { StoreRegistry } from "../../application/store-registry.ts";
import { parseQuantity } from "../../domain/cart.ts";
import { ShopError } from "../../domain/errors.ts";
import { parseProductId } from "../../domain/product.ts";
import {
  cartChangeOutput,
  cartOutput,
  compareCartsOutput,
  findStoresOutput,
  listStoresOutput,
  orderConditionsOutput,
  presentCart,
  presentChange,
  presentComparison,
  presentLocations,
  presentOrderConditions,
  presentProductDetails,
  presentSearch,
  presentSelection,
  presentStores,
  productDetailsOutput,
  searchOutput,
  setStoreOutput,
} from "./presenters.ts";

export const SERVER_NAME = "fr-grocery-mcp";

// Kept in sync with package.json by release-please.
export const SERVER_VERSION = "0.2.0"; // x-release-please-version

export function instructions(registry: StoreRegistry): string {
  const stores = registry
    .all()
    .map((s) => `${s.id} (${s.name})`)
    .join(", ");
  return `Online grocery shopping (drive pickup or delivery) at several French retailers, through the user's Chrome session: ${stores}.
Every retailer tool takes the store parameter. Calls run one after the other: there is no point in parallelizing them.
Suggested flow for "order what I need to cook X for N people":
1. list_stores (check: true): retailers, capabilities and session status. get_order_conditions without store
   compares the next slots and minimum orders of all retailers.
2. Work out the list of ingredients and quantities for N people yourself.
3. get_cart first: do not buy again what is already there.
4. For each ingredient, search_products with a short French term ("boeuf haché", "mozzarella"),
   then pick the product: size suited to the quantity, available, price per kg/l, promotions.
   best_offer gives the net cost per unit (bundles and loyalty credit included) at the quantity that triggers the offer.
   get_product gives the ingredients (allergens in capitals) and the origin: read it before adding a product
   when a requirement concerns the composition (allergy, diet); labels are not enough.
5. add_to_cart (adds to the existing quantity) or set_quantity (absolute quantity).
   If confirmed is false, read the cart again before retrying.
6. Finish with get_cart (or compare_carts with several retailers) and present a summary:
   products, quantities, total, promotions, missing items, minimum order.
Never place the order: slot booking and payment remain with the user.`;
}

/** Tool result: readable JSON + structured content matching the outputSchema. */
function ok(data: Record<string, unknown>): CallToolResult {
  return { content: [{ text: JSON.stringify(data, null, 2), type: "text" }], structuredContent: data };
}

function failure(error: unknown): CallToolResult {
  const body =
    error instanceof ShopError
      ? { error: error.name, message: error.message, retryable: error.retryable }
      : { error: "InternalError", message: error instanceof Error ? error.message : String(error), retryable: false };
  return { content: [{ text: JSON.stringify(body, null, 2), type: "text" }], isError: true };
}

function handle<A>(fn: (args: A) => Promise<Record<string, unknown>>): (args: A) => Promise<CallToolResult> {
  return async (args) => {
    try {
      return ok(await fn(args));
    } catch (error) {
      return failure(error);
    }
  };
}

export function createServer(registry: StoreRegistry): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: instructions(registry) },
  );
  const site = { openWorldHint: true } as const;
  const store = z.enum(registry.ids).describe("retailer (see list_stores)");
  const productId = z.string().describe("retailer product identifier (id field of search_products)");
  const service = (id: string) => registry.get(id).service;

  server.registerTool(
    "list_stores",
    {
      annotations: { ...site, readOnlyHint: true },
      description:
        "Lists the plugged-in retailers and their capabilities (product page, store selection, minimum order, booked slot). With check: true, also checks that each session responds and shows the active store.",
      inputSchema: { check: z.boolean().default(false).describe("query each site (read-only)") },
      outputSchema: listStoresOutput,
      title: "Available retailers",
    },
    handle(async ({ check }) => presentStores(await listStores(registry, check), check)),
  );

  server.registerTool(
    "search_products",
    {
      annotations: { ...site, readOnlyHint: true },
      description:
        "Searches the retailer's catalogue. For each product: id, label (brand and size included), price, price per kg/l/piece, availability, typed promotions (immediate, multibuy, loyalty) and best net offer.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_SEARCH_LIMIT)
          .default(DEFAULT_SEARCH_LIMIT)
          .describe("maximum number of products"),
        query: z.string().describe('short search term (in French), e.g. "spaghetti", "boeuf haché 5%"'),
        store,
      },
      outputSchema: searchOutput,
      title: "Search products",
    },
    handle(async (a) => presentSearch(a.store, await service(a.store).search(a.query, a.limit))),
  );

  server.registerTool(
    "get_product",
    {
      annotations: { ...site, readOnlyHint: true },
      description:
        "Reads a product page: ingredient list (allergens in capitals, possible traces), allergen statement if the site provides it, and origin. Ingredients are null for a raw product (fruit, fresh meat).",
      inputSchema: { product_id: productId, store },
      outputSchema: productDetailsOutput,
      title: "Product details",
    },
    handle(async (a) =>
      presentProductDetails(a.store, await service(a.store).getProduct(parseProductId(a.product_id))),
    ),
  );

  server.registerTool(
    "get_cart",
    {
      annotations: { ...site, readOnlyHint: true },
      description: "Reads the retailer's actual cart: lines (id, label, quantity, line total, unit price) and total.",
      inputSchema: { store },
      outputSchema: cartOutput,
      title: "Read the cart",
    },
    handle(async (a) => presentCart(a.store, await service(a.store).getCart())),
  );

  server.registerTool(
    "get_order_conditions",
    {
      annotations: { ...site, readOnlyHint: true },
      description:
        "Reads, for one retailer or all of them (store omitted), the selected store, the booked slot, the next pickup and delivery slots (structured dates) and the minimum order. Books nothing.",
      inputSchema: { store: store.optional().describe("retailer; omitted = all of them, one after the other") },
      outputSchema: orderConditionsOutput,
      title: "Order conditions",
    },
    handle(async (a) =>
      presentOrderConditions(
        a.store ? [await statusOf(registry.get(a.store), true)] : await listStores(registry, true),
      ),
    ),
  );

  server.registerTool(
    "add_to_cart",
    {
      annotations: { ...site, idempotentHint: false, readOnlyHint: false },
      description: "Adds units of a product on top of those already present, then reads the cart back to confirm.",
      inputSchema: {
        product_id: productId,
        quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE).default(1).describe("sale units to add"),
        store,
      },
      outputSchema: cartChangeOutput,
      title: "Add to cart",
    },
    handle(async (a) =>
      presentChange(a.store, await service(a.store).add(parseProductId(a.product_id), parseQuantity(a.quantity))),
    ),
  );

  server.registerTool(
    "set_quantity",
    {
      annotations: { ...site, idempotentHint: true, readOnlyHint: false },
      description:
        "Sets a product's quantity in the cart (replaces the current one; 0 removes the product), then reads the cart back.",
      inputSchema: {
        product_id: productId,
        quantity: z.number().int().min(0).max(MAX_QUANTITY_PER_LINE).describe("desired final quantity"),
        store,
      },
      outputSchema: cartChangeOutput,
      title: "Set a quantity",
    },
    handle(async (a) =>
      presentChange(
        a.store,
        await service(a.store).setQuantity(parseProductId(a.product_id), parseQuantity(a.quantity)),
      ),
    ),
  );

  server.registerTool(
    "remove_from_cart",
    {
      annotations: { ...site, destructiveHint: true, idempotentHint: true, readOnlyHint: false },
      description: "Removes a product from the cart entirely, then reads the cart back.",
      inputSchema: { product_id: productId, store },
      outputSchema: cartChangeOutput,
      title: "Remove from cart",
    },
    handle(async (a) => presentChange(a.store, await service(a.store).remove(parseProductId(a.product_id)))),
  );

  server.registerTool(
    "find_stores",
    {
      annotations: { ...site, readOnlyHint: true },
      description:
        "The retailer's stores around a postcode or town, nearest first (if the retailer supports it, see list_stores).",
      inputSchema: { query: z.string().describe('postcode or town, e.g. "75011"'), store },
      outputSchema: findStoresOutput,
      title: "Find a store",
    },
    handle(async (a) => presentLocations(a.store, a.query, await service(a.store).findStores(a.query))),
  );

  server.registerTool(
    "set_store",
    {
      annotations: { ...site, idempotentHint: true, readOnlyHint: false },
      description:
        'Selects the retailer\'s active store among the find_stores results and remembers it. The site session must be on this store: on "session expired", open it on the site.',
      inputSchema: { store, store_id: z.string().describe("id field of find_stores") },
      outputSchema: setStoreOutput,
      title: "Select the store",
    },
    handle(async (a) => presentSelection(a.store, await service(a.store).selectStore(a.store_id))),
  );

  server.registerTool(
    "compare_carts",
    {
      annotations: { ...site, readOnlyHint: true },
      description:
        "Reads each retailer's cart: total, lines, minimum order and missing amount, next slots. Sorted from cheapest to most expensive.",
      inputSchema: { mode: z.enum(["drive", "delivery"]).default("drive").describe("targeted fulfilment mode") },
      outputSchema: compareCartsOutput,
      title: "Compare carts",
    },
    handle(async (a) => presentComparison(await compareCarts(registry, a.mode))),
  );

  return server;
}
