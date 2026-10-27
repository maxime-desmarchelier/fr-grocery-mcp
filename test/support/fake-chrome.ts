import type { HttpResponse } from "../../src/infrastructure/http/page-http.ts";

interface CdpCommand {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface FakePageOptions {
  readonly onFetch?: (url: string) => HttpResponse;
  /** document.readyState reported while loading; "loading" never completes. */
  readonly readyState?: string;
  readonly url: string;
}

export class FakePage {
  url: string;
  readyState: string;
  onFetch: (url: string) => HttpResponse;
  readonly wsUrl: string;
  readonly navigations: string[] = [];
  readonly fetchExpressions: string[] = [];
  exceptionOnce: string | null = null;
  protocolErrorOnce: string | null = null;
  /** Closes the connection on the next command without answering. */
  dropNextCommand = false;
  /** Leaves commands unanswered so the client's timeout fires. */
  hang = false;
  emptyFetchResponse = false;

  constructor(wsUrl: string, options: FakePageOptions) {
    this.wsUrl = wsUrl;
    this.url = options.url;
    this.readyState = options.readyState ?? "complete";
    this.onFetch = options.onFetch ?? (() => ({ body: "", status: 200 }));
  }

  get origin(): string {
    try {
      return new URL(this.url).origin;
    } catch {
      return "null";
    }
  }
}

export class FakeChrome {
  readonly pages: FakePage[] = [];
  /** Extra raw targets mixed into /json/list (wrong type, malformed URL…). */
  extraTargets: { type: string; url: string; webSocketDebuggerUrl: string }[] = [];
  targetsError: Error | null = null;
  newTabStatus = 200;
  latencyMs = 0;
  listCalls = 0;
  readonly newTabCalls: string[] = [];
  socketsOpened = 0;
  maxInFlight = 0;
  readonly sockets: FakeSocket[] = [];
  #inFlight = 0;
  #nextPage = 0;

  addPage(options: FakePageOptions): FakePage {
    const page = new FakePage(`ws://127.0.0.1/devtools/page/${++this.#nextPage}`, options);
    this.pages.push(page);
    return page;
  }

  fetch = async (input: string | URL, init?: { method?: string }): Promise<Response> => {
    const url = String(input);
    if (url.endsWith("/json/list")) {
      this.listCalls++;
      if (this.targetsError) throw this.targetsError;
      const targets = [
        ...this.pages.map((p) => ({ type: "page", url: p.url, webSocketDebuggerUrl: p.wsUrl })),
        ...this.extraTargets,
      ];
      return new Response(JSON.stringify(targets));
    }
    if (url.includes("/json/new?")) {
      const target = url.slice(url.indexOf("/json/new?") + "/json/new?".length);
      this.newTabCalls.push(target);
      if (this.newTabStatus !== 200) return new Response("refused", { status: this.newTabStatus });
      const page = this.addPage({ url: target });
      return new Response(JSON.stringify({ type: "page", url: page.url, webSocketDebuggerUrl: page.wsUrl }));
    }
    throw new TypeError(`Unexpected fetch: ${url} (${init?.method ?? "GET"})`);
  };

  async answer(page: FakePage, socket: FakeSocket, command: CdpCommand): Promise<void> {
    this.#inFlight++;
    this.maxInFlight = Math.max(this.maxInFlight, this.#inFlight);
    try {
      if (page.hang) return;
      if (page.dropNextCommand) {
        page.dropNextCommand = false;
        socket.close();
        return;
      }
      if (this.latencyMs > 0) await new Promise((resolve) => setTimeout(resolve, this.latencyMs));
      if (page.protocolErrorOnce) {
        const message = page.protocolErrorOnce;
        page.protocolErrorOnce = null;
        socket.respond({ error: { message }, id: command.id });
        return;
      }
      socket.respond({ id: command.id, result: await this.#resultOf(page, command) });
    } finally {
      this.#inFlight--;
    }
  }

  async #resultOf(page: FakePage, command: CdpCommand): Promise<unknown> {
    if (command.method === "Page.navigate") {
      page.url = String(command.params["url"]);
      page.navigations.push(page.url);
      return {};
    }
    if (command.method === "Runtime.evaluate") {
      const expression = String(command.params["expression"]);
      if (page.exceptionOnce) {
        const text = page.exceptionOnce;
        page.exceptionOnce = null;
        return { exceptionDetails: { text } };
      }
      if (expression === "location.origin") return { result: { value: page.origin } };
      if (expression.includes("document.readyState")) return { result: { value: `${page.origin} ${page.readyState}` } };
      const fetchUrl = /fetch\(("(?:[^"\\]|\\.)*")/.exec(expression);
      if (fetchUrl?.[1]) {
        page.fetchExpressions.push(expression);
        if (page.emptyFetchResponse) return { result: {} };
        return { result: { value: page.onFetch(JSON.parse(fetchUrl[1]) as string) } };
      }
      return { result: {} };
    }
    throw new TypeError(`Unexpected CDP method: ${command.method}`);
  }
}

export class FakeSocket {
  static readonly OPEN = 1;
  readyState = 0;
  readonly #chrome: FakeChrome;
  readonly #page: FakePage | null;
  readonly #listeners = new Map<string, { callback: (event: unknown) => void; once: boolean }[]>();

  constructor(chrome: FakeChrome, page: FakePage | null) {
    this.#chrome = chrome;
    this.#page = page;
    chrome.sockets.push(this);
    queueMicrotask(() => {
      if (!page) {
        this.#emit("error", {});
        return;
      }
      this.readyState = FakeSocket.OPEN;
      chrome.socketsOpened++;
      this.#emit("open", {});
    });
  }

  addEventListener(type: string, callback: (event: unknown) => void, options?: { once?: boolean }): void {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once ?? false });
    this.#listeners.set(type, listeners);
  }

  send(data: string): void {
    if (this.readyState !== FakeSocket.OPEN) throw new TypeError("WebSocket is not open");
    const page = this.#page;
    if (!page) return;
    const command = JSON.parse(data) as CdpCommand;
    queueMicrotask(() => void this.#chrome.answer(page, this, command));
  }

  respond(message: Record<string, unknown>): void {
    if (this.readyState === FakeSocket.OPEN) this.#emit("message", { data: JSON.stringify(message) });
  }

  close(): void {
    this.readyState = 3;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      if (listener.once)
        this.#listeners.set(
          type,
          (this.#listeners.get(type) ?? []).filter((l) => l !== listener),
        );
      listener.callback(event);
    }
  }
}

export function useFakeChrome(chrome: FakeChrome): () => void {
  const realFetch = globalThis.fetch;
  const realWebSocket = globalThis.WebSocket;
  globalThis.fetch = chrome.fetch as typeof fetch;
  globalThis.WebSocket = class extends FakeSocket {
    constructor(url: string) {
      super(chrome, chrome.pages.find((p) => p.wsUrl === url) ?? null);
    }
  } as unknown as typeof WebSocket;
  return () => {
    globalThis.fetch = realFetch;
    globalThis.WebSocket = realWebSocket;
  };
}
