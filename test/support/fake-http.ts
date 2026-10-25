// Fake HTTP client: serves responses by URL and records the requests sent.

import { readFileSync } from "node:fs";
import type { HttpRequest, HttpResponse, PageHttp } from "../../src/infrastructure/http/page-http.ts";

export const fixture = (retailer: "superu" | "leclerc", name: string): string =>
  readFileSync(new URL(`../fixtures/${retailer}/${name}`, import.meta.url), "utf8");

export const ok = (body: string): HttpResponse => ({ body, status: 200 });

export class FakeHttp implements PageHttp {
  readonly requests: { url: string; init: HttpRequest | undefined }[] = [];
  readonly #routes: (url: string, init: HttpRequest | undefined) => HttpResponse;

  constructor(routes: (url: string, init: HttpRequest | undefined) => HttpResponse) {
    this.#routes = routes;
  }

  async request(url: string, init?: HttpRequest): Promise<HttpResponse> {
    this.requests.push({ init, url });
    return this.#routes(url, init);
  }

  get urls(): string[] {
    return this.requests.map((r) => r.url);
  }
}
