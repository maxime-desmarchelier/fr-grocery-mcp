// Reading the HTML pages of coursesu.com (server-side rendered).
// Pure functions: HTML in, domain objects out. Selectors documented in docs/retailers/superu.md.

import { DOMParser } from "linkedom";
import type { CartLine } from "../../../domain/cart.ts";
import { parseQuantity } from "../../../domain/cart.ts";
import { SessionExpiredError, SiteBlockedError, TransientError, ValidationError } from "../../../domain/errors.ts";
import { fromCents, fromEurosAndCents, type Money } from "../../../domain/money.ts";
import type { MinimumOrder, NextSlot } from "../../../domain/order-conditions.ts";
import {
  type PricingUnit,
  type Product,
  type ProductDetails,
  type ProductId,
  parseProductId,
  type UnitPrice,
} from "../../../domain/product.ts";
import { kindOf, type Promotion, parseMechanic } from "../../../domain/promotion.ts";
import { parseSlotLabel, type SlotTime } from "../../../domain/slot.ts";

export const SUPERU_NAME = "Super U";

type Root = ReturnType<DOMParser["parseFromString"]>;
type Node = NonNullable<ReturnType<Root["querySelector"]>>;

const clean = (text: string | null | undefined): string => (text ?? "").replace(/\s+/g, " ").trim();

function parse(html: string): Root {
  return new DOMParser().parseFromString(html, "text/html");
}

/** Visible text of a node, without scripts. */
function textOf(node: Node): string {
  const copy = node.cloneNode(true) as Node;
  for (const s of [...copy.querySelectorAll("script, noscript")]) s.remove();
  return clean(copy.textContent);
}

/** "1 euros 34 centimes", "4 euros 72 au lieu de…" -> 134, 472 cents. */
export function parseSpokenPrice(text: string): Money | null {
  const m = clean(text).match(/(\d+) euros? (\d{1,2})\b/);
  return m ? fromEurosAndCents(Number(m[1]), Number(m[2])) : null;
}

/** "1 234,56 €" -> 123456 cents. */
export function parseDisplayedPrice(text: string): Money | null {
  const m = clean(text).match(/(\d[\d\s ]*),(\d{2})\s*€/);
  return m ? fromCents(Number(m[1]?.replace(/\D/g, "")) * 100 + Number(m[2])) : null;
}

const UNITS: Record<string, PricingUnit> = { kg: "kg", l: "l", pce: "piece" };

/** "1,90 €/kg" -> { price: 190, per: "kg" }. */
export function parseUnitPrice(text: string): UnitPrice | null {
  const m = clean(text).match(/(\d+),(\d{2}) €\/(kg|l|pce)\b/);
  const per = m?.[3] ? UNITS[m[3]] : undefined;
  return m && per ? { price: fromEurosAndCents(Number(m[1]), Number(m[2])), per } : null;
}

/** Throws the matching error if the response is an anti-bot block. */
export function assertNotBlocked(status: number, html: string): void {
  if (status === 403 || status === 429 || /captcha|datadome/i.test(html.slice(0, 4000)))
    throw new SiteBlockedError(SUPERU_NAME);
}

const UNAVAILABLE = /indisponible|rupture de stock|plus disponible|bientôt disponible/i;

/** Unit price of the single item, not of a bundle ("3,05 €/l les 2" is in .promo-price). */
function regularUnitInfo(node: Node): string {
  const info = [...node.querySelectorAll(".unit-info")].find((e) => e.closest(".promo-price") === null);
  return info?.textContent ?? "";
}

function parsePromotion(tile: Node, text: string): Promotion | null {
  const label = clean(tile.querySelector(".promotion-title-one")?.textContent);
  if (!label) return null;
  const details = [...tile.querySelectorAll(".promotion-tooltip-first, .promotion-tooltip-second")]
    .map((e) => clean(e.textContent))
    .filter(Boolean);
  const unique = [...new Set(details)];
  const mechanic = parseMechanic(unique.join(" "));
  return {
    kind: kindOf(mechanic),
    label,
    validUntil: text.match(/jusqu'au (\d{2}\/\d{2})/)?.[1] ?? null,
    details: unique,
    regularPrice: parseSpokenPrice(text.match(/au lieu de (\d+ euros? \d{1,2})/)?.[1] ?? ""),
    mechanic,
  };
}

function parseTile(tile: Node): Product | null {
  const rawId = tile.querySelector("[data-pid]")?.getAttribute("data-pid");
  const name = clean(tile.querySelector(".product-name")?.textContent);
  if (!rawId || !name) return null;
  const text = textOf(tile);
  return {
    id: parseProductId(rawId),
    name,
    price: parseSpokenPrice(text),
    unitPrice: parseUnitPrice(regularUnitInfo(tile)),
    available: !UNAVAILABLE.test(text),
    promotions: [parsePromotion(tile, text)].filter((p): p is Promotion => p !== null),
  };
}

/** Content following a heading of the "Composition et origine" tab ("Ingrédients", "Origine"…). */
function detailsSection(doc: Root, heading: RegExp): string | null {
  const title = [...doc.querySelectorAll("#product-details h3")].find((h) => heading.test(clean(h.textContent)));
  const content = title?.closest("li")?.nextElementSibling;
  return clean(content?.textContent) || null;
}

/** Page GET /p/<label>/<id>.html (the site ignores the label). */
export function parseProductPage(status: number, html: string, id: ProductId): ProductDetails {
  assertNotBlocked(status, html);
  if (status === 404 || status === 410) throw new ValidationError(`Product ${id} not found on ${SUPERU_NAME}.`);
  const doc = parse(html);
  const name = clean(doc.querySelector("h1")?.textContent);
  if (!name) throw new TransientError(`Unreadable product page ${id}: the site may have changed.`);
  return {
    id,
    name,
    ingredients: detailsSection(doc, /^ingr[ée]dients$/i)?.replace(/^ingr[ée]dients\s*:\s*/i, "") ?? null,
    allergens: null,
    origin: detailsSection(doc, /^origine$/i),
  };
}

export interface SearchPage {
  readonly products: readonly Product[];
  /** Total reported by the site, across all pages. */
  readonly total: number;
  readonly csrfToken: string | null;
}

/** Page GET /recherche?q=…&start=N (18 products per page). */
export function parseSearchPage(status: number, html: string): SearchPage {
  assertNotBlocked(status, html);
  const doc = parse(html);
  const tiles = [...doc.querySelectorAll(".product-tile")].filter(
    (t) => !/mini-cart/.test(t.getAttribute("class") ?? ""),
  );
  if (tiles.length === 0 && /créneau arrivé à terme|session.*expir/i.test(html))
    throw new SessionExpiredError(SUPERU_NAME);
  const products = tiles.map(parseTile).filter((p): p is Product => p !== null);
  const total = Number(
    clean(doc.querySelector("body")?.textContent).match(/(\d+)\s+produits?/)?.[1] ?? products.length,
  );
  return { products, total, csrfToken: csrf(doc) };
}

export interface CartPage {
  readonly lines: readonly CartLine[];
  readonly total: Money | null;
  readonly csrfToken: string | null;
}

/** Page GET /panier (cart). */
export function parseCartPage(status: number, html: string): CartPage {
  assertNotBlocked(status, html);
  const doc = parse(html);
  const rows = [...doc.querySelectorAll("li.cart-row")];
  if (rows.length === 0 && /se connecter|connexion/i.test(html) && !/Mon panier/.test(html)) {
    throw new SessionExpiredError(SUPERU_NAME);
  }
  const lines = rows.map(parseCartRow).filter((l): l is CartLine => l !== null);
  const total = parseDisplayedPrice(doc.querySelector(".order-total-estimate")?.textContent ?? "");
  return { lines, total, csrfToken: csrf(doc) };
}

function parseCartRow(row: Node): CartLine | null {
  const rawId = row.querySelector('input[name="pid"]')?.getAttribute("value");
  if (!rawId) return null;
  const spoken = [...row.querySelectorAll(".sr-only")].find((e) => /euros? \d+ centimes?/.test(e.textContent ?? ""));
  return {
    productId: parseProductId(rawId),
    name: clean(row.querySelector('[class*="product-name"]')?.textContent),
    quantity: parseQuantity(Number(row.querySelector('input[name="Quantity"]')?.getAttribute("value") ?? 0)),
    lineTotal: spoken ? parseSpokenPrice(spoken.textContent ?? "") : null,
    unitPrice: parseUnitPrice(regularUnitInfo(row)),
    // No availability: the .notavailable block is on every line, hidden with CSS.
  };
}

function csrf(doc: Root): string | null {
  return doc.querySelector('input[name="csrf_token"]')?.getAttribute("value") ?? null;
}

/** `.cart-minimum-order-amount-block` of the /panier page: "Retrait drive : 50 €", "Livraison à domicile : 50 €". */
export function parseMinimumOrder(status: number, html: string): MinimumOrder[] {
  assertNotBlocked(status, html);
  const doc = parse(html);
  const amounts = [...doc.querySelectorAll(".cart-minimum-amount")].map((e) => clean(e.textContent));
  const find = (label: RegExp) => {
    const m = amounts.find((a) => label.test(a))?.match(/(\d+)(?:,(\d{2}))?\s*€/);
    return m ? fromEurosAndCents(Number(m[1]), Number(m[2] ?? 0)) : null;
  };
  const minimums: MinimumOrder[] = [];
  const drive = find(/retrait|drive/i);
  const delivery = find(/livraison/i);
  if (drive !== null) minimums.push({ mode: "drive", amount: drive });
  if (delivery !== null) minimums.push({ mode: "delivery", amount: delivery });
  return minimums;
}

export interface SlotInfoPage {
  readonly store: string | null;
  readonly bookedSlot: SlotTime | null;
  readonly nextSlots: readonly NextSlot[];
}

/** Page GET Home-IncludeNavigationSlotTimeInfo (store / slot banner of the header). `today` sets the year. */
export function parseSlotInfoPage(status: number, html: string, today: Date): SlotInfoPage {
  assertNotBlocked(status, html);
  const doc = parse(html);
  const wrapper = doc.querySelector("[data-footer-slots-info]");
  const info = parseSlotsJson(wrapper?.getAttribute("data-footer-slots-info"), today);
  const storeParts = [...(wrapper ?? doc).querySelectorAll(".cu-shipping-methods-store")].map((e) =>
    clean(e.textContent),
  );
  const store = storeParts.filter(Boolean).join(" ") || null;
  const booked = clean((wrapper ?? doc).querySelector("[data-store-description-delivery]")?.textContent);
  return {
    store,
    bookedSlot: booked && !/choisir un cr[ée]neau/i.test(booked) ? parseSlotLabel(booked, today) : null,
    nextSlots: [info.drive, info.delivery].filter((s): s is NextSlot => s !== null),
  };
}

function parseSlotsJson(
  raw: string | null | undefined,
  today: Date,
): { drive: NextSlot | null; delivery: NextSlot | null } {
  let data: unknown;
  try {
    data = JSON.parse(raw ?? "null");
  } catch {
    data = null;
  }
  const slot = (mode: NextSlot["mode"], value: unknown): NextSlot | null => {
    if (typeof value !== "object" || value === null) return null;
    const v = value as { slotText?: unknown; slotAvailable?: unknown; slotFull?: unknown };
    const label = typeof v.slotText === "string" ? clean(decodeEntities(v.slotText)) : "";
    return {
      mode,
      slot: label ? parseSlotLabel(label, today) : null,
      available: v.slotAvailable === true,
      full: v.slotFull === true,
    };
  };
  const d = (typeof data === "object" && data !== null ? data : {}) as { drive?: unknown; delivery?: unknown };
  return { drive: slot("drive", d.drive), delivery: slot("delivery", d.delivery) };
}

/** The attribute's JSON keeps HTML entities ("&agrave;"): decode them with the parser. */
function decodeEntities(text: string): string {
  return parse(`<p>${text}</p>`).querySelector("p")?.textContent ?? text;
}
