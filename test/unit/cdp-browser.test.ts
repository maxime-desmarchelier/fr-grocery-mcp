import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { SessionExpiredError, TransientError } from "../../src/domain/errors.ts";
import { CdpBrowser } from "../../src/infrastructure/browser/cdp-browser.ts";
import { FakeChrome, useFakeChrome } from "../support/fake-chrome.ts";

const SUPERU = "https://www.coursesu.com";
const LECLERC = "https://fd7-courses.leclercdrive.fr";

function setup(t: TestContext, options: { timeoutMs?: number } = {}) {
  const chrome = new FakeChrome();
  t.after(useFakeChrome(chrome));
  const browser = new CdpBrowser({ port: 9222, timeoutMs: options.timeoutMs ?? 5000 });
  return { browser, chrome };
}

function onSite(chrome: FakeChrome, origin: string, body = "ok") {
  return chrome.addPage({ onFetch: () => ({ body, status: 200 }), url: `${origin}/` });
}

describe("CdpBrowser: fetching from the site's tab", () => {
  it("returns the status and body fetched with the site's cookies", async (t) => {
    const { browser, chrome } = setup(t);
    onSite(chrome, SUPERU, '{"lines":[]}');
    const response = await browser.tab(SUPERU, "/").request(`${SUPERU}/api/cart`);
    assert.deepEqual(response, { body: '{"lines":[]}', status: 200 });
    const page = chrome.pages[0];
    assert.match(page?.fetchExpressions[0] ?? "", /credentials: "include"/);
  });

  it("forwards the method and body of a POST to the page", async (t) => {
    const { browser, chrome } = setup(t);
    onSite(chrome, SUPERU);
    await browser.tab(SUPERU, "/").request(`${SUPERU}/cart`, { body: "qty=2", method: "POST" });
    const expression = chrome.pages[0]?.fetchExpressions[0] ?? "";
    assert.match(expression, /"method":"POST"/);
    assert.match(expression, /"body":"qty=2"/);
  });

  it("shares one tab per site and connects only once, ignoring unrelated targets", async (t) => {
    const { browser, chrome } = setup(t);
    onSite(chrome, SUPERU);
    chrome.extraTargets.push(
      { type: "page", url: "not a url", webSocketDebuggerUrl: "ws://elsewhere" },
      { type: "service_worker", url: `${SUPERU}/sw.js`, webSocketDebuggerUrl: "ws://worker" },
    );
    const tab = browser.tab(SUPERU, "/");
    await tab.request(`${SUPERU}/a`);
    await tab.request(`${SUPERU}/b`);
    assert.equal(chrome.socketsOpened, 1, "the connection is reused");
    assert.equal(chrome.listCalls, 1, "the tab is looked up once");
  });

  it("navigates back to the site before requesting, without touching another retailer's tab", async (t) => {
    const { browser, chrome } = setup(t);
    // Same host but another scheme: the tab exists, yet is no longer on the site's origin.
    const superu = chrome.addPage({
      onFetch: () => ({ body: "superu", status: 200 }),
      url: `http://www.coursesu.com/`,
    });
    const leclerc = onSite(chrome, LECLERC, "leclerc");
    const response = await browser.tab(SUPERU, "/").request(`${SUPERU}/api`);
    assert.equal(response.body, "superu");
    assert.deepEqual(superu.navigations, [`${SUPERU}/`], "the drifted tab is brought back home first");
    assert.deepEqual(leclerc.navigations, [], "another retailer's tab is never navigated");
  });

  it("opens a tab on demand and waits for it to load before requesting", async (t) => {
    const { browser, chrome } = setup(t);
    const response = await browser.tab(SUPERU, "/panier").request(`${SUPERU}/api`);
    assert.equal(response.status, 200);
    assert.deepEqual(chrome.newTabCalls, [`${SUPERU}/panier`]);
  });
});

describe("CdpBrowser: what the agent is told when things go wrong", () => {
  it("an unreachable Chrome is a retryable error that says how to start it", async (t) => {
    const { browser, chrome } = setup(t);
    chrome.targetsError = new TypeError("fetch failed");
    await assert.rejects(browser.tab(SUPERU, "/").request(`${SUPERU}/api`), (error: unknown) => {
      assert.ok(error instanceof TransientError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /9222/);
      return true;
    });
  });

  it("a Chrome that cannot open a tab means the user must log in: not retryable", async (t) => {
    const { browser, chrome } = setup(t);
    chrome.newTabStatus = 500;
    await assert.rejects(browser.tab(SUPERU, "/").request(`${SUPERU}/api`), (error: unknown) => {
      assert.ok(error instanceof SessionExpiredError);
      assert.equal(error.retryable, false);
      assert.match(error.message, /www\.coursesu\.com/);
      return true;
    });
  });

  it("a dropped connection fails the pending request, then the next one reconnects", async (t) => {
    const { browser, chrome } = setup(t);
    const page = onSite(chrome, SUPERU);
    const tab = browser.tab(SUPERU, "/");
    page.dropNextCommand = true;
    await assert.rejects(tab.request(`${SUPERU}/api`), (error: unknown) => {
      assert.ok(error instanceof TransientError);
      assert.equal(error.retryable, true);
      assert.match(error.message, /closed/);
      return true;
    });
    assert.equal((await tab.request(`${SUPERU}/api`)).status, 200);
    assert.equal(chrome.socketsOpened, 2, "a fresh connection is made");
  });

  it("a command that never answers times out instead of hanging", async (t) => {
    const { browser, chrome } = setup(t, { timeoutMs: 50 });
    onSite(chrome, SUPERU).hang = true;
    await assert.rejects(browser.tab(SUPERU, "/").request(`${SUPERU}/api`), /Timed out/);
  });

  it("an exception thrown in the page is retryable, and does not block the next request", async (t) => {
    const { browser, chrome } = setup(t);
    const page = onSite(chrome, SUPERU);
    const tab = browser.tab(SUPERU, "/");
    page.exceptionOnce = "boom";
    await assert.rejects(tab.request(`${SUPERU}/api`), (error: unknown) => {
      assert.ok(error instanceof TransientError);
      assert.match(error.message, /boom/);
      return true;
    });
    assert.equal((await tab.request(`${SUPERU}/api`)).status, 200);
  });

  it("a CDP protocol error is reported with the failing command", async (t) => {
    const { browser, chrome } = setup(t);
    onSite(chrome, SUPERU).protocolErrorOnce = "Unknown method";
    await assert.rejects(browser.tab(SUPERU, "/").request(`${SUPERU}/api`), /CDP Runtime\.evaluate: Unknown method/);
  });

  it("a page response that is not a status/body pair is rejected", async (t) => {
    const { browser, chrome } = setup(t);
    onSite(chrome, SUPERU).emptyFetchResponse = true;
    await assert.rejects(browser.tab(SUPERU, "/").request(`${SUPERU}/api`), /Empty or unreadable/);
  });

  it("gives up when the site never finishes loading", async (t) => {
    const { browser, chrome } = setup(t, { timeoutMs: 600 });
    chrome.addPage({ readyState: "loading", url: `http://www.coursesu.com/` });
    await assert.rejects(browser.tab(SUPERU, "/").request(`${SUPERU}/api`), /took too long/);
  });
});

describe("CdpBrowser: one queue for every tab", () => {
  it("serializes operations even across two sites", async (t) => {
    const { browser, chrome } = setup(t);
    chrome.latencyMs = 25;
    onSite(chrome, SUPERU, "superu");
    onSite(chrome, LECLERC, "leclerc");
    const [a, b] = await Promise.all([
      browser.tab(SUPERU, "/").request(`${SUPERU}/api`),
      browser.tab(LECLERC, "/").request(`${LECLERC}/api`),
    ]);
    assert.equal(a.body, "superu");
    assert.equal(b.body, "leclerc");
    assert.equal(chrome.maxInFlight, 1, "no two CDP commands are ever in flight at once");
  });

  it("close() releases every tab connection", async (t) => {
    const { browser, chrome } = setup(t);
    onSite(chrome, SUPERU);
    onSite(chrome, LECLERC);
    await browser.tab(SUPERU, "/").request(`${SUPERU}/api`);
    await browser.tab(LECLERC, "/").request(`${LECLERC}/api`);
    browser.close();
    assert.equal(chrome.sockets.length, 2);
    assert.ok(chrome.sockets.every((s) => s.readyState === 3));
  });
});
