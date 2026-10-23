// Chrome DevTools Protocol connection to the user's Chrome, started with --remote-debugging-port.
// Requests are sent from a tab of each site, hence with its logged-in session.
//
// - One tab per origin, found by its domain: a retailer never navigates another retailer's tab.
// - Every operation, across all tabs, goes through a single queue: no bursts, no races.

import { SessionExpiredError, TransientError } from "../../domain/errors.ts";
import type { HttpRequest, HttpResponse, PageHttp } from "../http/page-http.ts";

interface CdpTarget {
  readonly type: string;
  readonly url: string;
  readonly webSocketDebuggerUrl: string;
}

interface CdpResponse {
  readonly id: number;
  readonly result?: {
    readonly result?: { readonly value?: unknown };
    readonly exceptionDetails?: { readonly text: string };
  };
  readonly error?: { readonly message: string };
}

export interface CdpBrowserOptions {
  readonly port: number;
  /** Maximum duration of a CDP command (and of a page load). */
  readonly timeoutMs?: number;
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class CdpBrowser {
  readonly port: number;
  readonly timeoutMs: number;
  readonly #tabs = new Map<string, CdpTab>();
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: CdpBrowserOptions) {
    this.port = options.port;
    this.timeoutMs = options.timeoutMs ?? 30_000;
  }

  /** HTTP client of the `origin` site's tab (created on demand, then shared). */
  tab(origin: string, homePath: string): CdpTab {
    const key = new URL(origin).origin;
    let tab = this.#tabs.get(key);
    if (!tab) {
      tab = new CdpTab(this, key, homePath);
      this.#tabs.set(key, tab);
    }
    return tab;
  }

  /** Runs fn once all previous operations are done. */
  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(fn);
    this.#tail = result.catch(() => undefined);
    return result;
  }

  async targets(): Promise<CdpTarget[]> {
    try {
      return (await (await fetch(`http://127.0.0.1:${this.port}/json/list`)).json()) as CdpTarget[];
    } catch {
      throw new TransientError(
        `Debugging Chrome unreachable on port ${this.port}. Start Chrome with --remote-debugging-port=${this.port} (mise run chrome).`,
      );
    }
  }

  async openTab(url: string): Promise<CdpTarget> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?${url}`, { method: "PUT" });
    if (!response.ok) throw new TransientError(`Chrome refused to open a tab (HTTP ${response.status}).`);
    return (await response.json()) as CdpTarget;
  }

  close(): void {
    for (const tab of this.#tabs.values()) tab.close();
    this.#tabs.clear();
  }
}

export class CdpTab implements PageHttp {
  readonly origin: string;
  readonly #browser: CdpBrowser;
  readonly #homePath: string;
  readonly #pending = new Map<number, { resolve: (r: CdpResponse) => void; reject: (e: Error) => void }>();
  #ws: WebSocket | null = null;
  #nextId = 0;

  constructor(browser: CdpBrowser, origin: string, homePath: string) {
    this.#browser = browser;
    this.origin = origin;
    this.#homePath = homePath;
  }

  request(url: string, init: HttpRequest = {}): Promise<HttpResponse> {
    return this.#browser.run(async () => {
      await this.#ensureOnOrigin();
      const expression = `(async () => {
        const r = await fetch(${JSON.stringify(url)}, { credentials: "include", ...${JSON.stringify(init)} });
        return { status: r.status, body: await r.text() };
      })()`;
      const value = await this.#evaluate(expression);
      if (!isHttpResponse(value)) throw new TransientError("Empty or unreadable response from the page.");
      return value;
    });
  }

  close(): void {
    this.#ws?.close();
    this.#ws = null;
  }

  async #evaluate(expression: string): Promise<unknown> {
    await this.#connect();
    const response = await this.#send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    const exception = response.result?.exceptionDetails;
    if (exception) throw new TransientError(`Error in page ${this.origin}: ${exception.text}`);
    return response.result?.result?.value;
  }

  /** The tab must be on the site: otherwise relative requests would go elsewhere, and so would the cookies. */
  async #ensureOnOrigin(): Promise<void> {
    if ((await this.#evaluate("location.origin")) === this.origin) return;
    await this.#send("Page.navigate", { url: this.origin + this.#homePath });
    await this.#waitForLoad();
  }

  /** Waits for the page to load on the origin, then gives the site's scripts time to run (anti-bot checks). */
  async #waitForLoad(): Promise<void> {
    const deadline = Date.now() + this.#browser.timeoutMs;
    while (Date.now() < deadline) {
      await delay(500);
      const state = await this.#evaluate("[location.origin, document.readyState].join(' ')").catch(() => null);
      if (state === `${this.origin} complete`) {
        await delay(1500);
        return;
      }
    }
    throw new TransientError(`Loading ${this.origin} took too long (${this.#browser.timeoutMs} ms).`);
  }

  async #connect(): Promise<void> {
    if (this.#ws?.readyState === WebSocket.OPEN) return;
    const { target, created } = await this.#target();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new TransientError("CDP connection failed.")), { once: true });
    });
    ws.addEventListener("message", (event) => this.#onMessage(String(event.data)));
    ws.addEventListener("close", () => this.#failPending(new TransientError("CDP connection closed.")));
    this.#ws = ws;
    if (created) await this.#waitForLoad();
  }

  async #target(): Promise<{ target: CdpTarget; created: boolean }> {
    const host = new URL(this.origin).host;
    const existing = (await this.#browser.targets()).find((t) => t.type === "page" && hostOf(t.url) === host);
    if (existing) return { target: existing, created: false };
    // No tab for the site: open one, reusing the Chrome profile's session.
    try {
      return { target: await this.#browser.openTab(this.origin + this.#homePath), created: true };
    } catch {
      throw new SessionExpiredError(host, `no ${host} tab open in Chrome. Open the site, log in, then retry.`);
    }
  }

  #send(method: string, params: Record<string, unknown> = {}): Promise<CdpResponse> {
    const ws = this.#ws;
    if (!ws) return Promise.reject(new TransientError("CDP session not connected."));
    const id = ++this.#nextId;
    const timeoutMs = this.#browser.timeoutMs;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new TransientError(`Timed out on ${method} (${timeoutMs} ms).`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          if (r.error) reject(new TransientError(`CDP ${method}: ${r.error.message}`));
          else resolve(r);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  #onMessage(data: string): void {
    const message = JSON.parse(data) as Partial<CdpResponse>;
    if (typeof message.id !== "number") return; // CDP event, ignored
    this.#pending.get(message.id)?.resolve(message as CdpResponse);
    this.#pending.delete(message.id);
  }

  #failPending(error: Error): void {
    for (const { reject } of this.#pending.values()) reject(error);
    this.#pending.clear();
    this.#ws = null;
  }
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function isHttpResponse(value: unknown): value is HttpResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as HttpResponse).status === "number" &&
    typeof (value as HttpResponse).body === "string"
  );
}
