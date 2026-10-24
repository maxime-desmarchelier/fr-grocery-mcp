// Parsers tested on real E.Leclerc Drive pages (test/fixtures/leclerc, `npm run fixtures -- leclerc`).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SessionExpiredError, SiteBlockedError, TransientError, ValidationError } from "../../src/domain/errors.ts";
import { parseProductId } from "../../src/domain/product.ts";
import {
  assertMutationAccepted,
  decodeEntities,
  findWidget,
  parseAutocomplete,
  parseCartPage,
  parseConditionsPage,
  parseCoordinates,
  parseEuroText,
  parseNearby,
  parseProductPage,
  parseSearchPage,
} from "../../src/infrastructure/retailers/leclerc/parsers.ts";
import { fixture as read } from "../support/fake-http.ts";

const fixture = (name: string) => read("leclerc", name);
const TODAY = new Date(2026, 9, 24);
const widget = (suffix: string, options: unknown) =>
  `<script>Utilitaires.widget.initOptions('ctl00${suffix}', ${JSON.stringify(options)});</script>`;
const STORE_PAGE = widget("_pnlCartouchePanier", {
  objCartouchePanier: { lstElements: [{ lstEnfants: [{ objElement: { sType: "Panier", fEstVide: true } }] }] },
});

describe("conversions", () => {
  it("decodes entities in labels", () => {
    assert.equal(decodeEntities("P&#226;tes &amp; Co d&#39;Italie &#x2014;&nbsp;x"), "Pâtes & Co d'Italie — x");
  });

  it("reads a displayed amount", () => {
    assert.equal(parseEuroText("6,43 €"), 643);
    assert.equal(parseEuroText("1 234,56 €"), 123456);
    assert.equal(parseEuroText("gratuit"), null);
    assert.equal(parseEuroText(undefined), null);
  });

  it("extracts a widget's JSON options, strings included", () => {
    const html = widget("_pnlTest", { a: "}{]", b: [1, { c: 'x"y' }] });
    assert.deepEqual(findWidget(html, "_pnlTest"), { a: "}{]", b: [1, { c: 'x"y' }] });
    assert.equal(findWidget(html, "_pnlAbsent"), null);
    assert.throws(() => findWidget("initOptions('x_pnlCut', {\"a\":", "_pnlCut"), TransientError);
    assert.throws(() => findWidget("initOptions('x_pnlBad', {a:1});", "_pnlBad"), TransientError);
  });
});

describe("search page", () => {
  const spaghetti = parseSearchPage(200, fixture("search-spaghetti.html"));
  const chocolat = parseSearchPage(200, fixture("search-chocolat.html"));

  it("reads the products and the reported total (no pagination)", () => {
    assert.equal(spaghetti.products.length, 12);
    assert.equal(spaghetti.total, 38);
    assert.equal(chocolat.total, 642);
  });

  it("reads identifier, decoded label, price, price per kg and availability", () => {
    assert.deepEqual(
      spaghetti.products.find((p) => p.id === "6511"),
      {
        id: "6511",
        name: "Pâtes Spaghetti Turini 1kg",
        price: 134,
        unitPrice: { price: 134, per: "kg" },
        available: true,
        promotions: [],
      },
    );
    for (const p of [...spaghetti.products, ...chocolat.products]) {
      assert.match(p.id, /^\d+$/);
      assert.ok(p.name.length > 0 && !p.name.includes("&#"));
    }
  });

  it("immediate discount: deducted price, struck-through price and discounted price per kg", () => {
    const biscoff = chocolat.products.find((p) => p.id === "313406");
    assert.equal(biscoff?.price, 348);
    assert.deepEqual(biscoff?.unitPrice, { price: 1832, per: "kg" });
    assert.deepEqual(biscoff?.promotions, [
      {
        kind: "immediate",
        label: "Avantage immédiat",
        validUntil: null,
        details: ["Avantage immédiat de 30%"],
        regularPrice: 497,
        mechanic: { type: "percent_off", percent: 30 },
      },
    ]);
  });

  it("multibuy: unit price unchanged, Nth-unit mechanic", () => {
    const lindor = chocolat.products.find((p) => p.id === "10158");
    assert.equal(lindor?.price, 677);
    assert.equal(lindor?.promotions[0]?.kind, "multibuy");
    assert.deepEqual(lindor?.promotions[0]?.mechanic, { type: "nth_percent_off", nth: 3, percent: 100 });
  });

  it("Ticket E.Leclerc: loyalty credit", () => {
    const novi = chocolat.products.find((p) => p.id === "313711");
    assert.equal(novi?.promotions[0]?.kind, "loyalty");
    assert.equal(novi?.promotions[0]?.label, "Ticket E.Leclerc");
    assert.deepEqual(novi?.promotions[0]?.mechanic, { type: "loyalty_percent", percent: 34 });
  });

  it("no result: empty list (the site's suggestions are ignored)", () => {
    assert.deepEqual(parseSearchPage(200, fixture("search-nomatch.html")), { products: [], total: 0 });
  });

  it("product out of stock, without price per kg, element of another type ignored", () => {
    const html =
      STORE_PAGE +
      widget("_pnlElementProduit", {
        objContenu: {
          lstElements: [
            {
              objElement: {
                iIdProduit: 1,
                sType: "Produit",
                sLibelleLigne1: "Bananes",
                nrPVUnitaireTTC: 1.99,
                iQteDisponible: 0,
              },
            },
            { objElement: { iIdProduit: 2, sType: "Publicite" } },
            { objElement: { iIdProduit: 3, sType: "Produit", sUniteMesureTotale: "mt", nrPVParUniteDeMesureTTC: 2 } },
            { objElement: { pasUnProduit: true } },
          ],
        },
      });
    const { products, total } = parseSearchPage(200, html);
    assert.deepEqual(
      products.map((p) => [p.id, p.name, p.price, p.available, p.unitPrice]),
      [
        ["1", "Bananes", 199, false, null],
        ["3", "Product 3", null, false, null],
      ],
    );
    assert.equal(total, 2);
  });

  it("widget with an unexpected format: the site changed", () => {
    assert.throws(
      () => parseSearchPage(200, STORE_PAGE + widget("_pnlElementProduit", { objContenu: 3 })),
      TransientError,
    );
  });
});

describe("cart and conditions", () => {
  const page = fixture("store-page.html");

  it("reads lines, quantities, totals and total of the current cart", () => {
    assert.deepEqual(parseCartPage(200, page), {
      lines: [
        {
          productId: "10933",
          name: "Huile olive Eco+ Extra vierge - 1L",
          quantity: 1,
          lineTotal: 643,
          unitPrice: { price: 643, per: "l" },
        },
      ],
      total: 643,
    });
  });

  it("empty cart, or missing from the page", () => {
    assert.deepEqual(parseCartPage(200, STORE_PAGE), { lines: [], total: null });
    const noCart = widget("_pnlCartouchePanier", { objCartouchePanier: { lstElements: [] } });
    assert.throws(() => parseCartPage(200, noCart), TransientError);
  });

  it("next pickup slot and date attached to the cart, dated", () => {
    assert.deepEqual(parseConditionsPage(200, page, TODAY), {
      nextSlots: [
        {
          mode: "drive",
          slot: { label: "Lundi 26 octobre à 07h00", start: "2026-10-26T07:00", end: null },
          available: true,
          full: false,
        },
      ],
      cartSlot: { label: "Lundi 26 octobre 07h00", start: "2026-10-26T07:00", end: null },
    });
    assert.deepEqual(parseConditionsPage(200, STORE_PAGE, TODAY), {
      nextSlots: [{ mode: "drive", slot: null, available: false, full: false }],
      cartSlot: null,
    });
  });
});

describe("product page", () => {
  const id = (raw: string) => parseProductId(raw);

  it("reads ingredients (prefix removed) and declared allergens", () => {
    assert.deepEqual(parseProductPage(200, fixture("product-barilla.html"), id("7459")), {
      id: "7459",
      name: "Pâtes Barilla Spaghetti n°5 - 500g",
      ingredients: "Semoule de BLÉ dur. Peut contenir des traces de SOJA et de MOUTARDE.",
      allergens: "Contient : céréales contenant du gluten ; Traces de : soja , moutarde ; blé",
      origin: null,
    });
  });

  it("raw product: origin read from the notes, no ingredients", () => {
    const potimarron = parseProductPage(200, fixture("product-potimarron.html"), id("75976"));
    assert.equal(potimarron.ingredients, null);
    assert.equal(potimarron.origin, "FRANCE");
    assert.equal(parseProductPage(200, fixture("product-poulet.html"), id("123563")).allergens, "Contient : poulet");
  });

  it("unknown product: store page without a product sheet, or another product's sheet", () => {
    assert.throws(() => parseProductPage(200, fixture("product-unknown.html"), id("999999999")), ValidationError);
    assert.throws(() => parseProductPage(200, fixture("product-barilla.html"), id("1")), ValidationError);
  });
});

describe("cart change", () => {
  it("accepts a JSON array of events", () => {
    assert.doesNotThrow(() => assertMutationAccepted(200, '[{"sIdUnique":"Panier123456"}]'));
  });

  it("refusal, block, expired session, unexpected response", () => {
    assert.throws(() => assertMutationAccepted(403, ""), SiteBlockedError);
    assert.throws(() => assertMutationAccepted(500, ""), TransientError);
    assert.throws(() => assertMutationAccepted(200, "<p>Votre session a expiré</p>"), SessionExpiredError);
    assert.throws(() => assertMutationAccepted(200, '{"ok":true}'), TransientError);
  });
});

describe("store search", () => {
  it("chains place, coordinates and nearby stores", () => {
    assert.deepEqual(parseAutocomplete(200, fixture("locator-autocomplete.json")), {
      id: "cG9zdGFsX2NvZGU6ZnI6OnpDWi9WNS9EeVBwTmVNcEZWTVk1MmRxaWhNMD0=",
      postalCode: "00000",
    });
    assert.deepEqual(parseCoordinates(200, fixture("locator-coordinates.json")), {
      latitude: 48.8584,
      longitude: 2.2945,
    });
    assert.deepEqual(parseCoordinates(200, '{"coordinates":{"latitude":1,"longitude":2}}'), {
      latitude: 1,
      longitude: 2,
    });
    const stores = parseNearby(200, fixture("locator-nearby.json"));
    assert.deepEqual(stores[0], {
      id: "123456",
      name: "Testville Centre",
      serviceType: "drive",
      distanceKm: 0.1,
      postalCode: "00000",
      retrievalPointId: "123456",
      host: "fd7-courses.leclercdrive.fr",
    });
    const relay = stores.find((s) => s.serviceType === "relay");
    assert.equal(relay?.id, "123459-000582", "walk-in pickup point: delivery point and pickup point");
  });

  it("no place, point without URL, invalid responses", () => {
    assert.equal(parseAutocomplete(200, '{"postalCodes":[]}'), null);
    assert.deepEqual(parseNearby(200, '{"points":[{"noPL":"1","urlSiteCourse":"pas une url"}]}'), []);
    assert.throws(() => parseNearby(403, ""), SiteBlockedError);
    assert.throws(() => parseNearby(502, ""), TransientError);
    assert.throws(() => parseNearby(200, "<html>"), TransientError);
    assert.throws(() => parseNearby(200, '{"points":"?"}'), TransientError);
  });
});

describe("blocking states", () => {
  it("anti-bot: 403, 429, or page without a cart (interstitial)", () => {
    assert.throws(() => parseSearchPage(403, ""), SiteBlockedError);
    assert.throws(() => parseCartPage(429, ""), SiteBlockedError);
    assert.throws(() => parseSearchPage(200, "<html><script src='https://js.datadome.co'></script>"), SiteBlockedError);
  });

  it("expired session and site outage", () => {
    assert.throws(() => parseCartPage(200, "<p>Votre session a expiré</p>"), SessionExpiredError);
    assert.throws(() => parseCartPage(503, ""), TransientError);
  });
});
