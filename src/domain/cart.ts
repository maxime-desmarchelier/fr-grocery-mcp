import { ValidationError } from "./errors.ts";
import type { Money } from "./money.ts";
import type { ProductId, UnitPrice } from "./product.ts";

declare const quantity: unique symbol;
/** Number of sale units of a product in the cart (0 = absent). */
export type Quantity = number & { readonly [quantity]: true };

export function parseQuantity(raw: number): Quantity {
  if (!Number.isSafeInteger(raw) || raw < 0)
    throw new ValidationError(`Invalid quantity: ${raw} (non-negative integer expected)`);
  return raw as Quantity;
}

export interface CartLine {
  readonly productId: ProductId;
  readonly name: string;
  readonly quantity: Quantity;
  readonly lineTotal: Money | null;
  readonly unitPrice: UnitPrice | null;
}

export interface Cart {
  readonly lines: readonly CartLine[];
  /** Estimated total shown by the site. */
  readonly total: Money | null;
}

export function findLine(cart: Cart, id: ProductId): CartLine | null {
  return cart.lines.find((line) => line.productId === id) ?? null;
}

export function quantityOf(cart: Cart, id: ProductId): Quantity {
  return findLine(cart, id)?.quantity ?? (0 as Quantity);
}

/** Target quantity after adding `added` units. */
export function quantityAfterAdding(cart: Cart, id: ProductId, added: Quantity): Quantity {
  return parseQuantity(quantityOf(cart, id) + added);
}
