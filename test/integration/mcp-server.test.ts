// MCP server tested end to end with a real MCP client:
//  - in memory, on two simulated retailers ("recipe -> cart" flow, comparison);
//  - on the real adapters plugged into sites simulated by the fixtures (production wiring);
//  - as a stdio subprocess, as launched by Claude Code (initialization and tool list).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ShoppingService } from "../../src/application/shopping-service.ts";
import { StoreRegistry } from "../../src/application/store-registry.ts";
import { buildRegistry } from "../../src/composition.ts";
import { loadConfig } from "../../src/config.ts";
import { fromCents } from "../../src/domain/money.ts";
import type { OrderConditions } from "../../src/domain/order-conditions.ts";
import { MemorySelection } from "../../src/infrastructure/retailers/leclerc/selection.ts";
import { InMemoryStore } from "../../src/infrastructure/retailers/memory/in-memory-store.ts";
import { createServer, SERVER_NAME, SERVER_VERSION } from "../../src/interface/mcp/server.ts";
import { BOEUF, CATALOGUE, SPAGHETTI } from "../support/catalogue.ts";
import { FakeHttp } from "../support/fake-http.ts";
import { leclercSite, superuSite } from "../support/fake-sites.ts";

const TOOLS = [
  "add_to_cart",
  "compare_carts",
  "find_stores",
  "get_cart",
  "get_order_conditions",
  "get_product",
  "list_stores",
  "remove_from_cart",
  "search_products",
  "set_quantity",
  "set_store",
];

const CONDITIONS: OrderConditions = {
  bookedSlot: { end: "2026-10-25T09:00", label: "Dim. 25/10 de 08h30 à 09h00", start: "2026-10-25T08:30" },
  cartSlot: null,
  minimumOrders: [{ amount: fromCents(5000), mode: "drive" }],
  nextSlots: [
    {
      available: true,
      full: false,
      mode: "drive",
      slot: { end: null, label: "Dimanche 25 octobre à 08h00", start: "2026-10-25T08:00" },
    },
  ],
  store: "super u ville test",
};

function simulated() {
  const superu = new InMemoryStore(CATALOGUE, {
    conditions: CONDITIONS,
    details: new Map([[SPAGHETTI.id, { ingredients: "Semoule de blé dur (GLUTEN).", origin: "France" }]]),
  });
  const leclerc = new InMemoryStore(CATALOGUE, {
    locations: [{ distanceKm: 1, id: "123456", name: "Testville", postalCode: "00000", serviceType: "drive" }],
  });
  const service = (store: InMemoryStore) => new ShoppingService(store, { sleep: async () => {} });
  const registry = new StoreRegistry([
    { id: "leclerc", name: "E.Leclerc Drive", service: service(leclerc) },
    { id: "superu", name: "Super U", service: service(superu) },
  ]);
  return { leclerc, registry, superu };
}

async function connect(registry: StoreRegistry) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(registry).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ arguments: args, name })) as CallToolResult;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    // biome-ignore lint/suspicious/noExplicitAny: free-form reading of JSON results in assertions
    return { data: JSON.parse(text) as any, result };
  };
  return { call, client };
}

describe("MCP server (simulated retailers)", () => {
  it("announces its instructions and annotated tools, without order placement", async () => {
    const { client } = await connect(simulated().registry);
    assert.match(client.getInstructions() ?? "", /leclerc \(E\.Leclerc Drive\), superu \(Super U\)/);
    assert.match(client.getInstructions() ?? "", /Never place the order/);
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
    for (const tool of tools) {
      assert.ok(tool.outputSchema, `${tool.name} declares an outputSchema`);
      assert.equal(tool.annotations?.openWorldHint, true);
    }
    const readOnly = [
      "compare_carts",
      "find_stores",
      "get_cart",
      "get_order_conditions",
      "get_product",
      "list_stores",
      "search_products",
    ];
    for (const name of readOnly)
      assert.equal(tools.find((t) => t.name === name)?.annotations?.readOnlyHint, true, name);
    assert.equal(tools.find((t) => t.name === "remove_from_cart")?.annotations?.destructiveHint, true);
    const search = tools.find((t) => t.name === "search_products");
    const storeInput = search?.inputSchema.properties?.["store"] as { enum?: string[] } | undefined;
    assert.deepEqual(storeInput?.enum, ["leclerc", "superu"]);
    await client.close();
  });

  it('"spaghetti bolognese for 4" flow on one retailer: search, additions, adjustment, removal', async () => {
    const { client, call } = await connect(simulated().registry);

    const pates = await call("search_products", { query: "spaghetti", store: "superu" });
    assert.deepEqual(pates.result.structuredContent, pates.data, "text and structured content match");
    assert.equal(pates.data.store, "superu");
    assert.equal(pates.data.products[0].price_eur, 0.95);
    assert.deepEqual(pates.data.products[0].unit_price, { eur: 1.9, per: "kg" });
    assert.equal(pates.data.products[0].best_offer, null, "no promotion: no offer");

    const mozza = await call("search_products", { query: "mozzarella", store: "superu" });
    assert.equal(mozza.data.products[0].available, false, "the agent sees the shortage before adding");

    await call("add_to_cart", { product_id: "960853", quantity: 1, store: "superu" });
    let r = await call("add_to_cart", { product_id: "960853", store: "superu" });
    assert.equal(r.data.expected_quantity, 2);
    assert.equal(r.data.confirmed, true);

    await call("add_to_cart", { product_id: "2307081", quantity: 2, store: "superu" });
    r = await call("set_quantity", { product_id: "2307081", quantity: 1, store: "superu" });
    assert.equal(r.data.line.quantity, 1);

    const cart = await call("get_cart", { store: "superu" });
    assert.equal(cart.data.total_eur, 10.89, "0,95 × 2 + 8,99");
    assert.deepEqual((await call("get_cart", { store: "leclerc" })).data.lines, [], "separate carts");

    r = await call("remove_from_cart", { product_id: "2307081", store: "superu" });
    assert.equal(r.data.line, null);
    await client.close();
  });

  it("conditions: one retailer or all, dated slots and minimum in euros", async () => {
    const { client, call } = await connect(simulated().registry);
    const one = await call("get_order_conditions", { store: "superu" });
    assert.deepEqual(one.result.structuredContent, one.data);
    assert.deepEqual(one.data.stores, [
      {
        conditions: {
          booked_slot: { end: "2026-10-25T09:00", label: "Dim. 25/10 de 08h30 à 09h00", start: "2026-10-25T08:30" },
          cart_slot: null,
          minimum_orders: [{ eur: 50, mode: "drive" }],
          next_slots: [
            {
              available: true,
              full: false,
              mode: "drive",
              slot: { end: null, label: "Dimanche 25 octobre à 08h00", start: "2026-10-25T08:00" },
            },
          ],
          store: "super u ville test",
        },
        failure: null,
        name: "Super U",
        store: "superu",
      },
    ]);
    const all = await call("get_order_conditions");
    assert.deepEqual(
      all.data.stores.map((s: { store: string }) => s.store),
      ["leclerc", "superu"],
    );
    assert.equal(all.data.stores[0].conditions.minimum_orders, null);
    await client.close();
  });

  it("list_stores, find_stores, set_store, compare_carts", async () => {
    const { registry, leclerc } = simulated();
    const { client, call } = await connect(registry);

    const quick = await call("list_stores");
    assert.deepEqual(quick.data.stores[0], {
      capabilities: { booked_slot: true, minimum_order: false, product_details: true, store_locator: true },
      current_store: null,
      failure: null,
      name: "E.Leclerc Drive",
      session_ok: null,
      store: "leclerc",
    });
    const checked = await call("list_stores", { check: true });
    assert.equal(checked.data.stores[1].session_ok, true);
    assert.equal(checked.data.stores[1].current_store, "super u ville test");

    const found = await call("find_stores", { query: "00000", store: "leclerc" });
    assert.deepEqual(found.data.locations, [
      { distance_km: 1, id: "123456", name: "Testville", postal_code: "00000", service_type: "drive" },
    ]);
    const set = await call("set_store", { store: "leclerc", store_id: "123456" });
    assert.equal(set.data.selected.name, "Testville");
    assert.equal(leclerc.selected?.id, "123456");
    const unsupported = await call("find_stores", { query: "00000", store: "superu" });
    assert.equal(unsupported.data.error, "NotSupportedError");

    await call("add_to_cart", { product_id: BOEUF.id, store: "leclerc" });
    await call("add_to_cart", { product_id: SPAGHETTI.id, quantity: 3, store: "superu" });
    const comparison = await call("compare_carts");
    assert.deepEqual(comparison.result.structuredContent, comparison.data);
    assert.equal(comparison.data.cheapest, "superu");
    assert.deepEqual(
      comparison.data.stores.map((s: { store: string; total_eur: number; missing_to_minimum_eur: number | null }) => [
        s.store,
        s.total_eur,
        s.missing_to_minimum_eur,
      ]),
      [
        ["superu", 2.85, 47.15],
        ["leclerc", 8.99, null],
      ],
    );
    assert.equal(comparison.data.stores[0].lines[0].quantity, 3);
    await client.close();
  });

  it("product page: ingredients and origin, null for a raw product", async () => {
    const { client, call } = await connect(simulated().registry);
    const pasta = await call("get_product", { product_id: SPAGHETTI.id, store: "superu" });
    assert.deepEqual(pasta.data, {
      allergens: null,
      id: "960853",
      ingredients: "Semoule de blé dur (GLUTEN).",
      name: SPAGHETTI.name,
      origin: "France",
      store: "superu",
    });
    assert.equal((await call("get_product", { product_id: BOEUF.id, store: "superu" })).data.ingredients, null);
    await client.close();
  });

  it("errors: unknown retailer, invalid input, unknown product, expired session", async () => {
    const { registry, superu } = simulated();
    const { client, call } = await connect(registry);

    const unknownStore = await client.callTool({ arguments: { store: "carrefour" }, name: "get_cart" });
    assert.equal(unknownStore.isError, true, "retailer refused by the input schema");

    const badId = await call("add_to_cart", { product_id: "../panier", store: "superu" });
    assert.equal(badId.data.error, "ValidationError");

    const tooMany = await client.callTool({
      arguments: { product_id: "960853", quantity: 500, store: "superu" },
      name: "set_quantity",
    });
    assert.equal(tooMany.isError, true, "cap refused by the input schema");

    assert.equal((await call("add_to_cart", { product_id: "123", store: "superu" })).data.error, "ValidationError");

    superu.expired = true;
    const expired = await call("get_cart", { store: "superu" });
    assert.equal(expired.result.isError, true);
    assert.deepEqual(expired.data, {
      error: "SessionExpiredError",
      message: "Simulated store session expired: log in again on the site in Chrome, then retry.",
      retryable: false,
    });
    const status = await call("list_stores", { check: true });
    assert.equal(status.data.stores[1].session_ok, false, "a failing retailer does not prevent listing the others");
    assert.equal(status.data.stores[0].session_ok, true);
    await client.close();
  });
});

describe("MCP server (real adapters, simulated sites)", () => {
  it("wires Super U and Leclerc from the configuration and passes promotions through to the agent", async () => {
    const config = loadConfig({ FR_GROCERY_CONFIG: "/c.json" }, () =>
      JSON.stringify({
        stores: [
          {
            retailer: "leclerc",
            store: {
              host: "fd7-courses.leclercdrive.fr",
              name: "Testville",
              retrievalPointId: "123456",
              storeId: "123456",
            },
          },
          { retailer: "superu" },
        ],
      }),
    );
    const http = (origin: string) => new FakeHttp(origin.includes("coursesu") ? superuSite : leclercSite);
    const registry = buildRegistry(config, http, {
      selection: (fallback) => new MemorySelection(fallback),
      service: { sleep: async () => {} },
      unthrottled: true,
    });
    const { client, call } = await connect(registry);

    const lessive = await call("search_products", { limit: 18, query: "spaghetti", store: "superu" });
    const carteU = lessive.data.products.find((p: { id: string }) => p.id === "1177214");
    assert.equal(carteU.promotions[0].kind, "loyalty");
    assert.deepEqual(carteU.promotions[0].mechanic, {
      amount_eur: 0.27,
      nth: null,
      percent: null,
      type: "loyalty_amount",
    });
    assert.ok(carteU.best_offer.net_unit_price_eur < carteU.price_eur);

    const conditions = await call("get_order_conditions", { store: "leclerc" });
    assert.equal(conditions.data.stores[0].conditions.cart_slot.start.slice(5), "10-26T07:00");

    const comparison = await call("compare_carts");
    assert.deepEqual(
      comparison.data.stores.map((s: { store: string }) => s.store),
      ["leclerc", "superu"],
      "6,43 € chez Leclerc, 61,78 € chez Super U",
    );
    await client.close();
  });
});

describe("MCP server (stdio)", () => {
  it("starts as launched by a client and lists its tools without touching the sites", async () => {
    const client = new Client({ name: "test", version: "0" });
    try {
      await client.connect(
        new StdioClientTransport({
          args: [fileURLToPath(new URL("../../src/main.ts", import.meta.url))],
          command: process.execPath,
          stderr: "inherit",
        }),
      );
      assert.equal(client.getServerVersion()?.name, SERVER_NAME);
      const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
        version: string;
      };
      assert.equal(SERVER_VERSION, pkg.version, "server version aligned with package.json");
      const { tools } = await client.listTools();
      assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
    } finally {
      await client.close();
    }
  });
});
