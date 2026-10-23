// Amounts in integer cents: no floating-point rounding errors (0.1 + 0.2).

declare const cents: unique symbol;
export type Money = number & { readonly [cents]: true };

export const ZERO = 0 as Money;

export function fromCents(value: number): Money {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`Invalid amount: ${value} cents`);
  }
  return value as Money;
}

export function fromEurosAndCents(euros: number, centsPart: number): Money {
  return fromCents(euros * 100 + centsPart);
}

/** Decimal amount provided by a site (0.93): rounded to the nearest cent. */
export function fromDecimalEuros(value: number): Money {
  if (!Number.isFinite(value)) throw new RangeError(`Invalid amount: ${value} €`);
  return fromCents(Math.round(value * 100));
}

export function multiply(amount: Money, factor: number): Money {
  return fromCents(amount * factor);
}

/** Percentage of an amount, rounded to the cent (40% of €4.67 = €1.87). */
export function percentOf(amount: Money, percent: number): Money {
  return fromCents(Math.round((amount * percent) / 100));
}

export function sum(amounts: readonly Money[]): Money {
  return fromCents(amounts.reduce((total, a) => total + a, 0));
}

/** Difference, floored at zero (a discount never makes a price negative). */
export function subtract(amount: Money, deducted: Money): Money {
  return fromCents(Math.max(0, amount - deducted));
}

/** Value in euros for display or serialization (exactly 2 decimals). */
export function toEuros(amount: Money): number {
  return amount / 100;
}
