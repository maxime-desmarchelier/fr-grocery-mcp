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
  store: "super u ville test",
  bookedSlot: { label: "Dim. 25/10 de 08h30 à 09h00", start: "2026-10-25T08:30", end: "2026-10-25T09:00" },
  cartSlot: null,
  nextSlots: [
    {
      mode: "drive",
      slot: { label: "Dimanche 25 octobre à 08h00", start: "2026-10-25T08:00", end: null },
      available: true,
      full: false,
    },
  ],
  minimumOrders: [{ mode: "drive", amount: fromCents(5000) }],
};

function simulated() {
  const superu = new InMemoryStore(CATALOGUE, {
    conditions: CONDITIONS,
    details: new Map([[SPAGHETTI.id, { ingredients: "Semoule de blé dur (GLUTEN).", origin: "France" }]]),
  });
  const leclerc = new InMemoryStore(CATALOGUE, {
    locations: [{ id: "123456", name: "Testville", serviceType: "drive", distanceKm: 1, postalCode: "00000" }],
  });
  const service = (store: InMemoryStore) => new ShoppingService(store, { sleep: async () => {} });
  const registry = new StoreRegistry([
    { id: "leclerc", name: "E.Leclerc Drive", service: service(leclerc) },
    { id: "superu", name: "Super U", service: service(superu) },
  ]);
  return { registry, superu, leclerc };
}

async function connect(registry: StoreRegistry) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer(registry).connect(serverSide);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(clientSide);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content[0]?.type === "text" ? result.content[0].text : "";
    // biome-ignore lint/suspicious/noExplicitAny: free-form reading of JSON results in assertions
    return { result, data: JSON.parse(text) as any };
  };
  return { client, call };
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

    const pates = await call("search_products", { store: "superu", query: "spaghetti" });
    assert.deepEqual(pates.result.structuredContent, pates.data, "text and structured content match");
    assert.equal(pates.data.store, "superu");
    assert.equal(pates.data.products[0].price_eur, 0.95);
    assert.deepEqual(pates.data.products[0].unit_price, { eur: 1.9, per: "kg" });
    assert.equal(pates.data.products[0].best_offer, null, "no promotion: no offer");

    const mozza = await call("search_products", { store: "superu", query: "mozzarella" });
    assert.equal(mozza.data.products[0].available, false, "the agent sees the shortage before adding");

    await call("add_to_cart", { store: "superu", product_id: "960853", quantity: 1 });
    let r = await call("add_to_cart", { store: "superu", product_id: "960853" });
    assert.equal(r.data.expected_quantity, 2);
    assert.equal(r.data.confirmed, true);

    await call("add_to_cart", { store: "superu", product_id: "2307081", quantity: 2 });
    r = await call("set_quantity", { store: "superu", product_id: "2307081", quantity: 1 });
    assert.equal(r.data.line.quantity, 1);

    const cart = await call("get_cart", { store: "superu" });
    assert.equal(cart.data.total_eur, 10.89, "0,95 × 2 + 8,99");
    assert.deepEqual((await call("get_cart", { store: "leclerc" })).data.lines, [], "separate carts");

    r = await call("remove_from_cart", { store: "superu", product_id: "2307081" });
    assert.equal(r.data.line, null);
    await client.close();
  });

  it("conditions: one retailer or all, dated slots and minimum in euros", async () => {
    const { client, call } = await connect(simulated().registry);
    const one = await call("get_order_conditions", { store: "superu" });
    assert.deepEqual(one.result.structuredContent, one.data);
    assert.deepEqual(one.data.stores, [
      {
        store: "superu",
        name: "Super U",
        conditions: {
          store: "super u ville test",
          booked_slot: { label: "Dim. 25/10 de 08h30 à 09h00", start: "2026-10-25T08:30", end: "2026-10-25T09:00" },
          cart_slot: null,
          next_slots: [
            {
              mode: "drive",
              slot: { label: "Dimanche 25 octobre à 08h00", start: "2026-10-25T08:00", end: null },
              available: true,
              full: false,
            },
          ],
          minimum_orders: [{ mode: "drive", eur: 50 }],
        },
        failure: null,
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
      store: "leclerc",
      name: "E.Leclerc Drive",
      capabilities: { product_details: true, store_locator: true, minimum_order: false, booked_slot: true },
      session_ok: null,
      current_store: null,
      failure: null,
    });
    const checked = await call("list_stores", { check: true });
    assert.equal(checked.data.stores[1].session_ok, true);
    assert.equal(checked.data.stores[1].current_store, "super u ville test");

    const found = await call("find_stores", { store: "leclerc", query: "00000" });
    assert.deepEqual(found.data.locations, [
      { id: "123456", name: "Testville", service_type: "drive", distance_km: 1, postal_code: "00000" },
    ]);
    const set = await call("set_store", { store: "leclerc", store_id: "123456" });
    assert.equal(set.data.selected.name, "Testville");
    assert.equal(leclerc.selected?.id, "123456");
    const unsupported = await call("find_stores", { store: "superu", query: "00000" });
    assert.equal(unsupported.data.error, "NotSupportedError");

    await call("add_to_cart", { store: "leclerc", product_id: BOEUF.id });
    await call("add_to_cart", { store: "superu", product_id: SPAGHETTI.id, quantity: 3 });
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
    const pasta = await call("get_product", { store: "superu", product_id: SPAGHETTI.id });
    assert.deepEqual(pasta.data, {
      store: "superu",
      id: "960853",
      name: SPAGHETTI.name,
      ingredients: "Semoule de blé dur (GLUTEN).",
      allergens: null,
      origin: "France",
    });
    assert.equal((await call("get_product", { store: "superu", product_id: BOEUF.id })).data.ingredients, null);
    await client.close();
  });

  it("errors: unknown retailer, invalid input, unknown product, expired session", async () => {
    const { registry, superu } = simulated();
    const { client, call } = await connect(registry);

    const unknownStore = await client.callTool({ name: "get_cart", arguments: { store: "carrefour" } });
    assert.equal(unknownStore.isError, true, "retailer refused by the input schema");

    const badId = await call("add_to_cart", { store: "superu", product_id: "../panier" });
    assert.equal(badId.data.error, "ValidationError");

    const tooMany = await client.callTool({
      name: "set_quantity",
      arguments: { store: "superu", product_id: "960853", quantity: 500 },
    });
    assert.equal(tooMany.isError, true, "cap refused by the input schema");

    assert.equal((await call("add_to_cart", { store: "superu", product_id: "123" })).data.error, "ValidationError");

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
              storeId: "123456",
              retrievalPointId: "123456",
              host: "fd7-courses.leclercdrive.fr",
              name: "Testville",
            },
          },
          { retailer: "superu" },
        ],
      }),
    );
    const http = (origin: string) => new FakeHttp(origin.includes("coursesu") ? superuSite : leclercSite);
    const registry = buildRegistry(config, http, {
      unthrottled: true,
      service: { sleep: async () => {} },
      selection: (fallback) => new MemorySelection(fallback),
    });
    const { client, call } = await connect(registry);

    const lessive = await call("search_products", { store: "superu", query: "spaghetti", limit: 18 });
    const carteU = lessive.data.products.find((p: { id: string }) => p.id === "1177214");
    assert.equal(carteU.promotions[0].kind, "loyalty");
    assert.deepEqual(carteU.promotions[0].mechanic, {
      type: "loyalty_amount",
      nth: null,
      percent: null,
      amount_eur: 0.27,
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
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [fileURLToPath(new URL("../../src/main.ts", import.meta.url))],
        stderr: "ignore",
      }),
    );
    assert.equal(client.getServerVersion()?.name, SERVER_NAME);
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
    assert.equal(SERVER_VERSION, pkg.version, "server version aligned with package.json");
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), TOOLS);
    await client.close();
  });
});
