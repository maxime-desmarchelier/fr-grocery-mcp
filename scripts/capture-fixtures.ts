// Captures real retailer pages for the parser tests (read-only).
// Usage: npm run fixtures -- <superu|leclerc> [<name fragment>…]   (debugging Chrome logged in to the sites)
// With fragments, only the pages whose file name contains one of them are captured again.
// Warning: cart pages reflect the user's actual cart (the tests depend on it): use a test cart.
//
// Pages are reduced to what the parsers read: HTML nodes (Super U) or widget JSON options
// (Leclerc). Scripts, images and session tokens are removed: no session data is kept.

import { writeFile } from "node:fs/promises";
import { DOMParser } from "linkedom";
import { loadConfig } from "../src/config.ts";
import { CdpBrowser } from "../src/infrastructure/browser/cdp-browser.ts";
import type { PageHttp } from "../src/infrastructure/http/page-http.ts";
import { LOCATOR_ORIGIN } from "../src/infrastructure/retailers/leclerc/leclerc-store.ts";
import { findWidget } from "../src/infrastructure/retailers/leclerc/parsers.ts";
import { SUPERU_HOME_PATH, SUPERU_ORIGIN } from "../src/infrastructure/retailers/superu/superu-store.ts";

const today = new Date().toISOString().slice(0, 10);

const PRODUCT_COUNT = /\d+\s+produits?/;
const HTML_TITLE = /<title>([\s\S]*?)<\/title>/;
const ATTACHED_PICKUP_DATE = /"dateRetrait":"(?:[^"\\]|\\.)*"/;

// ---- Super U: HTML nodes ------------------------------------------------------------------------

const NOISE = "script, noscript, picture, img, svg, iframe, link, style, form.comment-form, .su-dialog-sm";

/** keep: [selector, maximum number of nodes kept]. */
function reduceHtml(html: string, keep: readonly (readonly [string, number])[]): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const count = (doc.querySelector("body")?.textContent ?? "").match(PRODUCT_COUNT)?.[0];
  const nodes = keep.flatMap(([selector, max]) => [...doc.querySelectorAll(selector)].slice(0, max));
  for (const node of nodes) for (const n of [...node.querySelectorAll(NOISE)]) n.remove();
  const body = nodes.map((n) => n.outerHTML).join("\n");
  return `<!doctype html>
<html lang="fr"><body>
<!-- Captured from ${SUPERU_ORIGIN} on ${today} by scripts/capture-fixtures.ts -->
<input type="hidden" name="csrf_token" value="FIXTURE_CSRF">
${count ? `<p class="search-count">${count}</p>` : ""}
${body}
</body></html>
`;
}

const PRODUCT = [
  ["h1", 1],
  ["#product-details", 1],
] as const;

// ---- Leclerc: widget JSON options ---------------------------------------------------------------

type Json = Record<string, unknown>;

interface WidgetSpec {
  readonly suffix: string;
  /** Reduces the options (product list too long…). */
  readonly trim?: (options: Json) => Json;
}

type Element = { objElement: Json };

/** One promotion of each kind: immediate discount, multibuy, Ticket E.Leclerc. */
const PROMOTION_KINDS: readonly ((e: Element) => boolean)[] = [
  (e) => typeof e.objElement["nrPVBRIIDeduit"] === "number",
  (e) => e.objElement["fEstBRIIActifEtDisponible"] === true && typeof e.objElement["nrPVBRIIDeduit"] !== "number",
  (e) => e.objElement["fEstVisiblePictoPromoTEL"] === true,
];

/** Keeps at most `max` search products: two of each kind of promotion, then the first ones. */
const trimProducts =
  (max: number) =>
  (options: Json): Json => {
    const contenu = options["objContenu"] as { lstElements: Element[] };
    const promoted = PROMOTION_KINDS.flatMap((kind) => contenu.lstElements.filter(kind).slice(0, 2));
    const elements = [...new Set([...promoted, ...contenu.lstElements])].slice(0, max);
    return { ...options, objContenu: { ...contenu, lstElements: elements } };
  };

const CARTOUCHE: WidgetSpec = { suffix: "_pnlCartouchePanier" };

/** Bulky blocks of no use to the parsers (promotional stickers, cross-selling, recipes). */
const BULKY = new Set([
  "objStickers",
  "objStickerProduit",
  "objContenuCross",
  "lstRecette",
  "lstTrade",
  "lstOperationTrade",
  "lstProduitStickers",
  "lstStickers",
]);

const omitBulky = (options: Json): Json => {
  const kept = Object.fromEntries(Object.entries(options).filter(([key]) => !BULKY.has(key)));
  const produit = kept["objProduit"];
  return typeof produit === "object" && produit !== null ? { ...kept, objProduit: omitBulky(produit as Json) } : kept;
};

function reduceWidgets(html: string, origin: string, specs: readonly WidgetSpec[]): string {
  const title = html.match(HTML_TITLE)?.[1]?.trim() ?? "";
  const calls = specs.flatMap(({ suffix, trim }) => {
    const options = findWidget(html, suffix) as Json | null;
    if (options === null) return [];
    const reduced = omitBulky(trim ? trim(options) : options);
    return [`Utilitaires.widget.initOptions('fixture${suffix}', ${JSON.stringify(reduced)});`];
  });
  const retrait = html.match(ATTACHED_PICKUP_DATE)?.[0];
  return `<!doctype html>
<html lang="fr"><head><title>${title}</title></head><body>
<!-- Captured from ${origin} on ${today} by scripts/capture-fixtures.ts -->
<script>
${retrait ? `var objConfig = {${retrait}};\n` : ""}${calls.join("\n")}
</script>
</body></html>
`;
}

// ---- Pages --------------------------------------------------------------------------------------

interface Page {
  readonly file: string;
  readonly url: string;
  readonly reduce: (body: string) => string;
}

interface Capture {
  readonly origin: string;
  readonly home: string;
  readonly pages: readonly Page[];
}

function superu(): Capture {
  const html = (keep: readonly (readonly [string, number])[]) => (body: string) => reduceHtml(body, keep);
  return {
    home: SUPERU_HOME_PATH,
    origin: SUPERU_ORIGIN,
    pages: [
      { file: "search-spaghetti.html", reduce: html([[".product-tile", 18]]), url: "/recherche?q=spaghetti" },
      { file: "search-lessive.html", reduce: html([[".product-tile", 18]]), url: "/recherche?q=lessive" },
      {
        file: "cart.html",
        reduce: html([
          ["li.cart-row", 4],
          [".order-total-estimate", 1],
          [".cart-minimum-order-amount-block", 1],
        ]),
        url: "/panier",
      },
      { file: "product-pesto.html", reduce: html(PRODUCT), url: "/p/produit/3870987.html" },
      { file: "product-poulet.html", reduce: html(PRODUCT), url: "/p/produit/5144285.html" },
      { file: "product-jambon.html", reduce: html(PRODUCT), url: "/p/produit/4074234.html" },
      {
        file: "slot-info.html",
        reduce: html([["[data-footer-slots-info]", 1]]),
        url: "/on/demandware.store/Sites-DigitalU-Site/fr_FR/Home-IncludeNavigationSlotTimeInfo",
      },
    ],
  };
}

function leclerc(): Capture {
  const entry = loadConfig().stores.find((s) => s.retailer === "leclerc");
  if (!entry) throw new Error("No Leclerc store in the configuration (FR_GROCERY_CONFIG).");
  const origin = `https://${entry.store.host}`;
  const base = `/magasin-${entry.store.storeId}-${entry.store.retrievalPointId}`;
  const widgets = (specs: readonly WidgetSpec[]) => (body: string) => reduceWidgets(body, origin, specs);
  const search = widgets([
    CARTOUCHE,
    { suffix: "_pnlElementProduit", trim: trimProducts(12) },
    { suffix: "_pnlBlocsFiltres", trim: (o) => ({ iNbTotalProduits: o["iNbTotalProduits"] }) },
  ]);
  const fiche = widgets([CARTOUCHE, { suffix: "_pnlFicheProduit" }]);
  return {
    home: `${base}/recherche.aspx`,
    origin,
    pages: [
      { file: "search-spaghetti.html", reduce: search, url: `${base}/recherche.aspx?TexteRecherche=spaghetti` },
      { file: "search-chocolat.html", reduce: search, url: `${base}/recherche.aspx?TexteRecherche=chocolat` },
      { file: "search-nomatch.html", reduce: search, url: `${base}/recherche.aspx?TexteRecherche=zzzznomatchzzz` },
      { file: "store-page.html", reduce: widgets([CARTOUCHE]), url: `${base}/recherche.aspx` },
      { file: "product-barilla.html", reduce: fiche, url: `${base}/fiche-produits-7459-produit.aspx` },
      { file: "product-poulet.html", reduce: fiche, url: `${base}/fiche-produits-123563-produit.aspx` },
      { file: "product-potimarron.html", reduce: fiche, url: `${base}/fiche-produits-75976-produit.aspx` },
      { file: "product-unknown.html", reduce: fiche, url: `${base}/fiche-produits-999999999-produit.aspx` },
    ],
  };
}

/** Store search: three JSON API responses, chained as the site does. */
async function captureLocator(http: PageHttp, write: (file: string, body: string) => Promise<void>) {
  const api = "https://api-recherchemagasins.leclercdrive.fr/API_RechercheMagasins/api/v1";
  const auto = await http.request(`${api}/autocomplete?search=00000&provider=Woosmap`);
  await write("locator-autocomplete.json", auto.body);
  const id = (JSON.parse(auto.body) as { postalCodes: { id: string }[] }).postalCodes[0]?.id ?? "";
  const coords = await http.request(`${api}/autocomplete/coordinates?id=${encodeURIComponent(id)}&provider=Woosmap`);
  await write("locator-coordinates.json", coords.body);
  const { latitude, longitude } = JSON.parse(coords.body) as { latitude: number; longitude: number };
  const near = await http.request(
    `${api}/MapPoint/nearby?latitude=${latitude}&longitude=${longitude}&postalCode=00000`,
  );
  const points = (JSON.parse(near.body) as { points: unknown[] }).points.slice(0, 6);
  await write("locator-nearby.json", JSON.stringify({ points }, null, 2));
}

const [retailer, ...only] = process.argv.slice(2);
const captures: Record<string, () => Capture> = { leclerc, superu };
const capture = captures[retailer ?? ""];
if (!capture) throw new Error("Usage: npm run fixtures -- <superu|leclerc> [fragment…]");

const { origin, home, pages } = capture();
const out = new URL(`../test/fixtures/${retailer}/`, import.meta.url);
const write = async (file: string, body: string) => {
  await writeFile(new URL(file, out), body);
  console.error(`wrote test/fixtures/${retailer}/${file}`);
};
const browser = new CdpBrowser({ port: loadConfig().chromePort });
try {
  const http = browser.tab(origin, home);
  for (const page of pages.filter((p) => only.length === 0 || only.some((f) => p.file.includes(f)))) {
    const { status, body } = await http.request(page.url);
    if (status !== 200) throw new Error(`${page.url} : HTTP ${status}`);
    await write(page.file, page.reduce(body));
  }
  if (retailer === "leclerc" && (only.length === 0 || only.some((f) => "locator".includes(f)))) {
    await captureLocator(browser.tab(LOCATOR_ORIGIN, "/"), write);
  }
} finally {
  browser.close();
}
