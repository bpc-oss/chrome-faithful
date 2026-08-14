import test from "node:test";
import assert from "node:assert/strict";
import {
  BrowserDownload,
  BrowserFileChooser,
  ChromeTab,
  createAgent,
  browserDialog
} from "../src/agent-browser.mjs";

class CompatibilityRouter {
  constructor() {
    this.calls = [];
    this.tabs = [
      { id: "1", title: "one", url: "https://one.example", lastAccessed: 100 },
      { id: "2", title: "two", url: "https://two.example", lastAccessed: 200 }
    ];
  }
  list() {
    return [{ profileName: "Profile Beta", extensionId: "extension-id", version: "test" }];
  }
  async request(profileName, method, params) {
    this.calls.push({ profileName, method, params });
    if (method === "tabs.list") return this.tabs;
    if (method === "tabs.get") return this.tabs.find((tab) => tab.id === String(params.tabId));
    if (method === "tabs.new") {
      const tab = { id: String(this.tabs.length + 1), title: "agent", url: "about:blank" };
      this.tabs.push(tab);
      return tab;
    }
    if (method === "tabs.remove") {
      this.tabs = this.tabs.filter((tab) => tab.id !== String(params.tabId));
      return null;
    }
    if (method === "history.search") return [
      { url: "https://old.example", title: "old", lastVisitTime: 100 },
      { url: "https://new.example", title: "new", lastVisitTime: 200 }
    ];
    if (method === "puppeteer.session") return { ok: true, path: "C:\\Downloads\\asset.bin" };
    throw new Error(`unmocked ${method}`);
  }
}

test("exposes every Codex browser method family on concrete adapter objects", async () => {
  const router = new CompatibilityRouter();
  const agent = createAgent(router);
  const browser = await agent.browsers.getDefault();
  const tab = await browser.tabs.get("1");
  const locator = tab.playwright.locator("button");
  const frame = tab.playwright.frameLocator("iframe");

  assert.equal(typeof agent.documentation.get, "function");
  for (const method of ["content", "finalize", "get", "list", "new", "selected"]) assert.equal(typeof browser.tabs[method], "function", `Tabs.${method}`);
  for (const method of ["claimTab", "history", "openTabs"]) assert.equal(typeof browser.user[method], "function", `BrowserUser.${method}`);
  for (const method of ["export", "exportGsuite"]) assert.equal(typeof tab.content[method], "function", `ContentAPI.${method}`);
  for (const method of ["click", "double_click", "downloadMedia", "drag", "keypress", "move", "scroll", "type"]) assert.equal(typeof tab.cua[method], "function", `CUAAPI.${method}`);
  for (const method of ["click", "double_click", "downloadMedia", "get_visible_dom", "keypress", "scroll", "type"]) assert.equal(typeof tab.dom_cua[method], "function", `DomCUAAPI.${method}`);
  for (const method of ["domSnapshot", "elementInfo", "elementScreenshot", "evaluate", "expectNavigation", "frameLocator", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "locator", "waitForEvent", "waitForLoadState", "waitForTimeout", "waitForURL"]) assert.equal(typeof tab.playwright[method], "function", `PlaywrightAPI.${method}`);
  for (const method of ["frameLocator", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "locator"]) assert.equal(typeof frame[method], "function", `PlaywrightFrameLocator.${method}`);
  for (const method of ["all", "allTextContents", "and", "check", "click", "count", "dblclick", "downloadMedia", "evaluate", "fill", "filter", "first", "getAttribute", "getByLabel", "getByPlaceholder", "getByRole", "getByTestId", "getByText", "innerText", "isEnabled", "isVisible", "last", "locator", "nth", "or", "press", "selectOption", "setChecked", "textContent", "type", "uncheck", "waitFor"]) assert.equal(typeof locator[method], "function", `PlaywrightLocator.${method}`);
  for (const method of ["read", "readText", "write", "writeText"]) assert.equal(typeof tab.clipboard[method], "function", `TabClipboardAPI.${method}`);
  assert.equal(typeof tab.dev.logs, "function");
});

test("normalizes browser history and open-tab identity", async () => {
  const browser = await createAgent(new CompatibilityRouter()).browsers.getDefault();
  const open = await browser.user.openTabs();
  assert.deepEqual(open.map((tab) => tab.providerTabId), ["2", "1"]);
  assert.ok(open[0].lastOpened.endsWith("Z"));
  const history = await browser.user.history({});
  assert.deepEqual(history.map((entry) => entry.title), ["new", "old"]);
  assert.ok(history[0].dateVisited.endsWith("Z"));
});

test("finalize preserves user and marked agent tabs and closes other agent tabs", async () => {
  const router = new CompatibilityRouter();
  const browser = await createAgent(router).browsers.getDefault();
  const handoff = await browser.tabs.new();
  await browser.tabs.new();
  await handoff.markHandoff();
  await browser.tabs.finalize();
  assert.deepEqual(router.tabs.map((tab) => tab.id), ["1", "2", handoff.id]);
});

test("download, file chooser, and dialog resources route back through the exact tab session", async () => {
  const calls = [];
  const tab = {
    id: "7",
    transport: {
      session: async (tabId, action, options) => {
        calls.push({ tabId, action, options });
        return { path: "C:\\Downloads\\asset.bin" };
      }
    }
  };
  const download = new BrowserDownload(tab, { resourceId: "download:1", payload: {} });
  assert.equal(await download.path({ timeoutMs: 10 }), "C:\\Downloads\\asset.bin");
  const chooser = new BrowserFileChooser(tab, { resourceId: "filechooser:2", payload: { multiple: true } });
  assert.equal(chooser.isMultiple(), true);
  await chooser.setFiles(["C:\\a.txt"], { timeoutMs: 20 });
  const prompt = browserDialog(tab, { resourceId: "dialog:3", payload: { type: "prompt" } });
  assert.equal(prompt.type, "prompt");
  await prompt.accept("answer");
  assert.deepEqual(calls.map((call) => call.action), ["downloadPath", "fileChooserSetFiles", "dialogAct"]);
});

test("locator boolean combinations retain both concrete descriptors", () => {
  const tab = new ChromeTab({}, { id: "7" });
  const left = tab.playwright.getByRole("button", { name: "Save" });
  const right = tab.playwright.getByText("Save");
  assert.equal(left.and(right).descriptor.combinator, "and");
  assert.equal(left.or(right).descriptor.combinator, "or");
});
