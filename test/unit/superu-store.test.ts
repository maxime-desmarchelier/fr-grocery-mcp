// Super U adapter tested against a fake HTTP client that serves the fixtures and records the requests.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseQuantity } from "../../src/domain/cart.ts";
import { NotSupportedError, SiteBlockedError, TransientError, ValidationError } from "../../src/domain/errors.ts";
import { parseProductId } from "../../src/domain/product.ts";
import { SuperUStore } from "../../src/infrastructure/retailers/superu/superu-store.ts";
import { FakeHttp, ok, fixture as read } from "../support/fake-http.ts";

const fixture = (name: string) => read("superu", name);

describe("SuperUStore", () => {
  it("search: encodes the term and stops at the limit", async () => {
    const http = new FakeHttp(() => ok(fixture("search-spaghetti.html")));
    const result = await new SuperUStore(http).search("pâtes & co", 5);
    assert.equal(result.products.length, 5);
    assert.equal(result.total, 44);
    assert.deepEqual(http.urls, ["/recherche?q=p%C3%A2tes%20%26%20co"]);
  });

  it("search: pages by 18 up to the limit, without duplicates", async () => {
    const page = fixture("search-spaghetti.html");
    const http = new FakeHttp((path) => (path.includes("start=36") ? ok("<html></html>") : ok(page)));
    const result = await new SuperUStore(http).search("spaghetti", 40);
    // Pages 1 and 2 of the fixture are identical: duplicates are merged, then an empty page.
    assert.equal(result.products.length, 18);
    assert.deepEqual(http.urls, [
      "/recherche?q=spaghetti",
      "/recherche?q=spaghetti&start=18",
      "/recherche?q=spaghetti&start=36",
    ]);
  });

  it("product page: GET on the identifier, the URL label does not matter", async () => {
    const http = new FakeHttp(() => ok(fixture("product-pesto.html")));
    const details = await new SuperUStore(http).getProduct(parseProductId("3870987"));
    assert.match(details.ingredients ?? "", /LAIT/);
    assert.deepEqual(
      http.requests.map((r) => [r.url, r.init]),
      [["/p/produit/3870987.html", undefined]],
    );
  });

  it("cart: lines and total", async () => {
    const cart = await new SuperUStore(new FakeHttp(() => ok(fixture("cart.html")))).getCart();
    assert.equal(cart.lines.length, 4);
    assert.equal(cart.total, 6178);
  });

  it("order conditions: slot banner and cart minimum, read-only", async () => {
    const http = new FakeHttp((path) =>
      path === "/panier" ? ok(fixture("cart.html")) : ok(fixture("slot-info.html")),
    );
    const conditions = await new SuperUStore(http, { today: () => new Date(2026, 9, 24) }).getOrderConditions();
    assert.equal(conditions.store, "super u ville test");
    assert.deepEqual(conditions.bookedSlot, {
      label: "Dim. 25/10 de 08h30 à 09h00",
      start: "2026-10-25T08:30",
      end: "2026-10-25T09:00",
    });
    assert.equal(conditions.cartSlot, null);
    assert.deepEqual(conditions.minimumOrders, [
      { mode: "drive", amount: 5000 },
      { mode: "delivery", amount: 5000 },
    ]);
    assert.match(http.requests[0]?.url ?? "", /Home-IncludeNavigationSlotTimeInfo$/);
    assert.ok(
      http.requests.every((r) => r.init === undefined),
      "GET requests only",
    );
  });

  it("quantity: fetches the CSRF token then posts the site's form", async () => {
    const http = new FakeHttp((path) => (path === "/panier" ? ok(fixture("cart.html")) : ok("{}")));
    await new SuperUStore(http).setQuantity(parseProductId("960853"), parseQuantity(3));
    const [cart, post] = http.requests;
    assert.equal(cart?.url, "/panier");
    assert.match(post?.url ?? "", /Cart-AddProduct\?format=ajax$/);
    assert.equal(post?.init?.method, "POST");
    const form = new URLSearchParams(post?.init?.body);
    assert.equal(form.get("pid"), "960853");
    assert.equal(form.get("Quantity"), "3");
    assert.equal(form.get("update"), "true");
    assert.equal(form.get("csrf_token"), "FIXTURE_CSRF");
  });

  it("quantity: reuses the token read during a search", async () => {
    const http = new FakeHttp((path) =>
      path.startsWith("/recherche") ? ok(fixture("search-spaghetti.html")) : ok(""),
    );
    const store = new SuperUStore(http);
    await store.search("spaghetti", 1);
    await store.setQuantity(parseProductId("960853"), parseQuantity(0));
    assert.equal(http.requests.length, 2, "no extra cart read");
  });

  it("quantity: HTTP refusal -> transient error and token read again on the next attempt", async () => {
    let posts = 0;
    const http = new FakeHttp((path) => {
      if (path === "/panier") return ok(fixture("cart.html"));
      posts++;
      return { status: 500, body: "" };
    });
    const store = new SuperUStore(http);
    await assert.rejects(store.setQuantity(parseProductId("1"), parseQuantity(1)), TransientError);
    await assert.rejects(store.setQuantity(parseProductId("1"), parseQuantity(1)), TransientError);
    assert.equal(posts, 2);
    assert.equal(http.requests.filter((r) => r.url === "/panier").length, 2);
  });

  it("quantity: anti-bot block", async () => {
    const http = new FakeHttp((path) => (path === "/panier" ? ok(fixture("cart.html")) : { status: 403, body: "" }));
    await assert.rejects(new SuperUStore(http).setQuantity(parseProductId("1"), parseQuantity(1)), SiteBlockedError);
  });

  it("quantity: no CSRF token available", async () => {
    const http = new FakeHttp(() => ok("<h1>Mon panier</h1>"));
    await assert.rejects(new SuperUStore(http).setQuantity(parseProductId("1"), parseQuantity(1)), TransientError);
  });

  it("non-numeric identifier rejected before any request", async () => {
    const http = new FakeHttp(() => ok(""));
    const store = new SuperUStore(http);
    await assert.rejects(store.getProduct(parseProductId("abc")), ValidationError);
    await assert.rejects(store.setQuantity(parseProductId("abc"), parseQuantity(1)), ValidationError);
    assert.deepEqual(http.requests, []);
  });

  it("the store is chosen on the site: store search not supported", async () => {
    const store = new SuperUStore(new FakeHttp(() => ok("")));
    assert.equal(store.capabilities.storeLocator, false);
    await assert.rejects(store.findStores(), NotSupportedError);
    await assert.rejects(store.selectStore(), NotSupportedError);
  });
});
