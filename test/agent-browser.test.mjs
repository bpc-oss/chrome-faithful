import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { ChromeTab, createAgent, createTabWithNavigation, Locator } from "../src/agent-browser.mjs";
import { savePageAsset } from "../src/page-asset.mjs";
import { runCuaScrollCapture } from "../src/scroll-capture.mjs";
import { runScrollAssetCapture, summarizeAssetCaptureManifest } from "../src/scroll-asset-capture.mjs";
import { TabMutationQueue } from "../src/tab-mutation-queue.mjs";

class FakeRouter {
  list() {
    return [
      { profileName: "Profile Alpha", extensionId: "one", version: "0.2.0", buildId: "build-alpha", bindingVerified: true, verifiedProfileDirectory: "Default", secret: "hidden" },
      { profileName: "Profile Beta", extensionId: "two", version: "0.2.0", buildId: "build-beta", bindingVerified: false, verifiedProfileDirectory: "must-not-leak", secret: "hidden" }
    ];
  }
  async request(profileName, method, params) {
    if (method === "tabs.list") return [{ id: "7", title: profileName, url: "https://example.com" }];
    if (method === "tabs.get") return { id: String(params.tabId), title: profileName, url: "https://example.com" };
    throw new Error(`unmocked ${method}`);
  }
}

test("lists extension targets with exact profile metadata", async () => {
  const agent = createAgent(new FakeRouter());
  const targets = await agent.browsers.list();
  assert.deepEqual(targets.map((x) => x.metadata), [
    {
      profileName: "Profile Alpha",
      extensionId: "one",
      version: "0.2.0",
      buildId: "build-alpha",
      bindingVerified: true,
      verifiedProfileDirectory: "Default"
    },
    {
      profileName: "Profile Beta",
      extensionId: "two",
      version: "0.2.0",
      buildId: "build-beta",
      bindingVerified: false,
      verifiedProfileDirectory: null
    }
  ]);
  assert.ok(targets.every((x) => x.type === "extension"));
});

test("binds one exact profile and keeps browserId stable", async () => {
  const agent = createAgent(new FakeRouter());
  const browser = await agent.browsers.get("extension:Profile Beta");
  assert.equal(browser.browserId, "extension:Profile Beta");
  assert.equal((await browser.tabs.list())[0].title, "Profile Beta");
});

test("finalize closes only agent-created tabs and preserves user tabs", async () => {
  const open = new Map([
    ["7", { id: "7", title: "User tab", url: "https://user.example/" }]
  ]);
  const removed = [];
  let nextId = 8;
  const router = new FakeRouter();
  router.request = async (_profileName, method, params) => {
    if (method === "tabs.list") return [...open.values()];
    if (method === "tabs.new") {
      const id = String(nextId++);
      const info = { id, title: "Agent tab", url: "about:blank" };
      open.set(id, info);
      return info;
    }
    if (method === "tabs.get") return open.get(String(params.tabId));
    if (method === "tabs.remove") {
      removed.push(String(params.tabId));
      open.delete(String(params.tabId));
      return null;
    }
    throw new Error(`unmocked ${method}`);
  };

  const agent = createAgent(router);
  const browser = await agent.browsers.get("extension:Profile Beta");
  const disposable = await browser.tabs.new();
  const handoff = await browser.tabs.new();
  await handoff.markHandoff();

  const sameBrowser = await agent.browsers.get("extension:Profile Beta");
  assert.equal(sameBrowser, browser);
  const result = await sameBrowser.tabs.finalize();

  assert.deepEqual(result, {
    closedTabIds: [disposable.id],
    preservedTabIds: [handoff.id],
    ownedOpenTabIds: [handoff.id],
    closeFailures: []
  });
  assert.deepEqual(removed, [disposable.id]);
  assert.ok(open.has("7"), "pre-existing user tab must never be closed by finalize");
  assert.ok(open.has(handoff.id), "explicit handoff tab must remain open");

  await handoff.close();
  assert.deepEqual(removed, [disposable.id, handoff.id]);
  assert.deepEqual(await browser.tabs.finalize(), {
    closedTabIds: [],
    preservedTabIds: [],
    ownedOpenTabIds: [],
    closeFailures: []
  });
});

test("finalize retries tabs.remove when the first attempt fails and verifies closure", async () => {
  const open = new Map();
  let nextId = 1;
  const removeCalls = [];
  const router = new FakeRouter();
  router.request = async (_profileName, method, params) => {
    if (method === "tabs.list") return [...open.values()];
    if (method === "tabs.new") {
      const id = String(nextId++);
      const info = { id, title: "Agent tab", url: "about:blank" };
      open.set(id, info);
      return info;
    }
    if (method === "tabs.remove") {
      removeCalls.push(String(params.tabId));
      // First remove attempt fails (extension API timeout under load); the
      // second attempt succeeds.
      if (removeCalls.filter((id) => id === String(params.tabId)).length === 1) {
        throw new Error("Chrome API timed out: remove");
      }
      open.delete(String(params.tabId));
      return null;
    }
    throw new Error(`unmocked ${method}`);
  };

  const agent = createAgent(router);
  const browser = await agent.browsers.get("extension:Profile Beta");
  const tab = await browser.tabs.new();
  const result = await browser.tabs.finalize();
  assert.deepEqual(result.closedTabIds, [tab.id]);
  assert.deepEqual(result.closeFailures, []);
  assert.equal(removeCalls.filter((id) => id === tab.id).length, 2, "must retry the failed remove");
});


test("finalize keeps unclosed tabs owned and reports closeFailures", async () => {
  const open = new Map();
  let nextId = 1;
  let removeFails = true;
  const router = new FakeRouter();
  router.request = async (_profileName, method, params) => {
    if (method === "tabs.list") return [...open.values()];
    if (method === "tabs.new") {
      const id = String(nextId++);
      const info = { id, title: "Agent tab", url: "about:blank" };
      open.set(id, info);
      return info;
    }
    if (method === "tabs.remove") {
      if (removeFails) throw new Error("Chrome API timed out: remove");
      open.delete(String(params.tabId));
      return null;
    }
    throw new Error(`unmocked ${method}`);
  };

  const agent = createAgent(router);
  const browser = await agent.browsers.get("extension:Profile Beta");
  const tab = await browser.tabs.new();
  const first = await browser.tabs.finalize();
  assert.deepEqual(first.closedTabIds, []);
  assert.equal(first.closeFailures.length, 1);
  assert.equal(first.closeFailures[0].tabId, tab.id);
  assert.deepEqual(first.ownedOpenTabIds, [tab.id], "unclosed tab must remain owned so a later finalize can retry");
  assert.ok(open.has(tab.id), "tab must still be open");

  // A later finalize pass (after the extension recovers) closes it.
  removeFails = false;
  const second = await browser.tabs.finalize();
  assert.deepEqual(second.closedTabIds, [tab.id]);
  assert.deepEqual(second.closeFailures, []);
  assert.deepEqual(second.ownedOpenTabIds, []);
});


test("close() throws after persistent tabs.remove failure and keeps the tab owned", async () => {
  const open = new Map();
  let nextId = 1;
  const router = new FakeRouter();
  router.request = async (_profileName, method, params) => {
    if (method === "tabs.list") return [...open.values()];
    if (method === "tabs.new") {
      const id = String(nextId++);
      const info = { id, title: "Agent tab", url: "about:blank" };
      open.set(id, info);
      return info;
    }
    if (method === "tabs.remove") throw new Error("Chrome API timed out: remove");
    throw new Error(`unmocked ${method}`);
  };

  const agent = createAgent(router);
  const browser = await agent.browsers.get("extension:Profile Beta");
  const tab = await browser.tabs.new();
  await assert.rejects(() => tab.close(), /could not be closed/);
  const result = await browser.tabs.finalize();
  assert.deepEqual(result.closeFailures.map((f) => f.tabId), [tab.id]);
  assert.deepEqual(result.ownedOpenTabIds, [tab.id]);
});


test("page evaluate accepts direct expressions and function strings", async () => {
  const tab = new ChromeTab({
    evaluate: async (_tabId, expression) => {
      return Function("document", "location", `return (${expression});`)(
        { title: "Fixture Studio" },
        { href: "https://example.test/tiktokstudio/content" }
      );
    }
  }, { id: "7" });

  assert.deepEqual(
    await tab.playwright.evaluate("({ title: document.title, studio: location.href.includes('tiktokstudio/content') })"),
    { title: "Fixture Studio", studio: true }
  );
  assert.equal(
    await tab.playwright.evaluate("(value) => document.title + ':' + value", "ok"),
    "Fixture Studio:ok"
  );
});

test("activates only the requested tab in the exact profile", async () => {
  const calls = [];
  const router = new FakeRouter();
  router.request = async (profileName, method, params) => {
    calls.push([profileName, method, params]);
    if (method === "tabs.get") {
      return { id: String(params.tabId), title: profileName, url: "https://example.com" };
    }
    if (method === "tabs.activate") {
      return { id: String(params.tabId), title: profileName, url: "https://example.com", active: true };
    }
    throw new Error(`unmocked ${method}`);
  };

  const browser = await createAgent(router).browsers.get("extension:Profile Alpha");
  const tab = await browser.tabs.activate("7");

  assert.equal(tab.id, "7");
  assert.deepEqual(calls, [
    ["Profile Alpha", "tabs.get", { tabId: "7" }],
    ["Profile Alpha", "tabs.activate", { tabId: "7" }]
  ]);
});

test("goto activates the exact tab and waits for a new visible document when navigating to the same URL", async () => {
  const calls = [];
  const url = "https://studio.youtube.com/video/dA_wyurD4hM/edit";
  let navigationStarted = false;
  let navigationPolls = 0;
  const tab = new ChromeTab({
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "tabs.activate") return { id: "7", url, active: true };
      if (method === "tabs.get") return { id: "7", url, status: navigationStarted ? "complete" : "complete" };
      if (method === "debugger.detach") return null;
      if (method === "tabs.reload") {
        navigationStarted = true;
        return null;
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async (_tabId, method, params) => {
      calls.push([method, params]);
      return {};
    },
    evaluate: async () => {
      if (!navigationStarted) {
        return { href: url, readyState: "complete", visibilityState: "visible", timeOrigin: 100 };
      }
      navigationPolls += 1;
      return {
        href: url,
        readyState: "complete",
        visibilityState: "visible",
        timeOrigin: navigationPolls < 2 ? 100 : 200
      };
    }
  }, { id: "7" });

  const result = await tab.goto(url, { timeoutMs: 5000 });

  assert.equal(result.timeOrigin, 200);
  assert.ok(calls.some(([method]) => method === "tabs.reload"));
  assert.ok(!calls.some(([method]) => method === "tabs.update"));
  const methods = calls.map(([method]) => method);
  assert.ok(methods.indexOf("Page.bringToFront") > methods.indexOf("tabs.reload"));
  assert.ok(methods.indexOf("Emulation.setFocusEmulationEnabled") > methods.indexOf("tabs.reload"));
});

test("goto accepts a committed hidden about:blank document", async () => {
  const url = "about:blank";
  let navigationStarted = false;
  const tab = new ChromeTab({
    request: async (method) => {
      if (method === "tabs.activate") return { id: "7", url, active: true };
      if (method === "tabs.get") return { id: "7", url, status: "complete" };
      if (method === "debugger.detach") return null;
      if (method === "tabs.reload") {
        navigationStarted = true;
        return null;
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async () => ({}),
    evaluate: async () => ({
      href: url,
      readyState: "complete",
      visibilityState: "hidden",
      timeOrigin: navigationStarted ? 200 : 100
    })
  }, { id: "7" });

  const result = await tab.goto(url, { timeoutMs: 1000 });

  assert.equal(result.href, url);
  assert.equal(result.visibilityState, "hidden");
});

test("goto accepts a committed hidden ordinary web document", async () => {
  const oldUrl = "about:blank";
  const targetUrl = "https://studio.youtube.com/channel/abc/videos/short";
  let navigationStarted = false;
  const calls = [];
  const tab = new ChromeTab({
    request: async (method) => {
      calls.push(method);
      if (method === "tabs.activate") return { id: "7", url: oldUrl, active: true };
      if (method === "tabs.get") return {
        id: "7",
        url: navigationStarted ? targetUrl : oldUrl,
        status: "complete"
      };
      if (method === "debugger.detach") return null;
      if (method === "tabs.update") {
        navigationStarted = true;
        return { id: "7", url: targetUrl, status: "loading" };
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async (_tabId, method) => {
      calls.push(method);
      return {};
    },
    evaluate: async () => ({
      href: navigationStarted ? targetUrl : oldUrl,
      readyState: "complete",
      visibilityState: "hidden",
      timeOrigin: navigationStarted ? 200 : 100
    })
  }, { id: "7" });

  const result = await tab.goto(targetUrl, { timeoutMs: 1000 });

  assert.equal(result.href, targetUrl);
  assert.equal(result.visibilityState, "hidden");
  assert.equal(calls.filter((method) => method === "Page.bringToFront").length, 1);
  assert.equal(calls.filter((method) => method === "Emulation.setFocusEmulationEnabled").length, 1);
  assert.ok(calls.indexOf("Page.bringToFront") > calls.indexOf("tabs.update"));
  assert.ok(calls.indexOf("Emulation.setFocusEmulationEnabled") > calls.indexOf("tabs.update"));
});

test("goto accepts a committed SPA document that stays at readyState loading", async () => {
  const oldUrl = "about:blank";
  const targetUrl = "https://www.tiktok.com/tiktokstudio/content";
  let navigationStarted = false;
  const tab = new ChromeTab({
    request: async (method) => {
      if (method === "tabs.activate") return { id: "7", url: oldUrl, active: true };
      if (method === "tabs.get") return { id: "7", url: navigationStarted ? targetUrl : oldUrl, status: "loading" };
      if (method === "debugger.detach") return null;
      if (method === "tabs.update") {
        navigationStarted = true;
        return null;
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async () => ({}),
    evaluate: async () => ({
      href: navigationStarted ? targetUrl : oldUrl,
      readyState: navigationStarted ? "loading" : "complete",
      visibilityState: "visible",
      timeOrigin: navigationStarted ? 200 : 100
    })
  }, { id: "7" });

  const started = Date.now();
  const result = await tab.goto(targetUrl, { timeoutMs: 4000 });
  const elapsed = Date.now() - started;

  assert.equal(result.href, targetUrl);
  assert.equal(result.readyState, "loading");
  assert.ok(elapsed >= 1500, `SPA settle should wait at least 1500ms, took ${elapsed}`);
});

test("hidden same-URL reload waits for a new document timeOrigin", async () => {
  const url = "https://studio.youtube.com/channel/abc/videos/short";
  let navigationStarted = false;
  let navigationPolls = 0;
  const tab = new ChromeTab({
    request: async (method) => {
      if (method === "tabs.activate") return { id: "7", url, active: true };
      if (method === "tabs.get") return { id: "7", url, status: "complete" };
      if (method === "debugger.detach") return null;
      if (method === "tabs.reload") {
        navigationStarted = true;
        return null;
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async () => ({}),
    evaluate: async () => {
      if (!navigationStarted) {
        return { href: url, readyState: "complete", visibilityState: "hidden", timeOrigin: 100 };
      }
      navigationPolls += 1;
      return {
        href: url,
        readyState: "complete",
        visibilityState: "hidden",
        timeOrigin: navigationPolls < 2 ? 100 : 200
      };
    }
  }, { id: "7" });

  const result = await tab.goto(url, { timeoutMs: 1000 });

  assert.equal(result.timeOrigin, 200);
  assert.ok(navigationPolls >= 2);
});

test("createTabWithNavigation rolls back a newly created tab when navigation fails", async () => {
  const calls = [];
  const tab = {
    id: "91",
    goto: async () => {
      calls.push("goto");
      throw new Error("navigation failed");
    },
    close: async () => calls.push("close")
  };
  const browser = { tabs: { new: async () => {
    calls.push("new");
    return tab;
  } } };

  await assert.rejects(
    createTabWithNavigation(browser, "https://example.test/target"),
    /navigation failed/
  );
  assert.deepEqual(calls, ["new", "goto", "close"]);
});

test("createTabWithNavigation preserves a successfully navigated new tab", async () => {
  const calls = [];
  const tab = {
    id: "92",
    goto: async (url) => calls.push(["goto", url]),
    close: async () => calls.push(["close"])
  };
  const browser = { tabs: { new: async () => tab } };

  assert.equal(
    await createTabWithNavigation(browser, "https://example.test/target"),
    tab
  );
  assert.deepEqual(calls, [["goto", "https://example.test/target"]]);
});

test("goto does not accept the previous complete document before the requested URL commits", async () => {
  const calls = [];
  const oldUrl = "https://studio.youtube.com/channel/content";
  const targetUrl = "https://studio.youtube.com/video/dA_wyurD4hM/edit";
  let navigationStarted = false;
  let navigationPolls = 0;
  const tab = new ChromeTab({
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "tabs.activate") return { id: "7", url: oldUrl, active: true };
      if (method === "tabs.get") {
        return {
          id: "7",
          url: navigationStarted && navigationPolls >= 2 ? targetUrl : oldUrl,
          status: navigationStarted && navigationPolls >= 2 ? "complete" : "loading"
        };
      }
      if (method === "tabs.update") {
        navigationStarted = true;
        return { id: "7", url: targetUrl, status: "loading" };
      }
      if (method === "debugger.detach") return null;
      throw new Error(`unmocked ${method}`);
    },
    cdp: async (_tabId, method, params) => {
      calls.push([method, params]);
      return {};
    },
    evaluate: async () => {
      if (!navigationStarted) {
        return { href: oldUrl, readyState: "complete", visibilityState: "visible", timeOrigin: 100 };
      }
      navigationPolls += 1;
      if (navigationPolls < 2) {
        return { href: oldUrl, readyState: "complete", visibilityState: "visible", timeOrigin: 100 };
      }
      return { href: targetUrl, readyState: "interactive", visibilityState: "visible", timeOrigin: 200 };
    }
  }, { id: "7" });

  const result = await tab.goto(targetUrl, { timeoutMs: 5000 });

  assert.equal(result.href, targetUrl);
  assert.ok(navigationPolls >= 2);
  assert.ok(calls.some(([method]) => method === "tabs.update"));
  assert.ok(!calls.some(([method]) => method === "tabs.reload"));
});

test("goto treats platform-added query parameters as the same route and reloads", async () => {
  const requestedUrl = "https://studio.youtube.com/channel/abc/videos/upload?d=ud";
  const actualUrl = `${requestedUrl}&filter=%5B%5D&sort=descending`;
  let navigationStarted = false;
  const calls = [];
  const tab = new ChromeTab({
    request: async (method, params) => {
      calls.push([method, params]);
      if (method === "tabs.activate") return { id: "7", url: actualUrl, active: true };
      if (method === "tabs.get") return { id: "7", url: actualUrl, status: "loading" };
      if (method === "debugger.detach") return null;
      if (method === "tabs.reload") {
        navigationStarted = true;
        return null;
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async () => ({}),
    evaluate: async () => ({
      href: actualUrl,
      readyState: "interactive",
      visibilityState: "visible",
      timeOrigin: navigationStarted ? 200 : 100
    })
  }, { id: "7" });

  const result = await tab.goto(requestedUrl, { timeoutMs: 1000 });

  assert.equal(result.href, actualUrl);
  assert.ok(calls.some(([method]) => method === "debugger.detach"));
  assert.ok(calls.some(([method]) => method === "tabs.reload"));
  assert.ok(!calls.some(([method]) => method === "tabs.update"));
});

test("navigation accepts an interactive visible SPA document while tab status remains loading", async () => {
  const oldUrl = "https://studio.youtube.com/video/abc/edit";
  const targetUrl = "https://studio.youtube.com/channel/abc/videos/short";
  let navigationStarted = false;
  const tab = new ChromeTab({
    request: async (method) => {
      if (method === "tabs.activate") return { id: "7", url: oldUrl, active: true };
      if (method === "tabs.get") {
        return { id: "7", url: navigationStarted ? targetUrl : oldUrl, status: "loading" };
      }
      if (method === "debugger.detach") return null;
      if (method === "tabs.update") {
        navigationStarted = true;
        return { id: "7", url: targetUrl, status: "loading" };
      }
      throw new Error(`unmocked ${method}`);
    },
    cdp: async () => ({}),
    evaluate: async () => ({
      href: navigationStarted ? targetUrl : oldUrl,
      readyState: "interactive",
      visibilityState: "visible",
      timeOrigin: navigationStarted ? 200 : 100
    })
  }, { id: "7" });

  const result = await tab.goto(targetUrl, { timeoutMs: 1000 });
  assert.equal(result.href, targetUrl);
});

test("waitForLoadState retries while the navigation execution context is unavailable", async () => {
  let attempts = 0;
  const tab = new ChromeTab({
    evaluate: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Execution context was destroyed");
      return "interactive";
    }
  }, { id: "7" });

  await tab.waitForLoadState({ state: "domcontentloaded", timeoutMs: 1000 });
  assert.equal(attempts, 2);
});

test("does not choose a default across multiple profiles", async () => {
  const agent = createAgent(new FakeRouter());
  await assert.rejects(agent.browsers.getDefault(), /No unique default/);
});

test("click waits for a locator to become visible before acting", async () => {
  const calls = [];
  const locator = new Locator({
    id: "7",
    ensurePageVisible: async () => calls.push(["ensurePageVisible"]),
    transport: {
      cdp: async (_tabId, method, params) => calls.push([method, params.type])
    }
  }, { steps: [{ type: "css", selector: "#ready" }] });
  locator.waitFor = async (options) => calls.push(["waitFor", options]);
  locator.query = async () => {
    calls.push(["scrollAndMeasure"]);
    return { x: 10, y: 10, width: 20, height: 20 };
  };

  await locator.click({ timeoutMs: 4321 });

  assert.deepEqual(calls, [
    ["ensurePageVisible"],
    ["waitFor", { state: "visible", timeoutMs: 4321 }],
    ["scrollAndMeasure"],
    ["Input.dispatchMouseEvent", "mousePressed"],
    ["Input.dispatchMouseEvent", "mouseReleased"]
  ]);
});

test("click scrolls before measuring coordinates so offscreen form controls receive real input", async () => {
  const calls = [];
  let scrollExpression = "";
  const locator = new Locator({
    id: "7",
    transport: {
      cdp: async (_tabId, method, params) => calls.push([method, params])
    }
  }, { steps: [{ type: "css", selector: "#offscreen-title" }] });
  locator.waitFor = async () => {};
  locator.query = async (expression) => {
    scrollExpression = expression;
    calls.push(["scrollAndMeasure"]);
    return { x: 320, y: 240, width: 120, height: 30 };
  };

  await locator.click();

  assert.deepEqual(calls[0], ["scrollAndMeasure"]);
  assert.equal(calls[1][0], "Input.dispatchMouseEvent");
  assert.equal(calls[1][1].x, 320);
  assert.equal(calls[1][1].y, 240);
  assert.match(scrollExpression, /ancestor\.scrollTop/);
  assert.match(scrollExpression, /ancestor\.scrollLeft/);
  assert.match(scrollExpression, /root\?\.host/);
});

test("click rejects a CSS-visible target intercepted by a dialog", async () => {
  const calls = [];
  const locator = new Locator({
    id: "7",
    transport: {
      cdp: async (_tabId, method) => calls.push(method)
    }
  }, { steps: [{ type: "css", selector: "#background-title" }] });
  locator.waitFor = async () => {};
  locator.query = async () => ({
    x: 320,
    y: 240,
    width: 120,
    height: 30,
    hitTest: false,
    interceptedBy: { tag: "p", id: "visibility-title", role: "" }
  });

  await assert.rejects(locator.click(), /click intercepted by p#visibility-title/);
  assert.deepEqual(calls, []);
});

test("fill selects and clears existing content before inserting replacement text", async () => {
  const events = [];
  let editableValue = "existing";
  const locator = new Locator({
    id: "7",
    transport: {
      cdp: async (_tabId, method, params) => events.push([method, params])
    }
  }, { steps: [{ type: "css", selector: "#title" }] });
  locator.click = async () => {
    throw new Error("fill must not require a pointer click");
  };
  locator.waitFor = async () => events.push(["waitFor"]);
  locator.focusResolvedElement = async () => events.push(["focus"]);
  locator.editableValue = async () => {
    if (events.some(([method]) => method === "Input.insertText")) editableValue = "replacement";
    return { editable: true, kind: "contenteditable", value: editableValue };
  };

  await locator.fill("replacement");

  assert.equal(events[0][0], "waitFor");
  assert.equal(events[1][0], "focus");
  assert.equal(events[3][0], "Input.dispatchKeyEvent");
  assert.equal(events[2][1].key, "A");
  assert.equal(events[2][1].modifiers, 2);
  assert.equal(events[4][1].key, "Backspace");
  assert.equal(events[4][1].code, "Backspace");
  assert.equal(events[4][1].windowsVirtualKeyCode, 8);
  assert.equal(events[6][0], "Input.insertText");
  assert.equal(events[6][1].text, "replacement");
});

test("fill refuses false success when the editable value did not change", async () => {
  const locator = new Locator({
    id: "7",
    transport: { cdp: async () => {} }
  }, { steps: [{ type: "css", selector: "#title" }] });
  locator.waitFor = async () => {};
  locator.focusResolvedElement = async () => {};
  locator.editableValue = async () => ({ editable: true, kind: "contenteditable", value: "" });

  await assert.rejects(locator.fill("replacement"), /fill postcondition failed/);
});

test("press focuses the target without requiring a pointer click", async () => {
  const events = [];
  const locator = new Locator({
    id: "7",
    transport: {
      cdp: async (_tabId, method, params) => events.push([method, params])
    }
  }, { steps: [{ type: "css", selector: "#time-input" }] });
  locator.click = async () => {
    throw new Error("press must not require a pointer click");
  };
  locator.waitFor = async () => events.push(["waitFor"]);
  locator.focusResolvedElement = async () => events.push(["focus"]);

  await locator.press("Enter");

  assert.equal(events[0][0], "waitFor");
  assert.equal(events[1][0], "focus");
  assert.equal(events[2][0], "Input.dispatchKeyEvent");
  assert.equal(events[2][1].key, "Enter");
});

test("serializes mutations for one tab while allowing other tabs to proceed", async () => {
  const queue = new TabMutationQueue();
  const events = [];
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });

  const first = queue.run("Profile Beta", "7", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = queue.run("Profile Beta", "7", async () => {
    events.push("second");
  });
  const other = queue.run("Profile Beta", "8", async () => {
    events.push("other");
  });

  await other;
  assert.deepEqual(events, ["first-start", "other"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "other", "first-end", "second"]);
});

test("CUA scroll accepts CDP delta names and forwards a mouseWheel event", async () => {
  const calls = [];
  const transport = {
    cdp: async (tabId, method, params) => {
      calls.push({ tabId, method, params });
      return { ok: true };
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  await tab.cua.scroll({ x: 1084, y: 506, deltaX: 0, deltaY: 1000 });

  assert.deepEqual(calls, [
    {
      tabId: "77",
      method: "Page.bringToFront",
      params: {}
    },
    {
      tabId: "77",
      method: "Emulation.setFocusEmulationEnabled",
      params: { enabled: true }
    },
    {
      tabId: "77",
      method: "Input.dispatchMouseEvent",
      params: {
        type: "mouseWheel",
        x: 1084,
        y: 506,
        deltaX: 0,
        deltaY: 1000
      }
    }
  ]);
});

test("serial scroll capture defaults to multiple rounds and waits for each wheel before evaluating", async () => {
  const events = [];
  let captureRound = 0;
  const transport = {
    cdp: async (_tabId, method, params) => {
      if (method === "Input.dispatchMouseEvent") {
        events.push(["scroll", params.deltaY]);
        return {};
      }
      if (method === "Runtime.evaluate") {
        events.push(["evaluate", params.expression]);
        if (params.expression === "init()") return { result: { value: { total: 8 } } };
        captureRound += 1;
        return { result: { value: { total: 8 + captureRound, done: captureRound === 2 } } };
      }
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  const result = await runCuaScrollCapture({
    tab,
    x: 1084,
    y: 506,
    deltaY: 300,
    settleMs: 0,
    initializeExpression: "init()",
    captureExpression: "capture()"
  });

  assert.deepEqual(events, [
    ["evaluate", "init()"],
    ["scroll", 300],
    ["evaluate", "capture()"],
    ["scroll", 300],
    ["evaluate", "capture()"]
  ]);
  assert.equal(result.roundsCompleted, 2);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.last, { total: 10, done: true });
});

test("plugin-owned completion requires exact total and consecutive bottom no-new rounds", async () => {
  const values = [
    { total: 247, newCount: 5, atBottom: false },
    { total: 248, newCount: 1, atBottom: true },
    { total: 248, newCount: 0, atBottom: true },
    { total: 248, newCount: 0, atBottom: true },
    { total: 248, newCount: 0, atBottom: true }
  ];
  let index = 0;
  const transport = {
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") return { result: { value: values[index++] } };
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  const result = await runCuaScrollCapture({
    tab,
    x: 1084,
    y: 506,
    deltaY: 700,
    settleMs: 0,
    maxRounds: 20,
    captureExpression: "capture()",
    expectedTotal: 248,
    consecutiveNoNewAtBottom: 3
  });

  assert.equal(result.roundsCompleted, 5);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.last, {
    total: 248,
    newCount: 0,
    atBottom: true,
    noNewAtBottom: 3,
    done: true
  });
});

test("plugin-owned soft-bottom bounce uses only serialized CUA wheel events", async () => {
  const wheelDeltas = [];
  const values = [
    { total: 226, newCount: 0, atBottom: true },
    { total: 256, newCount: 30, atBottom: true },
    { total: 256, newCount: 0, atBottom: true }
  ];
  let index = 0;
  const transport = {
    cdp: async (_tabId, method, params) => {
      if (method === "Input.dispatchMouseEvent") {
        wheelDeltas.push(params.deltaY);
        return {};
      }
      if (method === "Runtime.evaluate") return { result: { value: values[index++] } };
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  const result = await runCuaScrollCapture({
    tab,
    x: 1084,
    y: 506,
    deltaY: 700,
    settleMs: 0,
    maxRounds: 10,
    captureExpression: "capture()",
    expectedTotal: 256,
    consecutiveNoNewAtBottom: 1,
    softBottomBounce: true
  });

  assert.deepEqual(wheelDeltas, [700, -700, 700, 700, 700]);
  assert.equal(result.checkpoints[0].value.softBottomBounce, true);
  assert.equal(result.stopped, true);
  assert.equal(result.last.total, 256);
});

test("durable resume rewinds with serialized CUA wheel events before initialization", async () => {
  const events = [];
  const transport = {
    cdp: async (_tabId, method, params) => {
      if (method === "Input.dispatchMouseEvent") {
        events.push({ type: "wheel", deltaY: params.deltaY });
        return {};
      }
      if (method === "Runtime.evaluate") {
        events.push({ type: "evaluate" });
        return { result: { value: { total: 1, newCount: 0, atBottom: true } } };
      }
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  await runCuaScrollCapture({
    tab,
    x: 1084,
    y: 506,
    deltaY: 700,
    settleMs: 0,
    maxRounds: 1,
    initializeExpression: "initialize()",
    captureExpression: "capture()",
    rewindBeforeInitialize: true,
    rewindRounds: 3,
    rewindDeltaY: 3000,
    rewindSettleMs: 0
  });

  assert.deepEqual(events.slice(0, 4), [
    { type: "wheel", deltaY: -3000 },
    { type: "wheel", deltaY: -3000 },
    { type: "wheel", deltaY: -3000 },
    { type: "evaluate" }
  ]);
});

test("durable scroll capture stops fail-closed when cancelled", async () => {
  const controller = new AbortController();
  controller.abort(new Error("asset_capture_cancelled"));
  const tab = new ChromeTab({
    cdp: async () => {
      throw new Error("cancelled capture must not reach CDP");
    }
  }, { id: "77" });

  await assert.rejects(runCuaScrollCapture({
    tab,
    x: 1084,
    y: 506,
    deltaY: 700,
    settleMs: 0,
    maxRounds: 2,
    captureExpression: "capture()",
    signal: controller.signal
  }), /asset_capture_cancelled/);
});

test("scroll asset capture strips URLs and writes hashed exact-profile evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-assets-"));
  const assetDirectory = join(directory, "thumbnails");
  const manifestPath = join(directory, "manifest.json");
  let round = 0;
  const transport = {
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        round += 1;
        return {
          result: {
            value: {
              total: 1,
              newCount: round === 1 ? 1 : 0,
              atBottom: true,
              assets: [{
                key: "row-1",
                sourceUrl: "https://signed.example/thumb.webp?secret=never-log",
                width: 300,
                height: 400,
                decoded: true
              }]
            }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });
  const image = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("DATA")]);

  try {
    const output = await runScrollAssetCapture({
      router: {},
      tab,
      profileName: "Profile Alpha",
      tabId: "77",
      x: 10,
      y: 10,
      deltaY: 700,
      settleMs: 0,
      maxRounds: 5,
      initializeExpression: "capture()",
      captureExpression: "capture()",
      expectedTotal: 1,
      consecutiveNoNewAtBottom: 1,
      assetDirectory,
      manifestPath,
      diagnostics: {
        implementationVersion: "test-build",
        executionMode: "foreground",
        effectiveMaxRounds: 5
      },
      savePageAssetImpl: async ({ savePath }) => {
        await mkdir(dirname(savePath), { recursive: true });
        await writeFile(savePath, image);
        return {
          savedPath: savePath,
          bytes: image.length,
          sha256: createHash("sha256").update(image).digest("hex"),
          contentType: "image/webp"
        };
      }
    });

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(output.manifest.ok, true, JSON.stringify(output.manifest));
    assert.equal(manifest.assetCount, 1);
    assert.equal(manifest.assets[0].pageDecodeOk, true);
    assert.equal(manifest.assets[0].fileSignatureOk, true);
    assert.deepEqual(manifest.diagnostics, {
      implementationVersion: "test-build",
      executionMode: "foreground",
      effectiveMaxRounds: 5
    });
    assert.equal(manifest.signedUrlsExposed, false);
    assert.doesNotMatch(JSON.stringify(manifest), /secret=never-log/);
    assert.doesNotMatch(JSON.stringify(output), /signed\\.example/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scroll asset capture can preserve an already-rendered image when its signed URL expires", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-rendered-fallback-"));
  const assetDirectory = join(directory, "thumbnails");
  const manifestPath = join(directory, "manifest.json");
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    Buffer.from("rendered-image")
  ]);
  const screenshotCalls = [];
  let round = 0;
  const tab = new ChromeTab({
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        round += 1;
        return {
          result: {
            value: {
              total: 1,
              newCount: round === 1 ? 1 : 0,
              atBottom: true,
              assets: [{
                key: "expired-row",
                sourceUrl: "https://signed.example/expired.webp?secret=never-log",
                width: 360,
                height: 640,
                decoded: true,
                renderedClip: { x: 12, y: 34, width: 90, height: 160 }
              }]
            }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    },
    session: async (_tabId, method, options) => {
      assert.equal(method, "screenshot");
      screenshotCalls.push(options);
      return { data: png.toString("base64") };
    }
  }, { id: "77" });

  try {
    const output = await runScrollAssetCapture({
      router: {},
      tab,
      profileName: "Profile Alpha",
      tabId: "77",
      x: 10,
      y: 10,
      deltaY: 700,
      settleMs: 0,
      maxRounds: 3,
      captureExpression: "capture()",
      expectedTotal: 1,
      consecutiveNoNewAtBottom: 1,
      assetDirectory,
      manifestPath,
      fallbackToRenderedClip: true,
      stopOnAssetFailure: true,
      requireTotalAssetParity: true,
      savePageAssetImpl: async () => {
        throw new Error("Page asset request failed with HTTP 404");
      }
    });

    assert.equal(output.manifest.ok, true, JSON.stringify(output.manifest));
    assert.deepEqual(screenshotCalls, [{
      fullPage: false,
      clip: { x: 12, y: 34, width: 90, height: 160 }
    }]);
    assert.equal(output.manifest.assets[0].contentType, "image/png");
    assert.equal(output.manifest.assets[0].renderedClipFallback, true);
    assert.equal(output.manifest.assets[0].networkAssetFailedBeforeFallback, true);
    assert.equal(output.manifest.assets[0].fileSignatureOk, true);
    assert.doesNotMatch(JSON.stringify(output), /secret=never-log|signed\\.example/);
    assert.deepEqual(await readFile(join(assetDirectory, "expired-row.thumbnail")), png);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scroll asset capture rejects concurrent writers for the same manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-assets-lock-"));
  const assetDirectory = join(directory, "thumbnails");
  const manifestPath = join(directory, "manifest.json");
  let releaseEvaluation;
  let evaluationStarted;
  const started = new Promise((resolve) => { evaluationStarted = resolve; });
  const blocked = new Promise((resolve) => { releaseEvaluation = resolve; });
  const transport = {
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        evaluationStarted();
        await blocked;
        return {
          result: {
            value: {
              total: 1,
              newCount: 0,
              atBottom: true,
              assets: [{
                key: "row-1",
                sourceUrl: "https://signed.example/thumb.webp",
                width: 300,
                height: 400,
                decoded: true
              }]
            }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });
  const image = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("DATA")]);
  const options = {
    router: {},
    tab,
    profileName: "Profile Alpha",
    tabId: "77",
    x: 10,
    y: 10,
    deltaY: 700,
    settleMs: 0,
    maxRounds: 1,
    captureExpression: "capture()",
    expectedTotal: 1,
    consecutiveNoNewAtBottom: 1,
    assetDirectory,
    manifestPath,
    savePageAssetImpl: async ({ savePath }) => {
      await mkdir(dirname(savePath), { recursive: true });
      await writeFile(savePath, image);
      return {
        savedPath: savePath,
        bytes: image.length,
        sha256: createHash("sha256").update(image).digest("hex"),
        contentType: "image/webp"
      };
    }
  };

  try {
    const first = runScrollAssetCapture(options);
    await started;
    await assert.rejects(runScrollAssetCapture(options), /already owns manifestPath/);
    await assert.rejects(runScrollAssetCapture({
      ...options,
      assetDirectory: join(directory, "other-thumbnails"),
      manifestPath: join(directory, "other-manifest.json")
    }), /already owns exact profile\/tab: Profile Alpha\/77/);
    releaseEvaluation();
    assert.equal((await first).manifest.ok, true);
    await assert.rejects(readFile(`${manifestPath}.lock`, "utf8"), /ENOENT/);
  } finally {
    releaseEvaluation();
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict scroll asset capture stops on the first unresolved asset failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-assets-strict-"));
  const manifestPath = join(directory, "manifest.json");
  const tab = new ChromeTab({
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              total: 1,
              newCount: 1,
              atBottom: false,
              assets: [{
                key: "broken-row",
                sourceUrl: "https://signed.example/broken.webp",
                width: 0,
                height: 0,
                decoded: false
              }]
            }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    }
  }, { id: "77" });

  try {
    await assert.rejects(runScrollAssetCapture({
      router: {},
      tab,
      profileName: "Profile Alpha",
      tabId: "77",
      x: 10,
      y: 10,
      deltaY: 700,
      settleMs: 0,
      maxRounds: 10,
      captureExpression: "capture()",
      expectedTotal: 1,
      consecutiveNoNewAtBottom: 1,
      assetDirectory: join(directory, "thumbnails"),
      manifestPath,
      stopOnAssetFailure: true
    }), /asset_capture_hard_failure:1/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.state, "failed");
    assert.equal(manifest.failureCount, 1);
    assert.match(manifest.error, /asset_capture_hard_failure:1/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("strict scroll asset capture rejects false page progress totals", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-assets-parity-"));
  const manifestPath = join(directory, "manifest.json");
  const tab = new ChromeTab({
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: { total: 1, newCount: 0, atBottom: false, assets: [] }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    }
  }, { id: "77" });

  try {
    await assert.rejects(runScrollAssetCapture({
      router: {},
      tab,
      profileName: "Profile Alpha",
      tabId: "77",
      x: 10,
      y: 10,
      deltaY: 700,
      settleMs: 0,
      maxRounds: 10,
      captureExpression: "capture()",
      expectedTotal: 1,
      consecutiveNoNewAtBottom: 1,
      assetDirectory: join(directory, "thumbnails"),
      manifestPath,
      requireTotalAssetParity: true
    }), /asset_capture_total_mismatch:1:0:0/);
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.state, "failed");
    assert.match(manifest.error, /asset_capture_total_mismatch:1:0:0/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("scroll asset capture persists a terminal failure when an asset descriptor violates the contract", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-assets-failed-"));
  const assetDirectory = join(directory, "thumbnails");
  const manifestPath = join(directory, "manifest.json");
  const transport = {
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        return {
          result: {
            value: {
              total: 1,
              newCount: 1,
              atBottom: true,
              assets: [{
                id: "row-1",
                url: "https://signed.example/thumb.webp?secret=never-log"
              }]
            }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  try {
    await assert.rejects(
      runScrollAssetCapture({
        router: {},
        tab,
        profileName: "Profile Alpha",
        tabId: "77",
        x: 10,
        y: 10,
        deltaY: 700,
        settleMs: 0,
        maxRounds: 1,
        initializeExpression: "capture()",
        captureExpression: "capture()",
        expectedTotal: 1,
        consecutiveNoNewAtBottom: 1,
        assetDirectory,
        manifestPath
      }),
      /asset key/
    );

    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(manifest.state, "failed");
    assert.equal(manifest.ok, false);
    assert.match(manifest.error, /asset key/);
    assert.doesNotMatch(JSON.stringify(manifest), /signed\.example|never-log/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable scroll asset capture can recover more than one page of existing assets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-scroll-assets-resume-"));
  const assetDirectory = join(directory, "thumbnails");
  const manifestPath = join(directory, "manifest.json");
  const image = Buffer.concat([Buffer.from("RIFF"), Buffer.from([4, 0, 0, 0]), Buffer.from("WEBP"), Buffer.from("DATA")]);
  const assets = Array.from({ length: 101 }, (_, index) => ({
    key: `row-${index}`,
    sourceUrl: `https://signed.example/${index}.webp?secret=never-log`,
    width: 300,
    height: 400,
    decoded: true
  }));
  let evaluation = 0;
  const transport = {
    cdp: async (_tabId, method) => {
      if (method === "Input.dispatchMouseEvent") return {};
      if (method === "Runtime.evaluate") {
        evaluation += 1;
        return {
          result: {
            value: evaluation === 1
              ? { total: 101, newCount: 101, atBottom: false, assets }
              : { total: 101, newCount: 0, atBottom: true, assets: [] }
          }
        };
      }
      throw new Error(`unmocked ${method}`);
    }
  };
  const tab = new ChromeTab(transport, { id: "77" });

  try {
    await mkdir(assetDirectory, { recursive: true });
    await Promise.all(assets.map(({ key }) => writeFile(join(assetDirectory, `${key}.thumbnail`), image)));
    const output = await runScrollAssetCapture({
      router: {},
      tab,
      profileName: "Profile Alpha",
      tabId: "77",
      x: 10,
      y: 10,
      deltaY: 700,
      settleMs: 0,
      maxRounds: 2,
      initializeExpression: "initialize()",
      captureExpression: "capture()",
      expectedTotal: 101,
      consecutiveNoNewAtBottom: 1,
      assetDirectory,
      manifestPath,
      resumeExisting: true
    });

    assert.equal(output.manifest.ok, true, JSON.stringify(output.manifest));
    assert.equal(output.manifest.assetCount, 101);
    assert.equal(output.manifest.failureCount, 0);
    assert.equal(output.manifest.assets.every((asset) => asset.recoveredExisting === true), true);
    assert.doesNotMatch(JSON.stringify(output), /secret=never-log/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("durable asset status is compact unless asset details are explicitly requested", () => {
  const manifest = {
    ok: false,
    state: "running",
    assetCount: 199,
    failureCount: 0,
    assets: [{ key: "row-1", savedPath: "C:\\evidence\\row-1.thumbnail" }],
    failures: []
  };

  const compact = summarizeAssetCaptureManifest(manifest);
  assert.equal(compact.assetCount, 199);
  assert.equal(compact.assetsIncluded, false);
  assert.equal("assets" in compact, false);
  assert.equal("failures" in compact, false);
  assert.equal(summarizeAssetCaptureManifest(manifest, { includeAssets: true }), manifest);
});

test("saves a page asset with exact-profile CDP context and returns integrity evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-page-asset-"));
  const savePath = join(directory, "probe.mp4");
  const payload = Buffer.from("same-profile-media");
  const routerCalls = [];
  const fetchCalls = [];
  const router = {
    async request(profileName, method, params) {
      routerCalls.push({ profileName, method, params });
      if (params.cdpMethod === "Runtime.evaluate") {
        return {
          result: {
            value: {
              userAgent: "Exact Profile UA",
              referer: "https://www.douyin.com/video/123",
              sourceUrl: "https://media.example/video.mp4?signature=sensitive"
            }
          }
        };
      }
      if (params.cdpMethod === "Network.getCookies") {
        return { cookies: [{ name: "sessionid", value: "secret-cookie" }] };
      }
      throw new Error(`unmocked ${params.cdpMethod}`);
    }
  };
  const fetchImpl = async (url, options) => {
    fetchCalls.push({ url, options });
    return new Response(payload, {
      status: 200,
      headers: { "content-type": "video/mp4", "content-length": String(payload.length) }
    });
  };

  try {
    const result = await savePageAsset({
      router,
      profileName: "Profile Alpha",
      tabId: "7",
      sourceSelector: "video",
      sourceProperty: "currentSrc",
      savePath,
      expectedMimePrefix: "video/",
      fetchImpl
    });

    assert.deepEqual(await readFile(savePath), payload);
    assert.equal(result.bytes, payload.length);
    assert.equal(result.sha256, createHash("sha256").update(payload).digest("hex"));
    assert.equal(result.contentType, "video/mp4");
    assert.equal(result.profileName, "Profile Alpha");
    assert.equal(result.tabId, "7");
    assert.equal(result.cookieCountUsed, 1);
    assert.equal(result.profileContext, true);
    assert.equal(result.sourceResolvedInsidePlugin, true);
    assert.equal("sourceUrl" in result, false);
    assert.deepEqual(routerCalls.map((call) => [call.profileName, call.method, call.params.cdpMethod]), [
      ["Profile Alpha", "cdp.send", "Runtime.evaluate"],
      ["Profile Alpha", "cdp.send", "Network.getCookies"]
    ]);
    assert.equal(fetchCalls[0].options.headers["User-Agent"], "Exact Profile UA");
    assert.equal(fetchCalls[0].options.headers.Referer, "https://www.douyin.com/video/123");
    assert.equal(fetchCalls[0].options.headers.Cookie, "sessionid=secret-cookie");
    assert.match(routerCalls[0].params.cdpParams.expression, /querySelectorAll/);
    assert.doesNotMatch(JSON.stringify(result), /signature=sensitive/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("page asset fetch timeout aborts a hung request", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentos-page-timeout-"));
  const savePath = join(directory, "hung.thumbnail");
  const router = {
    async request(_profileName, _method, params) {
      if (params.cdpMethod === "Runtime.evaluate") {
        return {
          result: {
            value: {
              userAgent: "Exact Profile UA",
              referer: "https://www.tiktok.com/@creator_placeholder/video/123"
            }
          }
        };
      }
      if (params.cdpMethod === "Network.getCookies") return { cookies: [] };
      throw new Error(`unmocked ${params.cdpMethod}`);
    }
  };
  const fetchImpl = async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });

  try {
    await assert.rejects(
      savePageAsset({
        router,
        profileName: "Profile Alpha",
        tabId: "7",
        sourceUrl: "https://media.example/hung.jpg",
        savePath,
        expectedMimePrefix: "image/",
        timeoutMs: 10,
        fetchImpl
      }),
      /Page asset timed out after 10ms/
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("allows same-profile poster and metadata content recovery without exposing the resolved URL", async () => {
  for (const sourceProperty of ["poster", "content"]) {
    const directory = await mkdtemp(join(tmpdir(), `agentos-page-${sourceProperty}-`));
    const savePath = join(directory, "recovered.thumbnail");
    const payload = Buffer.from(`same-profile-${sourceProperty}`);
    const router = {
      async request(_profileName, _method, params) {
        if (params.cdpMethod === "Runtime.evaluate") {
          assert.match(params.cdpParams.expression, new RegExp(`\\[${JSON.stringify(sourceProperty)}\\]`));
          return {
            result: {
              value: {
                userAgent: "Exact Profile UA",
                referer: "https://www.tiktok.com/@creator_placeholder/video/123",
                sourceUrl: `https://media.example/${sourceProperty}.jpg?signature=sensitive`
              }
            }
          };
        }
        if (params.cdpMethod === "Network.getCookies") return { cookies: [] };
        throw new Error(`unmocked ${params.cdpMethod}`);
      }
    };

    try {
      const result = await savePageAsset({
        router,
        profileName: "Profile Alpha",
        tabId: "8",
        sourceSelector: sourceProperty === "poster" ? "video[poster]" : "meta[property='og:image']",
        sourceProperty,
        savePath,
        expectedMimePrefix: "image/",
        fetchImpl: async () => new Response(payload, {
          status: 200,
          headers: { "content-type": "image/jpeg", "content-length": String(payload.length) }
        })
      });
      assert.deepEqual(await readFile(savePath), payload);
      assert.equal(result.sourceResolvedInsidePlugin, true);
      assert.equal("sourceUrl" in result, false);
      assert.doesNotMatch(JSON.stringify(result), /signature=sensitive/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});
