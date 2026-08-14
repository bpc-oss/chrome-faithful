import assert from "node:assert/strict";
import test from "node:test";

import { runProfileSelftest } from "../src/selftest.mjs";

function fixture({ url = "https://example.test/", tabId = "7" } = {}) {
  const calls = [];
  let temporaryOpen = false;
  const router = {
    async request(profileName, method, params) {
      calls.push({ profileName, method, params });
      if (method === "tabs.update") {
        temporaryOpen = true;
        return { ok: true };
      }
      if (method === "tabs.get") {
        return { id: params.tabId, url: "about:blank", status: "complete" };
      }
      if (method === "tabs.remove") {
        temporaryOpen = false;
        return { ok: true };
      }
      if (method === "selftest") {
        return {
          platform: { os: "win" },
          tabCount: 2,
          cdp: { title: "", url: params.tabId === "99" ? "about:blank" : url }
        };
      }
      throw new Error(`Unexpected method: ${method}`);
    }
  };
  const browser = {
    tabs: {
      list: async () => [{ id: tabId, url }],
      new: async () => {
        temporaryOpen = true;
        return { id: "99" };
      }
    }
  };
  return { router, browser, calls, temporaryOpen: () => temporaryOpen };
}

test("selftest uses an accessible requested tab without creating one", async () => {
  const f = fixture();
  const result = await runProfileSelftest({
    router: f.router,
    getBrowser: async () => f.browser,
    profileName: "Profile A",
    tabId: "7",
    implementationVersion: "test"
  });
  assert.equal(result.ok, true);
  assert.equal(result.temporaryTabUsed, false);
  assert.equal(f.calls.some((call) => call.method === "tabs.update"), false);
  assert.equal(f.calls.some((call) => call.method === "tabs.remove"), false);
});

test("selftest replaces an inaccessible chrome tab with a cleaned temporary tab", async () => {
  const f = fixture({ url: "chrome://newtab/" });
  const result = await runProfileSelftest({
    router: f.router,
    getBrowser: async () => f.browser,
    profileName: "Profile A",
    tabId: "7",
    implementationVersion: "test"
  });
  assert.equal(result.ok, true);
  assert.equal(result.requestedTabId, "7");
  assert.equal(result.tabId, "99");
  assert.equal(result.temporaryTabUsed, true);
  assert.equal(f.temporaryOpen(), false);
  assert.deepEqual(
    f.calls.filter((call) => call.method === "tabs.update" || call.method === "tabs.remove").map((call) => call.method),
    ["tabs.update", "tabs.remove"]
  );
});

test("selftest cleans its temporary tab when the runtime check fails", async () => {
  const f = fixture({ url: "chrome://newtab/" });
  const originalRequest = f.router.request;
  f.router.request = async (profileName, method, params) => {
    if (method === "selftest") throw new Error("runtime failed");
    return originalRequest(profileName, method, params);
  };
  await assert.rejects(
    runProfileSelftest({
      router: f.router,
      getBrowser: async () => f.browser,
      profileName: "Profile A",
      tabId: "7",
      implementationVersion: "test"
    }),
    /runtime failed/
  );
  assert.equal(f.temporaryOpen(), false);
});
