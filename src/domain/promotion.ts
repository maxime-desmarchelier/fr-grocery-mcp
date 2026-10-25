// Retailer promotions, reduced to a few quantifiable mechanics to compare actual prices.

import { fromCents, fromEurosAndCents, type Money, multiply, percentOf, subtract, sum, ZERO } from "./money.ts";

/**
 * - immediate: discount already deducted from the displayed price (struck-through price, immediate discount);
 * - multibuy: discount triggered by buying several units (2nd at -40%, 3rd free);
 * - loyalty: credit paid onto the loyalty card (Carte U, Ticket E.Leclerc), to spend later.
 */
export type PromotionKind = "immediate" | "multibuy" | "loyalty";

export type Mechanic =
  /** Immediate percentage discount, already applied to the price. */
  | { readonly type: "percent_off"; readonly percent: number }
  /** The Nth unit at -X% (100 = free). */
  | { readonly type: "nth_percent_off"; readonly nth: number; readonly percent: number }
  /** X% of the price credited to the loyalty card. */
  | { readonly type: "loyalty_percent"; readonly percent: number }
  /** Fixed amount per unit credited to the loyalty card. */
  | { readonly type: "loyalty_amount"; readonly amount: Money };

export interface Promotion {
  readonly kind: PromotionKind;
  /** Site label: "Promotion", "Avantage Carte U", "Ticket E.Leclerc"… */
  readonly label: string;
  /** End of validity as displayed ("DD/MM"), if known. */
  readonly validUntil: string | null;
  /** Mechanic in plain text, as displayed. */
  readonly details: readonly string[];
  /** Price before immediate discount, if the site shows it. */
  readonly regularPrice: Money | null;
  /** Quantified mechanic, if the text could be interpreted. */
  readonly mechanic: Mechanic | null;
}

const LOYALTY_AMOUNT = /(\d+),(\d{2}) ?€ verses sur votre carte/;
const LOYALTY_PERCENT = /(\d+(?:,\d+)?) ?% (?:verses sur|en ticket|sur (?:votre|la) carte)/;
const NTH_PERCENT_FIRST = /\b(\d+) ?(?:e|eme|ieme)\b[^%]*?(?:-(\d+) ?%|offert|gratuit)/;
const NTH_PERCENT_AFTER = /-(\d+) ?%[^.]*? sur le (\d+) ?(?:e|eme|ieme)\b/;
const IMMEDIATE_PERCENT = /(?:avantage immediat de |-)(\d+(?:,\d+)?) ?%/;

const normalize = (text: string): string =>
  text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ");

const percent = (raw: string | undefined): number | null => {
  const value = Number(raw?.replace(",", "."));
  return Number.isFinite(value) && value > 0 && value <= 100 ? value : null;
};

/** Interprets the text of a French promotion (Super U, Leclerc…). Null if the mechanic is unknown. */
export function parseMechanic(text: string): Mechanic | null {
  const t = normalize(text);

  const amount = t.match(LOYALTY_AMOUNT);
  if (amount) return { amount: fromEurosAndCents(Number(amount[1]), Number(amount[2])), type: "loyalty_amount" };

  const loyalty = percent(t.match(LOYALTY_PERCENT)?.[1]);
  if (loyalty) return { percent: loyalty, type: "loyalty_percent" };

  // "Le 2ème article à -40%", "Le 3ème est offert", "-80% de remise immédiate sur le 2ème produit acheté"
  const nthFirst = t.match(NTH_PERCENT_FIRST);
  const nthAfter = t.match(NTH_PERCENT_AFTER);
  if (nthFirst?.[1] || nthAfter?.[2]) {
    const nth = Number(nthFirst?.[1] ?? nthAfter?.[2]);
    const off = nthFirst ? (nthFirst[2] === undefined ? 100 : percent(nthFirst[2])) : percent(nthAfter?.[1]);
    if (off && nth >= 2) return { nth, percent: off, type: "nth_percent_off" };
  }

  const immediate = percent(t.match(IMMEDIATE_PERCENT)?.[1]);
  if (immediate) return { percent: immediate, type: "percent_off" };

  return null;
}

/** Category of a mechanic (an immediate discount may have none: struck-through price only). */
export function kindOf(mechanic: Mechanic | null): PromotionKind {
  if (mechanic?.type === "nth_percent_off") return "multibuy";
  if (mechanic?.type === "loyalty_percent" || mechanic?.type === "loyalty_amount") return "loyalty";
  return "immediate";
}

/** Cost of a line: paid at checkout, credited as loyalty, and net cost (paid - loyalty). */
export interface LineCost {
  readonly paid: Money;
  readonly loyalty: Money;
  readonly net: Money;
}

/**
 * Cost of `quantity` units at `price` (already net of immediate discounts).
 * Mixed bundles ("the cheaper of the 2") are counted as if every unit were this product.
 */
export function lineCost(price: Money, promotions: readonly Promotion[], quantity: number): LineCost {
  let paid = multiply(price, quantity);
  for (const { mechanic } of promotions) {
    if (mechanic?.type === "nth_percent_off") {
      const discounted = Math.floor(quantity / mechanic.nth);
      paid = subtract(paid, multiply(percentOf(price, mechanic.percent), discounted));
    }
  }
  const credits = promotions.map(({ mechanic }) => {
    if (mechanic?.type === "loyalty_percent") return percentOf(paid, mechanic.percent);
    if (mechanic?.type === "loyalty_amount") return multiply(mechanic.amount, quantity);
    return ZERO;
  });
  const loyalty = sum(credits);
  return { loyalty, net: subtract(paid, loyalty), paid };
}

/** Best unit offer: quantity that triggers the promotion and net cost per unit at that quantity. */
export interface BestOffer {
  readonly quantity: number;
  readonly netUnitPrice: Money;
}

export function bestOffer(price: Money, promotions: readonly Promotion[]): BestOffer {
  const quantity = Math.max(
    1,
    ...promotions.map(({ mechanic }) => (mechanic?.type === "nth_percent_off" ? mechanic.nth : 1)),
  );
  const { net } = lineCost(price, promotions, quantity);
  return { netUnitPrice: fromCents(Math.round(net / quantity)), quantity };
}
