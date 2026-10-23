// Domain errors and errors of the store contract.
// Each error name tells the agent what to do next.

export abstract class ShopError extends Error {
  abstract readonly retryable: boolean;
}

/** Invalid business value (identifier, quantity…): fix the call. */
export class ValidationError extends ShopError {
  override readonly name = "ValidationError";
  readonly retryable = false;
}

/** The retailer does not offer this feature: do it another way (see list_stores). */
export class NotSupportedError extends ShopError {
  override readonly name = "NotSupportedError";
  readonly retryable = false;
}

/** The user must log in again on the site. */
export class SessionExpiredError extends ShopError {
  override readonly name = "SessionExpiredError";
  readonly retryable = false;
  /** @param store retailer name ("Super U"), included in the message. */
  constructor(store: string, detail = "log in again on the site in Chrome, then retry.") {
    super(`${store} session expired: ${detail}`);
  }
}

/** Anti-bot protection or site rate limit: stop. */
export class SiteBlockedError extends ShopError {
  override readonly name = "SiteBlockedError";
  readonly retryable = false;
  constructor(store: string, detail = "open the site in Chrome, check that it loads, then retry later.") {
    super(`${store} blocked the requests (anti-bot protection or rate limit). Stopping: ${detail}`);
  }
}

/** One-off failure (network, slow page): retry. */
export class TransientError extends ShopError {
  override readonly name = "TransientError";
  readonly retryable = true;
}
