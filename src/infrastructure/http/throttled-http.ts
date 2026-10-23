// Human pace: requests to a site go out one by one, spaced by a minimum delay plus a random
// jitter. A burst (several additions in parallel) triggers anti-bot protections.

import type { HttpRequest, HttpResponse, PageHttp } from "./page-http.ts";

export interface ThrottleOptions {
  /** Minimum delay between two requests. */
  readonly minIntervalMs: number;
  /** Random jitter added to the delay (0 to jitterMs). */
  readonly jitterMs: number;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Decorator: same contract as the decorated client, with serialized and spaced requests. */
export class ThrottledHttp implements PageHttp {
  readonly #inner: PageHttp;
  readonly #options: Required<ThrottleOptions>;
  #tail: Promise<unknown> = Promise.resolve();
  #lastAt = Number.NEGATIVE_INFINITY;

  constructor(inner: PageHttp, options: ThrottleOptions) {
    this.#inner = inner;
    this.#options = {
      now: Date.now,
      random: Math.random,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      ...options,
    };
  }

  request(url: string, init?: HttpRequest): Promise<HttpResponse> {
    const { minIntervalMs, jitterMs, now, random, sleep } = this.#options;
    const result = this.#tail.then(async () => {
      const wait = this.#lastAt + minIntervalMs + Math.floor(random() * (jitterMs + 1)) - now();
      if (wait > 0) await sleep(wait);
      try {
        return await this.#inner.request(url, init);
      } finally {
        this.#lastAt = now();
      }
    });
    // The queue moves on whether the request succeeds or fails.
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
