// Reading E.Leclerc Drive pages (server-side rendered ASP.NET).
// Data is passed to the page's widgets as JSON: `Utilitaires.widget.initOptions('<id>', {…})`.
// Pure functions: HTML in, domain objects out. See docs/retailers/leclerc.md.

import { z } from "zod";
import { type CartLine, parseQuantity } from "../../../domain/cart.ts";
import { SessionExpiredError, SiteBlockedError, TransientError, ValidationError } from "../../../domain/errors.ts";
import type { StoreLocation } from "../../../domain/grocery-store.ts";
import { fromDecimalEuros, fromEurosAndCents, type Money } from "../../../domain/money.ts";
import type { NextSlot } from "../../../domain/order-conditions.ts";
import {
  type PricingUnit,
  type Product,
  type ProductDetails,
  type ProductId,
  parseProductId,
  type UnitPrice,
} from "../../../domain/product.ts";
import { type Promotion, parseMechanic } from "../../../domain/promotion.ts";
import { parseSlotLabel, type SlotTime } from "../../../domain/slot.ts";

export const LECLERC_NAME = "E.Leclerc Drive";

// ---- Widget extraction --------------------------------------------------------------------------

/** End of the JSON object or array starting at `start`, honouring strings. */
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  let quote = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === '"') quote = false;
    } else if (c === '"') quote = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** JSON options of the first widget whose identifier ends with `suffix` (null if absent). */
export function findWidget(html: string, suffix: string): unknown {
  const pattern = new RegExp(`initOptions\\('[\\w$]*${suffix}',\\s*`, "g");
  const match = pattern.exec(html);
  if (!match) return null;
  const start = match.index + match[0].length;
  const end = balancedEnd(html, start);
  if (end < 0) throw new TransientError(`Truncated widget ${suffix}: the site may have changed.`);
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    throw new TransientError(`Unreadable widget ${suffix}: the site may have changed.`);
  }
}

function readWidget<T>(html: string, suffix: string, schema: z.ZodType<T>): T | null {
  const raw = findWidget(html, suffix);
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new TransientError(`Unexpected widget ${suffix}: the site may have changed.`);
  return parsed.data;
}

// ---- Small conversions -------------------------------------------------------------------------

const NAMED: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML entities in labels ("P&#226;tes", "&amp;"). */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/g, (_, name: string) => NAMED[name] ?? "");
}

const clean = (text: string | null | undefined): string =>
  decodeEntities(text ?? "")
    .replace(/\s+/g, " ")
    .trim();

/** "6,43 €" -> 643 cents. */
export function parseEuroText(text: string | undefined): Money | null {
  const m = text?.replace(/\s/g, "").match(/^(\d+),(\d{2})€$/);
  return m ? fromEurosAndCents(Number(m[1]), Number(m[2])) : null;
}

const UNITS: Record<string, PricingUnit> = { kg: "kg", l: "l", p: "piece" };

const money = (value: number | null | undefined): Money | null =>
  typeof value === "number" && value > 0 ? fromDecimalEuros(value) : null;

// ---- Page checks --------------------------------------------------------------------------------

/**
 * Every real store page carries the cart widget (cartouche). Known cases without it: the anti-bot
 * interstitial (HTTP 200 or 403) and the "session expirée" page.
 */
export function assertStorePage(status: number, html: string): void {
  if (status === 403 || status === 429) throw new SiteBlockedError(LECLERC_NAME);
  if (status >= 500) throw new TransientError(`${LECLERC_NAME} indisponible (HTTP ${status}).`);
  if (html.includes("pnlCartouchePanier'")) return;
  if (/session a expir|sessionexpiree/i.test(html)) throw new SessionExpiredError(LECLERC_NAME);
  throw new SiteBlockedError(LECLERC_NAME);
}

// ---- Products -----------------------------------------------------------------------------------

const optionalText = z.string().nullish();
const optionalNumber = z.number().nullish();

const rawProduct = z.object({
  iIdProduit: z.union([z.number(), z.string()]),
  sType: optionalText,
  sLibelleLigne1: optionalText,
  sLibelleLigne2: optionalText,
  nrPVUnitaireTTC: optionalNumber,
  nrPVParUniteDeMesureTTC: optionalNumber,
  sUniteMesureTotale: optionalText,
  iQteDisponible: optionalNumber,
  iQuantitePanier: optionalNumber,
  rTotalAPayer: optionalNumber,
  // Immediate discount (BRII): deducted price, and deducted price per kg.
  nrPVBRIIDeduit: optionalNumber,
  nrPVMesureBRIIDeduit: optionalNumber,
  fEstBRIIActifEtDisponible: z.boolean().nullish(),
  sTexteLogoBRII: optionalText,
  eIncitationLot: optionalNumber,
  // Ticket E.Leclerc: credit on the loyalty card.
  fEstVisiblePictoPromoTEL: z.boolean().nullish(),
  sTexteLogoTel: optionalText,
});
type RawProduct = z.infer<typeof rawProduct>;

function promotionsOf(raw: RawProduct, regular: Money | null): Promotion[] {
  const promotions: Promotion[] = [];
  const brii = clean(raw.sTexteLogoBRII);
  if (raw.fEstBRIIActifEtDisponible && brii) {
    const immediate = money(raw.nrPVBRIIDeduit) !== null;
    promotions.push({
      kind: immediate ? "immediate" : "multibuy",
      label: immediate ? "Avantage immédiat" : "Lot",
      validUntil: null,
      details: [brii],
      regularPrice: immediate ? regular : null,
      mechanic: parseMechanic(brii),
    });
  }
  const tel = clean(raw.sTexteLogoTel);
  if (raw.fEstVisiblePictoPromoTEL && tel) {
    promotions.push({
      kind: "loyalty",
      label: "Ticket E.Leclerc",
      validUntil: null,
      details: [tel],
      regularPrice: null,
      mechanic: parseMechanic(tel),
    });
  }
  return promotions;
}

function mapProduct(raw: RawProduct): Product {
  const regular = money(raw.nrPVUnitaireTTC);
  const deducted = money(raw.nrPVBRIIDeduit);
  const per = UNITS[raw.sUniteMesureTotale ?? ""];
  const unitAmount = money(raw.nrPVMesureBRIIDeduit) ?? money(raw.nrPVParUniteDeMesureTTC);
  const unitPrice: UnitPrice | null = per && unitAmount !== null ? { price: unitAmount, per } : null;
  const id = String(raw.iIdProduit);
  return {
    id: parseProductId(id),
    name: clean(`${raw.sLibelleLigne1 ?? ""} ${raw.sLibelleLigne2 ?? ""}`) || `Product ${id}`,
    price: deducted ?? regular,
    unitPrice: deducted !== null && raw.nrPVMesureBRIIDeduit == null ? null : unitPrice,
    available: (raw.iQteDisponible ?? 0) > 0,
    promotions: promotionsOf(raw, regular),
  };
}

const searchWidget = z.object({
  objContenu: z.object({ lstElements: z.array(z.object({ objElement: z.unknown() })) }),
});
const filtersWidget = z.object({ iNbTotalProduits: z.number().nullish() });

export interface SearchPage {
  readonly products: readonly Product[];
  readonly total: number;
}

/** Page GET recherche.aspx?TexteRecherche=…: all results at once, no pagination. */
export function parseSearchPage(status: number, html: string): SearchPage {
  assertStorePage(status, html);
  const widget = readWidget(html, "_pnlElementProduit", searchWidget);
  if (widget === null) return { products: [], total: 0 }; // zéro résultat : le site propose d'autres produits
  const products = new Map<string, Product>();
  for (const { objElement } of widget.objContenu.lstElements) {
    const raw = rawProduct.safeParse(objElement);
    if (!raw.success || (raw.data.sType && raw.data.sType !== "Produit")) continue;
    const product = mapProduct(raw.data);
    if (!products.has(product.id)) products.set(product.id, product);
  }
  const total = readWidget(html, "_pnlBlocsFiltres", filtersWidget)?.iNbTotalProduits ?? products.size;
  return { products: [...products.values()], total: Math.max(total, products.size) };
}

// ---- Cart and conditions ------------------------------------------------------------------------

const rawCart = z.object({
  sType: optionalText,
  fEstPanierCourant: z.boolean().nullish(),
  sTotalAPayer: optionalText,
  sDateProchainRetraitDisponible: optionalText,
  lstProduits: z.array(z.unknown()).nullish(),
});
const cartWidget = z.object({
  objCartouchePanier: z.object({
    lstElements: z.array(z.object({ lstEnfants: z.array(z.object({ objElement: z.unknown() })).nullish() })),
  }),
});

/** Current cart from the "cartouche" widget, present on every store page. */
function currentCart(html: string): z.infer<typeof rawCart> {
  const widget = readWidget(html, "_pnlCartouchePanier", cartWidget);
  const candidates = (widget?.objCartouchePanier.lstElements ?? [])
    .flatMap((e) => e.lstEnfants ?? [])
    .map((e) => rawCart.safeParse(e.objElement))
    .flatMap((r) => (r.success && r.data.sType === "Panier" ? [r.data] : []));
  const cart = candidates.find((c) => c.fEstPanierCourant) ?? candidates[0];
  if (!cart) throw new TransientError("Cart not found in the page: the site may have changed.");
  return cart;
}

export interface CartPage {
  readonly lines: readonly CartLine[];
  readonly total: Money | null;
}

/** Cart read from any store page (recherche.aspx without a term, the lightest). */
export function parseCartPage(status: number, html: string): CartPage {
  assertStorePage(status, html);
  const cart = currentCart(html);
  const lines: CartLine[] = [];
  for (const item of cart.lstProduits ?? []) {
    const raw = rawProduct.safeParse(item);
    if (!raw.success || (raw.data.iQuantitePanier ?? 0) <= 0) continue;
    const product = mapProduct(raw.data);
    lines.push({
      productId: product.id,
      name: product.name,
      quantity: parseQuantity(raw.data.iQuantitePanier ?? 0),
      lineTotal: money(raw.data.rTotalAPayer),
      unitPrice: product.unitPrice,
    });
  }
  return { lines, total: parseEuroText(cart.sTotalAPayer ?? undefined) };
}

export interface ConditionsPage {
  readonly nextSlots: readonly NextSlot[];
  readonly cartSlot: SlotTime | null;
}

/** The store's next pickup slot and the pickup date attached to the cart (global `dateRetrait`). */
export function parseConditionsPage(status: number, html: string, today: Date): ConditionsPage {
  assertStorePage(status, html);
  const next = clean(currentCart(html).sDateProchainRetraitDisponible);
  const attached = html.match(/"dateRetrait":("(?:[^"\\]|\\.)*")/)?.[1];
  const cartLabel = attached ? clean(JSON.parse(attached) as string) : "";
  return {
    nextSlots: [
      { mode: "drive", slot: next ? parseSlotLabel(next, today) : null, available: next !== "", full: false },
    ],
    cartSlot: cartLabel ? parseSlotLabel(cartLabel, today) : null,
  };
}

// ---- Product page -------------------------------------------------------------------------------

const ficheWidget = z.object({
  objProduit: z.object({
    iIdProduit: z.union([z.number(), z.string()]),
    sLibelleLigne1: optionalText,
    sLibelleLigne2: optionalText,
    sComposition: optionalText,
    sAllergenes: optionalText,
    lstMentionProduit: z.array(z.object({ sTypeMention: optionalText, sLibelleValeur: optionalText })).nullish(),
  }),
});

/** Multiline site field ("\r" between lines) as a single line "a ; b". */
const lines = (text: string | null | undefined): string | null =>
  (text ?? "")
    .split(/\r?\n|\r/)
    .map(clean)
    .filter(Boolean)
    .join(" ; ") || null;

/** Page GET fiche-produits-<id>-<label>.aspx (the label is ignored). */
export function parseProductPage(status: number, html: string, id: ProductId): ProductDetails {
  assertStorePage(status, html);
  const fiche = readWidget(html, "_pnlFicheProduit", ficheWidget)?.objProduit;
  if (!fiche || String(fiche.iIdProduit) !== id) {
    throw new ValidationError(`Product ${id} not found on ${LECLERC_NAME}.`);
  }
  const origin = fiche.lstMentionProduit?.find((m) => m.sTypeMention === "ORIG")?.sLibelleValeur;
  return {
    id,
    name: clean(`${fiche.sLibelleLigne1 ?? ""} ${fiche.sLibelleLigne2 ?? ""}`),
    ingredients: lines(fiche.sComposition)?.replace(/^ingr[ée]dients\s*:\s*/i, "") ?? null,
    allergens: lines(fiche.sAllergenes),
    origin: clean(origin) || null,
  };
}

// ---- Cart: response to a change -----------------------------------------------------------------

/** POST panier.aspx?op=1: the response is a JSON array of events (read only to validate the format). */
export function assertMutationAccepted(status: number, body: string): void {
  if (status === 403 || status === 429) throw new SiteBlockedError(LECLERC_NAME);
  if (status < 200 || status >= 300) throw new TransientError(`Cart change refused (HTTP ${status}).`);
  let events: unknown;
  try {
    events = JSON.parse(body);
  } catch {
    events = null;
  }
  if (!Array.isArray(events)) {
    if (/session a expir|sessionexpiree/i.test(body)) throw new SessionExpiredError(LECLERC_NAME);
    throw new TransientError("Unexpected response to the cart change: the site may have changed.");
  }
}

// ---- Store search -------------------------------------------------------------------------------

const autocomplete = z.object({
  postalCodes: z.array(z.object({ id: z.string(), postalCode: optionalText })).nullish(),
});
const coordinates = z.union([
  z.object({ latitude: z.number(), longitude: z.number() }),
  z.object({ coordinates: z.object({ latitude: z.number(), longitude: z.number() }) }),
]);
const nearby = z.object({
  points: z
    .array(
      z.object({
        noPL: z.union([z.string(), z.number()]),
        noPR: z.union([z.string(), z.number()]).nullish(),
        name: optionalText,
        serviceType: optionalText,
        distance: optionalNumber,
        postalCode: optionalText,
        urlSiteCourse: optionalText,
      }),
    )
    .nullish(),
});

function json<T>(status: number, body: string, schema: z.ZodType<T>): T {
  if (status === 403 || status === 429) throw new SiteBlockedError(LECLERC_NAME);
  if (status < 200 || status >= 300) throw new TransientError(`Recherche de magasins : HTTP ${status}.`);
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    throw new TransientError("Store search: non-JSON response.");
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new TransientError("Store search: unexpected format, the site may have changed.");
  return parsed.data;
}

/** First place suggested for a postcode or town (null if none). */
export function parseAutocomplete(status: number, body: string): { id: string; postalCode: string | null } | null {
  const place = json(status, body, autocomplete).postalCodes?.[0];
  return place ? { id: place.id, postalCode: place.postalCode ?? null } : null;
}

export function parseCoordinates(status: number, body: string): { latitude: number; longitude: number } {
  const data = json(status, body, coordinates);
  return "coordinates" in data ? data.coordinates : data;
}

/** Leclerc store: delivery point identifier (noPL), pickup point (noPR) and shopping host. */
export interface LeclercStoreLocation extends StoreLocation {
  readonly retrievalPointId: string;
  readonly host: string;
}

const SERVICE_TYPES: Record<string, StoreLocation["serviceType"]> = {
  drive: "drive",
  relais: "relay",
  livraison: "delivery",
};

export function parseNearby(status: number, body: string): LeclercStoreLocation[] {
  const stores: LeclercStoreLocation[] = [];
  for (const point of json(status, body, nearby).points ?? []) {
    let host: string;
    try {
      host = new URL(point.urlSiteCourse ?? "").host;
    } catch {
      continue;
    }
    const storeId = String(point.noPL);
    // A walk-in pickup point shares its store's noPL: the exposed identifier combines both.
    const retrievalPointId = String(point.noPR ?? point.noPL);
    stores.push({
      id: retrievalPointId === storeId ? storeId : `${storeId}-${retrievalPointId}`,
      name: clean(point.name) || `Store ${storeId}`,
      serviceType: SERVICE_TYPES[(point.serviceType ?? "").toLowerCase()] ?? "other",
      distanceKm: point.distance ?? null,
      postalCode: point.postalCode ?? null,
      retrievalPointId,
      host,
    });
  }
  return stores;
}
