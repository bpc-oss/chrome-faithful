import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const token = "t".repeat(43);
const grant = "g".repeat(43);
const attemptId = "00000000-0000-4000-8000-000000000004";
const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const buildId = "test-build";

function storageArea(initial = {}) {
  const values = { ...initial };
  return {
    values,
    async get(keys) {
      const selected = {};
      for (const key of keys) if (Object.hasOwn(values, key)) selected[key] = values[key];
      return selected;
    },
    async set(next) { Object.assign(values, next); },
    async remove(keys) { for (const key of keys) delete values[key]; }
  };
}

test("reload maintenance records only its own tab, clears the query, and reloads", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const local = storageArea();
  const location = { search: "?reload=1", hash: "", pathname: "/options.html" };
  let queryCleared = false;
  let reloaded = false;
  const execute = new AsyncFunction(
    "location",
    "history",
    "chrome",
    "document",
    "fetch",
    "setTimeout",
    "URLSearchParams",
    "Date",
    source
  );
  void execute(
    location,
    {
      replaceState() {
        location.search = "";
        queryCleared = true;
      }
    },
    {
      storage: { local },
      tabs: { async getCurrent() { return { id: 77 }; } },
      runtime: {
        reload() {
          assert.equal(queryCleared, true);
          reloaded = true;
        }
      }
    },
    {},
    async () => { throw new Error("unexpected fetch"); },
    setTimeout,
    URLSearchParams,
    Date
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(reloaded, true);
  assert.equal(local.values.agentosExtensionReloadMarker.tabId, 77);
  assert.equal(Number.isFinite(local.values.agentosExtensionReloadMarker.requestedAt), true);
  assert.equal(location.search, "");
});

test("reloaded options page removes the exact marked tab and no other tab", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const local = storageArea({
    agentosExtensionReloadMarker: { tabId: 77, requestedAt: Date.now() }
  });
  const removedTabs = [];
  const execute = new AsyncFunction(
    "location",
    "history",
    "chrome",
    "document",
    "fetch",
    "setTimeout",
    "URLSearchParams",
    "Date",
    source
  );
  void execute(
    { search: "", hash: "", pathname: "/options.html" },
    { replaceState() {} },
    {
      storage: { local },
      tabs: {
        async getCurrent() { return { id: 77 }; },
        async remove(tabId) { removedTabs.push(tabId); }
      },
      runtime: { reload() { throw new Error("unexpected second reload"); } }
    },
    {},
    async () => { throw new Error("unexpected fetch"); },
    setTimeout,
    URLSearchParams,
    Date
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(removedTabs, [77]);
  assert.equal(local.values.agentosExtensionReloadMarker, undefined);
});

test("expired reload maintenance marker is cleared without closing a tab", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const local = storageArea({
    agentosExtensionReloadMarker: { tabId: 77, requestedAt: Date.now() - 60_001 }
  });
  const fields = new Map([
    ["profileName", { value: "" }],
    ["bridgeUrl", { value: "" }],
    ["secret", { value: "" }],
    ["status", { textContent: "" }],
    ["save", { addEventListener() {} }]
  ]);
  let currentTabReads = 0;
  const execute = new AsyncFunction(
    "location",
    "history",
    "chrome",
    "document",
    "fetch",
    "setTimeout",
    "URLSearchParams",
    "Date",
    source
  );
  await execute(
    { search: "", hash: "", pathname: "/options.html" },
    { replaceState() {} },
    {
      storage: { local },
      tabs: { async getCurrent() { currentTabReads += 1; return { id: 77 }; } },
      runtime: { reload() { throw new Error("unexpected reload"); } }
    },
    { getElementById(id) { return fields.get(id); } },
    async () => { throw new Error("unexpected fetch"); },
    setTimeout,
    URLSearchParams,
    Date
  );

  assert.equal(local.values.agentosExtensionReloadMarker, undefined);
  assert.equal(currentTabReads, 0);
});

test("options bootstrap executes on the configured port and keeps the host page open after exact acknowledgement", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const local = storageArea();
  const session = storageArea();
  const location = {
    search: "",
    hash: `#port=19444&bootstrap=${token}`,
    pathname: "/options.html"
  };
  let fragmentCleared = false;
  const history = {
    replaceState() {
      location.hash = "";
      location.search = "";
      fragmentCleared = true;
    }
  };
  const removedTabs = [];
  const fields = new Map([
    ["profileName", { value: "" }],
    ["bridgeUrl", { value: "" }],
    ["secret", { value: "" }],
    ["status", { textContent: "" }],
    ["save", { addEventListener() {} }]
  ]);
  const document = {
    title: "",
    getElementById(id) { return fields.get(id); }
  };
  const fetchCalls = [];
  const fetch = async (url, options) => {
    fetchCalls.push({ url, options, fragmentCleared });
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          attemptId,
          registrationGrant: grant,
          profileName: "Profile A",
          bridgeUrl: "ws://127.0.0.1:19444/extension",
          secret: "new-secret"
        };
      }
    };
  };
  const chrome = {
    storage: { local, session },
    runtime: {
      async sendMessage(message) {
        assert.equal(message.type, "agentos-config-changed");
        const pending = await session.get(["bootstrapAttemptId", "bootstrapRegistrationGrant"]);
        assert.equal(pending.bootstrapAttemptId, attemptId);
        assert.equal(pending.bootstrapRegistrationGrant, grant);
        await session.remove(["bootstrapAttemptId", "bootstrapRegistrationGrant"]);
        await session.set({ bootstrapRegisteredAttemptId: attemptId });
        return { ok: true };
      },
      reload() { throw new Error("unexpected reload"); }
    },
    tabs: {
      async getCurrent() { return { id: 77 }; },
      async remove(id) { removedTabs.push(id); }
    }
  };
  const immediateTimeout = (callback) => { callback(); return 1; };
  const execute = new AsyncFunction(
    "location",
    "history",
    "chrome",
    "document",
    "fetch",
    "setTimeout",
    "URLSearchParams",
    "Date",
    source
  );
  await execute(location, history, chrome, document, fetch, immediateTimeout, URLSearchParams, Date);

  assert.deepEqual(fetchCalls.map(({ url, options, fragmentCleared: cleared }) => ({
    url,
    method: options.method,
    body: options.body,
    fragmentCleared: cleared
  })), [{
    url: "http://127.0.0.1:19444/bootstrap",
    method: "POST",
    body: token,
    fragmentCleared: true
  }]);
  assert.deepEqual(local.values, {
    profileName: "Profile A",
    bridgeUrl: "ws://127.0.0.1:19444/extension",
    secret: "new-secret"
  });
  assert.equal(JSON.stringify(local.values).includes(grant), false);
  assert.equal(JSON.stringify(session.values).includes(grant), false);
  assert.deepEqual(removedTabs, []);
  assert.equal(document.title, "Chrome Faithful - connected");
  assert.match(fields.get("status").textContent, /已安全连接：Profile A/);
});

test("options bootstrap exposes only a bounded failure stage in the window title", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const local = storageArea();
  const session = storageArea();
  const location = {
    search: "",
    hash: `#port=19444&bootstrap=${token}`,
    pathname: "/options.html"
  };
  const fields = new Map([
    ["profileName", { value: "" }],
    ["bridgeUrl", { value: "" }],
    ["secret", { value: "" }],
    ["status", { textContent: "" }],
    ["save", { addEventListener() {} }]
  ]);
  const document = {
    title: "",
    getElementById(id) { return fields.get(id); }
  };
  const execute = new AsyncFunction(
    "location",
    "history",
    "chrome",
    "document",
    "fetch",
    "setTimeout",
    "URLSearchParams",
    "Date",
    source
  );
  await execute(
    location,
    { replaceState() { location.hash = ""; } },
    {
      storage: { local, session },
      runtime: {
        async sendMessage() { return { ok: false, error: "private transport detail" }; },
        reload() { throw new Error("unexpected reload"); }
      },
      tabs: { async getCurrent() { return { id: 77 }; }, async remove() {} }
    },
    document,
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          attemptId,
          registrationGrant: grant,
          profileName: "Profile A",
          bridgeUrl: "ws://127.0.0.1:19444/extension",
          secret: "new-secret"
        };
      }
    }),
    setTimeout,
    URLSearchParams,
    Date
  );

  assert.equal(document.title, "Chrome Faithful - bootstrap-error:offscreen-reset");
  assert.equal(document.title.includes(token), false);
  assert.equal(document.title.includes("private transport detail"), false);
});

test("options bootstrap rejects a userinfo-prefix bridge URL before storing credentials", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const local = storageArea();
  const session = storageArea();
  const location = {
    search: "",
    hash: `#port=19444&bootstrap=${token}`,
    pathname: "/options.html"
  };
  const fields = new Map([
    ["profileName", { value: "" }],
    ["bridgeUrl", { value: "" }],
    ["secret", { value: "" }],
    ["status", { textContent: "" }],
    ["save", { addEventListener() {} }]
  ]);
  const document = {
    title: "",
    getElementById(id) { return fields.get(id); }
  };
  let runtimeMessages = 0;
  const execute = new AsyncFunction(
    "location",
    "history",
    "chrome",
    "document",
    "fetch",
    "setTimeout",
    "URLSearchParams",
    "Date",
    source
  );
  await execute(
    location,
    { replaceState() { location.hash = ""; } },
    {
      storage: { local, session },
      runtime: {
        async sendMessage() { runtimeMessages += 1; return { ok: true }; },
        reload() { throw new Error("unexpected reload"); }
      },
      tabs: { async getCurrent() { return { id: 77 }; }, async remove() {} }
    },
    document,
    async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          attemptId,
          registrationGrant: grant,
          profileName: "Profile A",
          bridgeUrl: "ws://127.0.0.1:19444@evil.test/extension",
          secret: "must-not-be-stored"
        };
      }
    }),
    setTimeout,
    URLSearchParams,
    Date
  );

  assert.deepEqual(local.values, {});
  assert.deepEqual(session.values, {});
  assert.equal(runtimeMessages, 0);
  assert.equal(document.title, "Chrome Faithful - bootstrap-error:validate-binding");
  assert.equal(JSON.stringify(local.values).includes("must-not-be-stored"), false);
});

test("manual options save rejects every non-exact local bridge URL without side effects", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  const invalidUrls = [
    "http://127.0.0.1:19444/extension",
    "ws://localhost:19444/extension",
    "ws://127.0.0.1:19444@evil.example/extension",
    "ws://user@127.0.0.1:19444/extension",
    "ws://127.0.0.1/extension",
    "ws://127.0.0.1:80/extension",
    "ws://127.0.0.1:19444/extension/",
    "ws://127.0.0.1:19444/other",
    "ws://127.0.0.1:19444/extension?redirect=evil",
    "ws://127.0.0.1:19444/extension#evil"
  ];
  for (const bridgeUrl of invalidUrls) {
    const local = storageArea();
    let saveHandler;
    let runtimeMessages = 0;
    const fields = new Map([
      ["profileName", { value: "Profile A" }],
      ["bridgeUrl", { value: bridgeUrl }],
      ["secret", { value: "must-not-be-stored" }],
      ["status", { textContent: "" }],
      ["save", { addEventListener(_type, handler) { saveHandler = handler; } }]
    ]);
    const execute = new AsyncFunction(
      "location",
      "history",
      "chrome",
      "document",
      "fetch",
      "setTimeout",
      "URLSearchParams",
      "Date",
      source
    );
    await execute(
      { search: "", hash: "", pathname: "/options.html" },
      { replaceState() {} },
      {
        storage: { local },
        runtime: {
          async sendMessage() { runtimeMessages += 1; return { ok: true }; },
          reload() { throw new Error("unexpected reload"); }
        },
        tabs: { async getCurrent() { return { id: 77 }; } }
      },
      { getElementById(id) { return fields.get(id); }, title: "" },
      async () => { throw new Error("unexpected fetch"); },
      setTimeout,
      URLSearchParams,
      Date
    );
    assert.equal(typeof saveHandler, "function");
    await saveHandler();
    assert.deepEqual(local.values, {}, bridgeUrl);
    assert.equal(runtimeMessages, 0, bridgeUrl);
    assert.equal(fields.get("status").textContent, "本机 bridge 地址无效", bridgeUrl);
  }
});

test("offscreen transport presents the one-use registration grant and acknowledges the same attempt", async () => {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  const session = storageArea({
    bootstrapAttemptId: attemptId,
    bootstrapRegistrationGrant: grant
  });
  const sent = [];
  const connectNames = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) {
      this.url = url;
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }
    send(value) {
      const message = JSON.parse(value);
      sent.push(message);
      if (message.kind === "register") {
        queueMicrotask(() => this.onmessage?.({
          data: JSON.stringify({
            kind: "registered",
            profileName: "Profile A",
            extensionId,
            buildId,
            attemptId
          })
        }));
      }
    }
    close() { this.readyState = FakeWebSocket.CLOSED; }
  }
  const chrome = {
    runtime: {
      id: extensionId,
      getManifest() { return { version: "0.3.0", version_name: buildId }; },
      connect(options) { connectNames.push(options?.name); return { onDisconnect: { addListener() {} } }; },
      async sendMessage(message) {
        if (message?.type === "agentos-bootstrap-registered") {
          await session.remove(["bootstrapAttemptId", "bootstrapRegistrationGrant"]);
          await session.set({
            bootstrapRegisteredAttemptId: message.attemptId,
            bootstrapRegisteredAt: "2026-08-01T00:00:00.000Z"
          });
          return { ok: true };
        }
        return {
          profileName: "Profile A",
          bridgeUrl: "ws://127.0.0.1:19444/extension",
          secret: "new-secret",
          bootstrapAttemptId: attemptId,
          bootstrapRegistrationGrant: grant,
          extensionMeta: { version: "0.3.0", buildId }
        };
      },
      onMessage: { addListener() {} }
    },
    storage: { session }
  };
  const localStorage = { setItem() {} };
  const document = {
    body: { append() {} },
    createElement() {
      return { remove() {}, focus() {}, select() {}, value: "" };
    },
    execCommand() { return false; }
  };
  const navigator = { clipboard: {} };
  const execute = new AsyncFunction(
    "chrome",
    "WebSocket",
    "localStorage",
    "document",
    "navigator",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    source
  );
  await execute(
    chrome,
    FakeWebSocket,
    localStorage,
    document,
    navigator,
    () => 1,
    () => {},
    () => 1
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  const registration = sent.find((message) => message.kind === "register");
  assert.deepEqual(connectNames, ["agentos-transport"]);
  assert.equal(registration.attemptId, attemptId);
  assert.equal(registration.registrationGrant, grant);
  assert.equal(registration.profileName, "Profile A");
  assert.equal(registration.extensionId, extensionId);
  assert.equal(registration.version, "0.3.0");
  assert.equal(registration.buildId, buildId);
  assert.equal(session.values.bootstrapRegistrationGrant, undefined);
  assert.equal(session.values.bootstrapRegisteredAttemptId, attemptId);
});

test("offscreen refuses to connect when manifest version_name is missing", async () => {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  let settingsReads = 0;
  const transportStages = [];
  let socketCreations = 0;
  const reconnectDelays = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor() { socketCreations += 1; }
  }
  const chrome = {
    runtime: {
      id: extensionId,
      getManifest() { return { version: "0.3.0" }; },
      async sendMessage(message) {
        if (message?.type === "agentos-transport-stage") {
          transportStages.push(message.stage);
          return { ok: true };
        }
        settingsReads += 1;
        return {};
      },
      onMessage: { addListener() {} }
    },
    storage: { session: storageArea() }
  };
  const execute = new AsyncFunction(
    "chrome",
    "WebSocket",
    "localStorage",
    "document",
    "navigator",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    source
  );
  await execute(
    chrome,
    FakeWebSocket,
    { setItem() {} },
    {
      body: { append() {} },
      createElement() { return { remove() {}, focus() {}, select() {}, value: "" }; },
      execCommand() { return false; }
    },
    { clipboard: {} },
    (_callback, delay) => { reconnectDelays.push(delay); return 1; },
    () => {},
    () => 1
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(settingsReads, 1);
  assert.equal(socketCreations, 0);
  assert.deepEqual(transportStages, ["settings-read", "build-id-invalid"]);
  assert.deepEqual(reconnectDelays, [1000]);
});

test("offscreen rejects a userinfo-prefix bridge URL without creating a socket or storing its secret", async () => {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  const transportStages = [];
  const socketUrls = [];
  const localStorageWrites = [];
  const reconnectDelays = [];
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor(url) { socketUrls.push(String(url)); }
  }
  const chrome = {
    runtime: {
      id: extensionId,
      getManifest() { return { version: "0.3.0", version_name: buildId }; },
      async sendMessage(message) {
        if (message?.type === "agentos-transport-stage") {
          transportStages.push(message.stage);
          return { ok: true };
        }
        assert.equal(message?.type, "agentos-get-config");
        return {
          profileName: "Profile A",
          bridgeUrl: "ws://127.0.0.1:19444@evil.example/extension",
          secret: "must-not-escape",
          extensionMeta: { version: "0.3.0", buildId }
        };
      },
      onMessage: { addListener() {} }
    },
    storage: { session: storageArea() }
  };
  const execute = new AsyncFunction(
    "chrome",
    "WebSocket",
    "localStorage",
    "document",
    "navigator",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    source
  );
  await execute(
    chrome,
    FakeWebSocket,
    { setItem(key, value) { localStorageWrites.push([key, value]); } },
    {
      body: { append() {} },
      createElement() { return { remove() {}, focus() {}, select() {}, value: "" }; },
      execCommand() { return false; }
    },
    { clipboard: {} },
    (_callback, delay) => { reconnectDelays.push(delay); return 1; },
    () => {},
    () => 1
  );
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(transportStages, ["settings-read", "settings-invalid"]);
  assert.deepEqual(socketUrls, []);
  assert.deepEqual(localStorageWrites, []);
  assert.deepEqual(reconnectDelays, [1000]);
  assert.equal(JSON.stringify(socketUrls).includes("must-not-escape"), false);
  assert.equal(JSON.stringify(localStorageWrites).includes("must-not-escape"), false);
});

test("offscreen ignores a stale acknowledgement after a newer bootstrap attempt wins", async () => {
  const source = await readFile(new URL("../extension/offscreen.js", import.meta.url), "utf8");
  const newerAttemptId = "00000000-0000-4000-8000-000000000005";
  const newerGrant = "n".repeat(43);
  const session = storageArea({
    bootstrapAttemptId: attemptId,
    bootstrapRegistrationGrant: grant
  });
  let socketClosed = false;
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSED = 3;
    constructor() {
      this.readyState = 0;
      queueMicrotask(() => {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.();
      });
    }
    send(value) {
      const message = JSON.parse(value);
      if (message.kind !== "register") return;
      Object.assign(session.values, {
        bootstrapAttemptId: newerAttemptId,
        bootstrapRegistrationGrant: newerGrant
      });
      queueMicrotask(() => this.onmessage?.({
        data: JSON.stringify({
          kind: "registered",
          profileName: "Profile A",
          extensionId,
          buildId,
          attemptId
        })
      }));
    }
    close() {
      socketClosed = true;
      this.readyState = FakeWebSocket.CLOSED;
    }
  }
  const chrome = {
    runtime: {
      id: extensionId,
      getManifest() { return { version: "0.3.0", version_name: buildId }; },
      async sendMessage(message) {
        if (message?.type === "agentos-bootstrap-registered") {
          return { ok: false };
        }
        return {
          profileName: "Profile A",
          bridgeUrl: "ws://127.0.0.1:19444/extension",
          secret: "new-secret",
          bootstrapAttemptId: attemptId,
          bootstrapRegistrationGrant: grant,
          extensionMeta: { version: "0.3.0", buildId }
        };
      },
      onMessage: { addListener() {} }
    },
    storage: { session }
  };
  const localStorageWrites = [];
  const execute = new AsyncFunction(
    "chrome",
    "WebSocket",
    "localStorage",
    "document",
    "navigator",
    "setTimeout",
    "clearTimeout",
    "setInterval",
    source
  );
  await execute(
    chrome,
    FakeWebSocket,
    { setItem(key, value) { localStorageWrites.push([key, value]); } },
    {
      body: { append() {} },
      createElement() { return { remove() {}, focus() {}, select() {}, value: "" }; },
      execCommand() { return false; }
    },
    { clipboard: {} },
    () => 1,
    () => {},
    () => 1
  );
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(socketClosed, true);
  assert.equal(session.values.bootstrapAttemptId, newerAttemptId);
  assert.equal(session.values.bootstrapRegistrationGrant, newerGrant);
  assert.equal(session.values.bootstrapRegisteredAttemptId, undefined);
  assert.equal(localStorageWrites.some(([key]) => key === "agentosRegisteredProfile"), false);
});

test("service worker serializes concurrent offscreen resets and honors the last request", async () => {
  const source = await readFile(new URL("../extension/service-worker.js", import.meta.url), "utf8");
  const start = source.indexOf("const OFFSCREEN_URL");
  const end = source.indexOf("async function ensureAttached");
  assert.ok(start >= 0 && end > start);
  const resetSource = source.slice(start, end);
  let releaseFirstClose;
  let markFirstCloseStarted;
  const firstCloseGate = new Promise((resolve) => { releaseFirstClose = resolve; });
  const firstCloseStarted = new Promise((resolve) => { markFirstCloseStarted = resolve; });
  let activeOperations = 0;
  let maxActiveOperations = 0;
  let closeCalls = 0;
  let createCalls = 0;
  const enter = () => {
    activeOperations += 1;
    maxActiveOperations = Math.max(maxActiveOperations, activeOperations);
  };
  const leave = () => { activeOperations -= 1; };
  const chrome = {
    runtime: {
      getURL(value) { return `chrome-extension://${extensionId}/${value}`; },
      async getContexts() { return []; }
    },
    offscreen: {
      async closeDocument() {
        enter();
        closeCalls += 1;
        if (closeCalls === 1) {
          markFirstCloseStarted();
          await firstCloseGate;
        }
        leave();
      },
      async createDocument() {
        enter();
        createCalls += 1;
        await Promise.resolve();
        leave();
      }
    }
  };
  const makeReset = new AsyncFunction("chrome", `${resetSource}; return resetOffscreen;`);
  const resetOffscreen = await makeReset(chrome);
  const first = resetOffscreen();
  await firstCloseStarted;
  const second = resetOffscreen();
  releaseFirstClose();
  await Promise.all([first, second]);

  assert.equal(maxActiveOperations, 1);
  assert.equal(closeCalls, 2);
  assert.equal(createCalls, 2);
});
