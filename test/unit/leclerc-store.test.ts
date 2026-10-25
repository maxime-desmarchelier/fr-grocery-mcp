// Leclerc adapter tested against a fake HTTP client that serves the fixtures and records the requests.

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseQuantity } from "../../src/domain/cart.ts";
import { SiteBlockedError, ValidationError } from "../../src/domain/errors.ts";
import { parseProductId } from "../../src/domain/product.ts";
import type { HttpRequest, HttpResponse } from "../../src/infrastructure/http/page-http.ts";
import { LeclercStore } from "../../src/infrastructure/retailers/leclerc/leclerc-store.ts";
import { FileSelection, MemorySelection } from "../../src/infrastructure/retailers/leclerc/selection.ts";
import { FakeHttp, ok } from "../support/fake-http.ts";
import { leclercSite } from "../support/fake-sites.ts";

const TESTVILLE = {
  host: "fd7-courses.leclercdrive.fr",
  name: "Testville",
  retrievalPointId: "123456",
  storeId: "123456",
};
const BASE = "/magasin-123456-123456";

function setup(routes: (url: string, init: HttpRequest | undefined) => HttpResponse, clock = { now: 0 }) {
  const http = new FakeHttp(routes);
  const origins: [string, string][] = [];
  const selection = new MemorySelection(TESTVILLE);
  const store = new LeclercStore({
    http: (origin, home) => {
      origins.push([origin, home]);
      return http;
    },
    now: () => new Date(2026, 9, 24, 12, 0, 0, clock.now),
    selection,
  });
  return { clock, http, origins, selection, store };
}

const site = leclercSite;

describe("LeclercStore", () => {
  it("search: encodes the term on the store page, stops at the limit", async () => {
    const { http, origins, store } = setup(site);
    const result = await store.search("pâtes & co", 5);
    assert.equal(result.products.length, 5);
    assert.equal(result.total, 38);
    assert.deepEqual(http.urls, [`${BASE}/recherche.aspx?TexteRecherche=p%C3%A2tes%20%26%20co`]);
    assert.deepEqual(origins[0], ["https://fd7-courses.leclercdrive.fr", `${BASE}/recherche.aspx`]);
  });

  it("product page, cart and conditions: GET on the store pages", async () => {
    const { http, store } = setup(site);
    assert.match((await store.getProduct(parseProductId("7459"))).ingredients ?? "", /BLÉ/);
    assert.equal((await store.getCart()).total, 643);
    const conditions = await store.getOrderConditions();
    assert.equal(conditions.store, "Testville");
    assert.equal(conditions.minimumOrders, null, "not exposed when logged out");
    assert.equal(conditions.bookedSlot, null);
    assert.equal(conditions.cartSlot?.start, "2026-10-26T07:00");
    assert.deepEqual(http.urls, [
      `${BASE}/fiche-produits-7459-produit.aspx`,
      `${BASE}/recherche.aspx`,
      `${BASE}/recherche.aspx`,
    ]);
    assert.ok(http.requests.every((r) => r.init === undefined));
  });

  it("store without a name: identifier shown", async () => {
    const { store, selection } = setup(site);
    selection.save({ ...TESTVILLE, name: undefined });
    assert.equal((await store.getOrderConditions()).store, "store 123456");
  });

  it("quantity: action 1 to increase, absolute final quantity, on the delivery point", async () => {
    const { http, store } = setup(site);
    await store.setQuantity(parseProductId("10933"), parseQuantity(3));
    const [cart, post] = http.requests;
    assert.equal(cart?.url, `${BASE}/recherche.aspx`, "current quantity read first");
    assert.equal(post?.url, `${BASE}/panier.aspx?op=1`);
    assert.equal(post?.init?.method, "POST");
    const body = new URLSearchParams(post?.init?.body);
    assert.deepEqual(JSON.parse(body.get("d") ?? ""), {
      eTypeAction: 1,
      iIdProduit: "10933",
      iQuantite: 3,
      sNoPointLivraison: "123456",
    });
  });

  it("quantity: action 2 to decrease or remove; nothing to do if already at the right quantity", async () => {
    const { http, store } = setup(site);
    await store.setQuantity(parseProductId("10933"), parseQuantity(0));
    const post = http.requests.find((r) => r.init?.method === "POST");
    assert.deepEqual(JSON.parse(new URLSearchParams(post?.init?.body).get("d") ?? ""), {
      eTypeAction: 2,
      iIdProduit: "10933",
      iQuantite: 0,
      sNoPointLivraison: "123456",
    });
    await store.getCart();
    const before = http.requests.length;
    await store.setQuantity(parseProductId("10933"), parseQuantity(1));
    assert.equal(http.requests.length, before, "fresh cart already at 1: no request");
  });

  it("quantity: reuses a cart read less than 15 s ago, reads again beyond that or after a change", async () => {
    const { http, store, clock } = setup(site);
    await store.getCart();
    await store.setQuantity(parseProductId("42"), parseQuantity(1));
    assert.deepEqual(
      http.requests.map((r) => r.init?.method ?? "GET"),
      ["GET", "POST"],
    );
    await store.setQuantity(parseProductId("42"), parseQuantity(2));
    assert.deepEqual(
      http.requests.map((r) => r.init?.method ?? "GET"),
      ["GET", "POST", "GET", "POST"],
      "cart read again after the previous change",
    );
    await store.getCart();
    clock.now = 20_000;
    await store.setQuantity(parseProductId("42"), parseQuantity(1));
    assert.equal(http.requests.at(-2)?.init, undefined, "cart too old: read again");
  });

  it("quantity: anti-bot block and non-numeric identifier", async () => {
    const { store } = setup((url, init) => (init?.method === "POST" ? { body: "", status: 403 } : site(url, init)));
    await assert.rejects(store.setQuantity(parseProductId("1"), parseQuantity(1)), SiteBlockedError);
    await assert.rejects(store.setQuantity(parseProductId("abc"), parseQuantity(1)), ValidationError);
    await assert.rejects(store.getProduct(parseProductId("abc")), ValidationError);
  });

  it("stores: locator API from www.leclercdrive.fr, then remembered choice", async () => {
    const { http, origins, store, selection } = setup(site);
    const found = await store.findStores("00000");
    assert.equal(found.length, 6);
    assert.deepEqual(found[1], {
      distanceKm: 0.2,
      id: "123457",
      name: "Testville North",
      postalCode: "00000",
      serviceType: "drive",
    });
    assert.ok(origins.some(([origin]) => origin === "https://www.leclercdrive.fr"));
    assert.match(http.urls[2] ?? "", /MapPoint\/nearby\?latitude=48.871769&longitude=2.180201&postalCode=00000$/);

    await store.selectStore("123459-000582");
    assert.deepEqual(selection.current(), {
      host: "fd4-courses.leclercdrive.fr",
      name: "Relais Un",
      retrievalPointId: "000582",
      storeId: "123459",
    });
    await store.getCart();
    assert.equal(http.urls.at(-1), "/magasin-123459-000582/recherche.aspx");
    assert.equal(origins.at(-1)?.[0], "https://fd4-courses.leclercdrive.fr");
    await assert.rejects(store.selectStore("999999"), ValidationError);
  });

  it("stores: no place found", async () => {
    const { store } = setup(() => ok('{"postalCodes":[]}'));
    assert.deepEqual(await store.findStores("zzz"), []);
  });
});

describe("FileSelection", () => {
  it("default configuration, then choice persisted and read back", () => {
    const path = join(mkdtempSync(join(tmpdir(), "courses-")), "state", "leclerc-store.json");
    const first = new FileSelection(path, TESTVILLE);
    assert.deepEqual(first.current(), TESTVILLE);
    const other = { ...TESTVILLE, retrievalPointId: "123457", storeId: "123457" };
    first.save(other);
    assert.deepEqual(new FileSelection(path, TESTVILLE).current(), other);
    assert.throws(() => first.save({ ...TESTVILLE, host: "evil.example" }));
  });

  it("corrupt or invalid file: configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "courses-"));
    const path = join(dir, "leclerc-store.json");
    writeFileSync(path, "{");
    assert.deepEqual(new FileSelection(path, TESTVILLE).current(), TESTVILLE);
    writeFileSync(path, JSON.stringify({ storeId: "x" }));
    assert.deepEqual(new FileSelection(path, TESTVILLE).current(), TESTVILLE);
    assert.equal(readFileSync(path, "utf8"), '{"storeId":"x"}');
  });
});
