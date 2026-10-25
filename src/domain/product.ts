import { ValidationError } from "./errors.ts";
import type { Money } from "./money.ts";
import type { Promotion } from "./promotion.ts";

const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

declare const productId: unique symbol;
/** Retailer-specific product identifier ("960853" at Super U, "7459" at Leclerc). */
export type ProductId = string & { readonly [productId]: true };

/** Shape shared by all retailers; each adapter also checks its own format. */
export function parseProductId(raw: string): ProductId {
  const value = raw.trim();
  if (!PRODUCT_ID.test(value)) {
    throw new ValidationError(`Invalid product identifier: "${raw}"`);
  }
  return value as ProductId;
}

export type PricingUnit = "kg" | "l" | "piece";

/** Price per unit of measure, to compare different pack sizes. */
export interface UnitPrice {
  readonly price: Money;
  readonly per: PricingUnit;
}

export interface Product {
  readonly id: ProductId;
  /** Full label, including brand and size ("Pâtes Spaghetti N°5 BARILLA - 500g"). */
  readonly name: string;
  /** Price of one unit at checkout, immediate discounts deducted. */
  readonly price: Money | null;
  readonly unitPrice: UnitPrice | null;
  readonly available: boolean;
  readonly promotions: readonly Promotion[];
}

/** Product page: what search results do not show. */
export interface ProductDetails {
  readonly id: ProductId;
  readonly name: string;
  /** Ingredient list as displayed (allergens in capitals, "may contain traces"…). Null for a raw product (fruit, fresh meat). */
  readonly ingredients: string | null;
  /** Separate allergen statement ("Contient : … ; Traces de : …"), if the site provides it. */
  readonly allergens: string | null;
  /** Declared origin ("Né, élevé et abattu en France", "FRANCE"), if the page provides it. */
  readonly origin: string | null;
}

export interface SearchResult {
  readonly query: string;
  /** Total number of products reported by the site (may exceed products.length). */
  readonly total: number;
  readonly products: readonly Product[];
}
