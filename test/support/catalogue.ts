import { fromCents } from "../../src/domain/money.ts";
import { type Product, parseProductId } from "../../src/domain/product.ts";

export function product(overrides: Partial<Omit<Product, "id">> & { id: string; name: string }): Product {
  return {
    price: fromCents(100),
    unitPrice: null,
    available: true,
    promotions: [],
    ...overrides,
    id: parseProductId(overrides.id),
  };
}

export const SPAGHETTI = product({
  id: "960853",
  name: "Pâtes Spaghetti N°5 BARILLA - 500g",
  price: fromCents(95),
  unitPrice: { price: fromCents(190), per: "kg" },
});
export const BOEUF = product({
  id: "2307081",
  name: "U Viande hachée pur boeuf, 5% Matière Grasse, France, 500g",
  price: fromCents(899),
});
export const MOZZARELLA = product({
  id: "239658",
  name: "U Mozzarella au lait pasteurisé 18%mg, 125g",
  available: false,
});

export const CATALOGUE = [SPAGHETTI, BOEUF, MOZZARELLA];
