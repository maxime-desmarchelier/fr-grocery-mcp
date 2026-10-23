import type { Money } from "./money.ts";
import type { SlotTime } from "./slot.ts";

/** Fulfilment mode: drive pickup or home delivery. */
export type FulfilmentMode = "drive" | "delivery";

/** Next slot offered for a mode. */
export interface NextSlot {
  readonly mode: FulfilmentMode;
  /** Null if the site shows no slot for this mode. */
  readonly slot: SlotTime | null;
  readonly available: boolean;
  readonly full: boolean;
}

export interface MinimumOrder {
  readonly mode: FulfilmentMode;
  readonly amount: Money;
}

/** Order conditions read from the site: nothing is booked or placed. */
export interface OrderConditions {
  /** Store selected in the session, e.g. "super u <store name>". */
  readonly store: string | null;
  /** Slot firmly booked by the user. */
  readonly bookedSlot: SlotTime | null;
  /** Pickup date attached to the cart, not guaranteed as a booking (Leclerc). */
  readonly cartSlot: SlotTime | null;
  readonly nextSlots: readonly NextSlot[];
  /** Minimum order per mode; null if the site does not expose it (check at checkout). */
  readonly minimumOrders: readonly MinimumOrder[] | null;
}

export function minimumFor(conditions: OrderConditions, mode: FulfilmentMode): Money | null {
  return conditions.minimumOrders?.find((m) => m.mode === mode)?.amount ?? null;
}
