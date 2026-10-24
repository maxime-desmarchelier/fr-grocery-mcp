// Sites simulated from the fixtures: each known URL returns the matching captured page.

import type { HttpRequest, HttpResponse } from "../../src/infrastructure/http/page-http.ts";
import { fixture, ok } from "./fake-http.ts";

export function superuSite(url: string, init: HttpRequest | undefined): HttpResponse {
  const page = (name: string) => ok(fixture("superu", name));
  if (init?.method === "POST") return ok("{}");
  if (url.startsWith("/recherche")) return page("search-spaghetti.html");
  if (url.startsWith("/p/produit/"))
    return url.includes("/960853.") ? page("product-pesto.html") : { status: 410, body: "" };
  if (url.includes("Home-IncludeNavigationSlotTimeInfo")) return page("slot-info.html");
  return page("cart.html");
}

export function leclercSite(url: string, init: HttpRequest | undefined): HttpResponse {
  const page = (name: string) => ok(fixture("leclerc", name));
  if (init?.method === "POST") return ok('[{"sIdUnique":"Panier123456"}]');
  if (url.includes("TexteRecherche=")) return page("search-spaghetti.html");
  if (url.includes("fiche-produits-"))
    return page(url.includes("-7459-") ? "product-barilla.html" : "product-unknown.html");
  if (url.includes("autocomplete/coordinates")) return page("locator-coordinates.json");
  if (url.includes("autocomplete")) return page("locator-autocomplete.json");
  if (url.includes("MapPoint/nearby")) return page("locator-nearby.json");
  return page("store-page.html");
}
