import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadConfig } from "../../src/config.ts";
import { parseQuantity } from "../../src/domain/cart.ts";
import { SessionExpiredError, SiteBlockedError, TransientError } from "../../src/domain/errors.ts";
import { RetryingStore, withRetry } from "../../src/infrastructure/http/retrying-store.ts";
import { ThrottledHttp } from "../../src/infrastructure/http/throttled-http.ts";
import { InMemoryStore } from "../../src/infrastructure/retailers/memory/in-memory-store.ts";
import { CATALOGUE, SPAGHETTI } from "../support/catalogue.ts";
import { FakeHttp, ok } from "../support/fake-http.ts";

describe("withRetry", () => {
  it("retries transient errors with exponential backoff", async () => {
    const delays: number[] = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        if (++calls < 3) throw new TransientError("network");
        return "ok";
      },
      { baseDelayMs: 100, sleep: async (ms: number) => void delays.push(ms) },
    );
    assert.equal(result, "ok");
    assert.deepEqual(delays, [100, 200]);
  });

  it("gives up after the planned number of attempts", async () => {
    let calls = 0;
    const failing = () => {
      calls++;
      return Promise.reject(new TransientError("network"));
    };
    await assert.rejects(withRetry(failing, { retries: 2, sleep: async () => {} }), TransientError);
    assert.equal(calls, 3);
  });

  it("retries neither a permanent error, nor an anti-bot block, nor an unknown error", async () => {
    let calls = 0;
    const fail = (error: Error) => () => {
      calls++;
      return Promise.reject(error);
    };
    await assert.rejects(withRetry(fail(new SessionExpiredError("X")), { sleep: async () => {} }), SessionExpiredError);
    await assert.rejects(withRetry(fail(new SiteBlockedError("X")), { sleep: async () => {} }), SiteBlockedError);
    await assert.rejects(withRetry(fail(new Error("bug")), { sleep: async () => {} }), /bug/);
    assert.equal(calls, 3);
  });
});

describe("RetryingStore", () => {
  it("delegates every method to the decorated store", async () => {
    const location = {
      distanceKm: null,
      id: "1",
      name: "Testville",
      postalCode: "00000",
      serviceType: "drive",
    } as const;
    const inner = new InMemoryStore(CATALOGUE, { locations: [location] });
    const store = new RetryingStore(inner);
    assert.equal(store.capabilities, inner.capabilities);
    await store.setQuantity(SPAGHETTI.id, parseQuantity(2));
    assert.equal((await store.getCart()).lines[0]?.quantity, 2);
    assert.equal((await store.search("spaghetti", 5)).total, 1);
    assert.equal((await store.getOrderConditions()).store, null);
    assert.equal((await store.getProduct(SPAGHETTI.id)).name, SPAGHETTI.name);
    assert.deepEqual(await store.findStores("00000"), [location]);
    assert.deepEqual(await store.selectStore("1"), location);
  });
});

describe("ThrottledHttp", () => {
  it("serializes requests and spaces them by the minimum delay plus jitter", async () => {
    let clock = 1000;
    const sleeps: number[] = [];
    const http = new ThrottledHttp(new FakeHttp(() => ok("")), {
      jitterMs: 100,
      minIntervalMs: 500,
      now: () => clock,
      random: () => 0.5,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    });
    await Promise.all([http.request("/a"), http.request("/b"), http.request("/c")]);
    assert.deepEqual(sleeps, [550, 550], "first request immediate, then 500 + 50 ms");
  });

  it("a failed request does not block the queue", async () => {
    const http = new ThrottledHttp(
      new FakeHttp((url) => {
        if (url === "/ko") throw new TransientError("network");
        return ok("fini");
      }),
      { jitterMs: 0, minIntervalMs: 0, sleep: async () => {} },
    );
    await assert.rejects(http.request("/ko"), TransientError);
    assert.equal((await http.request("/ok")).body, "fini");
  });
});

describe("loadConfig", () => {
  const leclerc = { host: "fd7-courses.leclercdrive.fr", retrievalPointId: "123456", storeId: "123456" };

  it("without a file: Super U only, Chrome 9222", () => {
    const config = loadConfig({});
    assert.equal(config.chromePort, 9222);
    assert.equal(config.timeoutMs, 30_000);
    assert.deepEqual(config.stores, [{ minIntervalMs: 300, retailer: "superu" }]);
    assert.match(config.stateDir, /\.fr-grocery-mcp$/);
  });

  it("reads the file named by FR_GROCERY_CONFIG, the environment wins for the port", () => {
    const file = JSON.stringify({
      chrome: { port: 9333 },
      stores: [{ retailer: "leclerc", store: leclerc }, { retailer: "superu" }],
    });
    const config = loadConfig({ FR_GROCERY_CONFIG: "/c.json", FR_GROCERY_STATE_DIR: "/state" }, () => file);
    assert.equal(config.chromePort, 9333);
    assert.equal(config.stateDir, "/state");
    assert.deepEqual(
      config.stores.map((s) => s.retailer),
      ["leclerc", "superu"],
    );
    assert.equal(
      loadConfig({ FR_GROCERY_CHROME_PORT: "9444", FR_GROCERY_CONFIG: "/c.json" }, () => file).chromePort,
      9444,
    );
  });

  it("rejects an invalid or unreadable configuration", () => {
    const read = (content: string) => () => content;
    assert.throws(() => loadConfig({ FR_GROCERY_CHROME_PORT: "abc" }), /Invalid configuration/);
    assert.throws(() => loadConfig({ FR_GROCERY_CONFIG: "/c.json" }, read("{")), /Unreadable configuration/);
    assert.throws(
      () => loadConfig({ FR_GROCERY_CONFIG: "/c.json" }, read(JSON.stringify({ stores: [{ retailer: "carrefour" }] }))),
      /Invalid configuration/,
    );
    const twice = JSON.stringify({ stores: [{ retailer: "superu" }, { retailer: "superu" }] });
    assert.throws(() => loadConfig({ FR_GROCERY_CONFIG: "/c.json" }, read(twice)), /duplicate retailer/);
    const badHost = JSON.stringify({ stores: [{ retailer: "leclerc", store: { ...leclerc, host: "evil.example" } }] });
    assert.throws(() => loadConfig({ FR_GROCERY_CONFIG: "/c.json" }, read(badHost)), /Invalid configuration/);
  });
});
