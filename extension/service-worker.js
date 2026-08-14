import {
  callTabSession,
  disposeTabSession,
  recordBrowserDownload,
  updateBrowserDownload
} from "./generated/puppeteer-runtime.js";

const OFFSCREEN_URL = "offscreen.html";
const NETWORK_ENABLE_PARAMS = Object.freeze({
  maxTotalBufferSize: 20 * 1024 * 1024,
  maxResourceBufferSize: 2 * 1024 * 1024,
  maxPostDataSize: 64 * 1024
});
const attached = new Set();
const consoleLogs = new Map();
const cdpEvents = new Map();
const eventSequences = new Map();
const targetSessions = new Map();
const networkResponses = new Map();
const responseBodies = new Map();
const RESPONSE_BODY_MAX_ENTRIES = 512;
const RESPONSE_BODY_MAX_TOTAL_BYTES = 40 * 1024 * 1024;
const RESPONSE_BODY_MAX_ITEM_BYTES = 5 * 1024 * 1024;
const CHROME_API_TIMEOUT_MS = 25_000;
const BOOTSTRAP_TRANSPORT_STAGES = new Set([
  "settings-read",
  "settings-invalid",
  "build-id-invalid",
  "socket-created",
  "socket-open",
  "register-sent",
  "socket-error",
  "socket-close",
  "registered"
]);
let creatingOffscreen;
let resettingOffscreen;
let requestedOffscreenResetGeneration = 0;
let completedOffscreenResetGeneration = 0;
const transportPorts = new Set();

function safeEventUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = new URL(value);
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return value.split(/[?#]/, 1)[0];
  }
}

function publicCdpEvent(event, options = {}) {
  if (options.includeSensitive === true || !event.method?.startsWith("Network.")) return event;
  const params = event.params || {};
  let safeParams;
  if (event.method === "Network.responseReceived") {
    const response = params.response || {};
    safeParams = {
      requestId: params.requestId,
      loaderId: params.loaderId,
      timestamp: params.timestamp,
      type: params.type,
      response: {
        url: safeEventUrl(response.url),
        status: response.status,
        statusText: response.statusText,
        mimeType: response.mimeType,
        protocol: response.protocol,
        fromDiskCache: response.fromDiskCache,
        fromServiceWorker: response.fromServiceWorker,
        encodedDataLength: response.encodedDataLength
      }
    };
  } else if (event.method === "Network.requestWillBeSent") {
    const request = params.request || {};
    safeParams = {
      requestId: params.requestId,
      loaderId: params.loaderId,
      documentURL: safeEventUrl(params.documentURL),
      timestamp: params.timestamp,
      type: params.type,
      frameId: params.frameId,
      request: {
        url: safeEventUrl(request.url),
        method: request.method,
        hasPostData: request.hasPostData
      }
    };
  } else if (event.method === "Network.loadingFinished") {
    safeParams = {
      requestId: params.requestId,
      timestamp: params.timestamp,
      encodedDataLength: params.encodedDataLength
    };
  } else if (event.method === "Network.loadingFailed") {
    safeParams = {
      requestId: params.requestId,
      timestamp: params.timestamp,
      type: params.type,
      errorText: params.errorText,
      canceled: params.canceled,
      blockedReason: params.blockedReason
    };
  } else {
    safeParams = {
      requestId: params.requestId,
      loaderId: params.loaderId,
      timestamp: params.timestamp,
      type: params.type
    };
  }
  return { sequence: event.sequence, method: event.method, params: safeParams, source: event.source };
}

function selectCdpEvents(buffered, currentSequence, options = {}) {
  const afterSequence = Number(options.afterSequence || 0);
  const limit = Math.min(1000, Math.max(1, Number(options.limit || 100)));
  const truncated = buffered.length > 0 && afterSequence > 0 && afterSequence < buffered[0].sequence - 1;
  let events = buffered.filter((event) => event.sequence > afterSequence);
  if (options.methods?.length) events = events.filter((event) => options.methods.includes(event.method));
  if (options.methodPrefixes?.length) {
    events = events.filter((event) => options.methodPrefixes.some((prefix) => event.method.startsWith(prefix)));
  }
  if (options.urlIncludes?.length) {
    events = events.filter((event) => {
      const url = event.params?.response?.url || event.params?.request?.url || event.params?.documentURL || "";
      return options.urlIncludes.some((part) => url.includes(part));
    });
  }
  if (options.target?.sessionId) events = events.filter((event) => event.source?.sessionId === options.target.sessionId);
  if (options.target?.targetId) {
    events = events.filter((event) =>
      event.params?.targetInfo?.targetId === options.target.targetId || event.params?.targetId === options.target.targetId);
  }
  const page = events.slice(0, limit).map((event) => publicCdpEvent(event, options));
  return {
    cursor: page.at(-1)?.sequence || currentSequence || 0,
    events: page,
    hasMore: events.length > page.length,
    truncated
  };
}

function callChrome(fn, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`Chrome API timed out: ${fn.name || "anonymous"}`));
    }, CHROME_API_TIMEOUT_MS);
    fn(...args, (value) => {
      const error = chrome.runtime.lastError;
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(new Error(error.message));
      else resolve(value);
    });
  });
}

function responseBodyBytes(response) {
  const body = String(response?.body || "");
  if (!response?.base64Encoded) return new TextEncoder().encode(body).byteLength;
  const padding = body.endsWith("==") ? 2 : body.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor(body.length * 3 / 4) - padding);
}

function cacheResponseBody(tabId, requestId, response) {
  const bytes = responseBodyBytes(response);
  if (bytes > RESPONSE_BODY_MAX_ITEM_BYTES) return;
  const cache = responseBodies.get(tabId) || new Map();
  cache.delete(requestId);
  cache.set(requestId, { ...response, bytes, capturedAt: Date.now() });
  let totalBytes = 0;
  for (const entry of cache.values()) totalBytes += entry.bytes;
  while (cache.size > RESPONSE_BODY_MAX_ENTRIES || totalBytes > RESPONSE_BODY_MAX_TOTAL_BYTES) {
    const oldestKey = cache.keys().next().value;
    const oldest = cache.get(oldestKey);
    cache.delete(oldestKey);
    totalBytes -= oldest?.bytes || 0;
  }
  responseBodies.set(tabId, cache);
}

async function captureJsonResponseBody(source, requestId) {
  const metadata = networkResponses.get(source.tabId)?.get(requestId);
  if (!metadata?.capture) return;
  try {
    const response = await callChrome(
      chrome.debugger.sendCommand,
      { tabId: source.tabId, ...(source.sessionId ? { sessionId: source.sessionId } : {}) },
      "Network.getResponseBody",
      { requestId }
    );
    cacheResponseBody(source.tabId, requestId, response);
  } catch {}
}

async function ensureOffscreen() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  if (chrome.runtime.getContexts) {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [offscreenUrl]
    });
    if (contexts.length) return;
  } else if (chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
    return;
  }
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ["LOCAL_STORAGE", "CLIPBOARD"],
      justification: "Maintain the localhost browser transport and provide extension-authorized clipboard access"
    }).finally(() => { creatingOffscreen = undefined; });
  }
  await creatingOffscreen;
}

async function ensureHostPage() {
  try {
    const hostUrl = chrome.runtime.getURL("options.html");
    const existing = await chrome.tabs.query({ url: hostUrl });
    if (existing.length) {
      for (const duplicate of existing.slice(1)) {
        chrome.tabs.remove(duplicate.id).catch(() => {});
      }
      return existing[0].id;
    }
    const tab = await chrome.tabs.create({ url: hostUrl, active: false });
    return tab.id;
  } catch {
    return null;
  }
}

async function runOffscreenResetLoop() {
  while (completedOffscreenResetGeneration < requestedOffscreenResetGeneration) {
    const generation = requestedOffscreenResetGeneration;
    try {
      await chrome.offscreen.closeDocument();
    } catch {}
    creatingOffscreen = undefined;
    await ensureOffscreen();
    completedOffscreenResetGeneration = generation;
  }
}

async function resetOffscreen() {
  const targetGeneration = ++requestedOffscreenResetGeneration;
  while (completedOffscreenResetGeneration < targetGeneration) {
    if (!resettingOffscreen) {
      resettingOffscreen = runOffscreenResetLoop()
        .finally(() => { resettingOffscreen = undefined; });
    }
    await resettingOffscreen;
  }
}

async function ensureAttached(tabId) {
  if (attached.has(tabId)) return;
  try {
    await callChrome(chrome.debugger.attach, { tabId }, "1.3");
  } catch (error) {
    if (!/already attached/i.test(error.message)) throw error;
  }
  try {
    await callChrome(chrome.debugger.sendCommand, { tabId }, "Runtime.enable", {});
    await callChrome(chrome.debugger.sendCommand, { tabId }, "Page.enable", {});
    await callChrome(chrome.debugger.sendCommand, { tabId }, "Log.enable", {}).catch(() => {});
    await callChrome(chrome.debugger.sendCommand, { tabId }, "Network.enable", NETWORK_ENABLE_PARAMS);
    await callChrome(chrome.debugger.sendCommand, { tabId }, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true
    }).catch(() => {});
    attached.add(tabId);
  } catch (error) {
    attached.delete(tabId);
    await callChrome(chrome.debugger.detach, { tabId }).catch(() => {});
    throw error;
  }
}

async function cdp(tabId, method, params = {}, target = null) {
  await ensureAttached(tabId);
  if (method === "Network.getResponseBody" && params.requestId) {
    const cached = responseBodies.get(tabId)?.get(params.requestId);
    if (cached) return { body: cached.body, base64Encoded: cached.base64Encoded };
  }
  if (method === "Network.getRequestPostData" && params.requestId) {
    const buffered = cdpEvents.get(tabId) || [];
    const event = buffered.findLast((entry) =>
      entry.method === "Network.requestWillBeSent" &&
      entry.params?.requestId === params.requestId &&
      typeof entry.params?.request?.postData === "string"
    );
    if (event) return { postData: event.params.request.postData };
  }
  let sessionId = target?.sessionId;
  if (!sessionId && target?.targetId) {
    const key = `${tabId}:${target.targetId}`;
    sessionId = targetSessions.get(key);
    if (!sessionId) {
      const child = await callChrome(chrome.debugger.sendCommand, { tabId }, "Target.attachToTarget", {
        targetId: target.targetId,
        flatten: true
      });
      sessionId = child.sessionId;
      targetSessions.set(key, sessionId);
    }
  }
  try {
    return await callChrome(
      chrome.debugger.sendCommand,
      { tabId, ...(sessionId ? { sessionId } : {}) },
      method,
      params
    );
  } catch (error) {
    if (/Chrome API timed out/i.test(error?.message || "")) {
      attached.delete(tabId);
      for (const key of targetSessions.keys()) {
        if (key.startsWith(`${tabId}:`)) targetSessions.delete(key);
      }
      await callChrome(chrome.debugger.detach, { tabId }).catch(() => {});
    }
    throw error;
  }
}

async function readCdpEvents(tabId, options = {}) {
  const started = Date.now();
  const select = () => {
    const buffered = cdpEvents.get(tabId) || [];
    return selectCdpEvents(buffered, eventSequences.get(tabId) || 0, options);
  };
  while (true) {
    const result = select();
    if (result.events.length || !options.timeoutMs || Date.now() - started >= options.timeoutMs) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function publicTab(tab) {
  return {
    id: String(tab.id),
    windowId: tab.windowId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    highlighted: tab.highlighted,
    status: tab.status,
    lastAccessed: tab.lastAccessed
  };
}

function renderedConsoleLogs(tabId, { filter, levels, limit = 100 } = {}) {
  const allowed = Array.isArray(levels) && levels.length
    ? new Set(levels.map((level) => level === "warning" ? "warn" : level))
    : null;
  const needle = typeof filter === "string" ? filter : "";
  return (consoleLogs.get(tabId) || []).map((entry) => {
    if (entry.method === "Log.entryAdded") {
      const source = entry.params?.entry || {};
      return {
        level: source.level === "warning" ? "warn" : (source.level || "log"),
        message: source.text || "",
        timestamp: entry.timestamp,
        ...(source.url ? { url: source.url } : {})
      };
    }
    const source = entry.params || {};
    const message = (source.args || []).map((arg) =>
      arg.value == null ? (arg.description || arg.type || "") : String(arg.value)
    ).join(" ");
    return {
      level: source.type === "warning" ? "warn" : (source.type || "log"),
      message,
      timestamp: entry.timestamp,
      ...(source.stackTrace?.callFrames?.[0]?.url ? { url: source.stackTrace.callFrames[0].url } : {})
    };
  }).filter((entry) =>
    (!allowed || allowed.has(entry.level)) &&
    (!needle || entry.message.includes(needle))
  ).slice(-Math.min(1000, Math.max(1, Number(limit) || 100)));
}

async function command(method, params = {}) {
  const tabId = params.tabId == null ? undefined : Number(params.tabId);
  switch (method) {
    case "selftest": {
      const platform = await callChrome(chrome.runtime.getPlatformInfo);
      const tabs = await callChrome(chrome.tabs.query, {});
      const active = params.tabId != null
        ? tabs.find((tab) => tab.id === Number(params.tabId))
        : tabs.find((tab) => /^https?:/.test(tab.url || ""));
      let cdpResult = null;
      if (active) {
        cdpResult = await cdp(active.id, "Runtime.evaluate", {
          expression: "({title:document.title,url:location.href})",
          returnByValue: true
        });
      }
      return { platform, tabCount: tabs.length, cdp: cdpResult?.result?.value || null };
    }
    case "tabs.list":
      return (await callChrome(chrome.tabs.query, {})).map(publicTab);
    case "tabs.get":
      return publicTab(await callChrome(chrome.tabs.get, tabId));
    case "tabs.new":
      return publicTab(await callChrome(chrome.tabs.create, { url: params.url || "about:blank", active: false }));
    case "tabs.update":
      return publicTab(await callChrome(chrome.tabs.update, tabId, params.updateProperties || {}));
    case "tabs.activate": {
      const tab = await callChrome(chrome.tabs.get, tabId);
      await callChrome(chrome.tabs.update, tabId, { active: true });
      await callChrome(chrome.windows.update, tab.windowId, { state: "normal", focused: true });
      return publicTab(await callChrome(chrome.tabs.get, tabId));
    }
    case "tabs.remove":
      await callChrome(chrome.tabs.remove, tabId); return null;
    case "tabs.reload":
      await callChrome(chrome.tabs.reload, tabId, params.reloadProperties || {}); return null;
    case "tabs.goBack":
      await callChrome(chrome.tabs.goBack, tabId); return null;
    case "tabs.goForward":
      await callChrome(chrome.tabs.goForward, tabId); return null;
    case "tabs.selected": {
      const [tab] = await callChrome(chrome.tabs.query, { active: true, lastFocusedWindow: true });
      return tab ? publicTab(tab) : null;
    }
    case "history.search":
      return callChrome(chrome.history.search, params.query || { text: "", maxResults: 100 });
    case "debugger.attach":
      await ensureAttached(tabId); return null;
    case "debugger.detach":
      await callChrome(chrome.debugger.detach, { tabId }).catch(() => {});
      attached.delete(tabId); return null;
    case "cdp.send":
      return cdp(tabId, params.cdpMethod, params.cdpParams || {}, params.cdpOptions?.target);
    case "cdp.readEvents":
      await ensureAttached(tabId);
      return readCdpEvents(tabId, params.options || {});
    case "clipboard.readText":
      return cdp(tabId, "Runtime.evaluate", { expression: "navigator.clipboard.readText()", awaitPromise: true, returnByValue: true });
    case "clipboard.writeText":
      return cdp(tabId, "Runtime.evaluate", { expression: `navigator.clipboard.writeText(${JSON.stringify(params.text)})`, awaitPromise: true, returnByValue: true });
    case "dev.logs":
      return renderedConsoleLogs(tabId, params);
    case "puppeteer.session":
      return callTabSession(tabId, params.action, params.options || {});
    default:
      throw new Error(`Unsupported extension command: ${method}`);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "agentos-bootstrap-registered") {
    const attemptId = String(message.attemptId || "");
    if (!/^[0-9a-f-]{36}$/i.test(attemptId)) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.storage.session.get(["bootstrapAttemptId", "bootstrapRegistrationGrant"])
      .then(async (pending) => {
        if (
          pending.bootstrapAttemptId !== attemptId
          || !pending.bootstrapRegistrationGrant
        ) {
          sendResponse({ ok: false });
          return;
        }
        await chrome.storage.session.remove([
          "bootstrapAttemptId",
          "bootstrapRegistrationGrant"
        ]);
        await chrome.storage.session.set({
          bootstrapRegisteredAttemptId: attemptId,
          bootstrapRegisteredAt: new Date().toISOString()
        });
        sendResponse({ ok: true });
      })
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "agentos-transport-stage") {
    const stage = String(message.stage || "");
    if (!BOOTSTRAP_TRANSPORT_STAGES.has(stage)) {
      sendResponse({ ok: false });
      return false;
    }
    chrome.storage.session.set({ agentosBootstrapTransportStage: stage })
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (message?.type === "agentos-get-config") {
    let extensionMeta = { version: "", buildId: "" };
    try {
      const manifest = chrome.runtime.getManifest();
      extensionMeta = {
        version: String(manifest?.version || ""),
        buildId: typeof manifest?.version_name === "string"
          ? manifest.version_name.trim()
          : ""
      };
    } catch {}
    Promise.all([
      chrome.storage.local.get(["profileName", "bridgeUrl", "secret"]),
      chrome.storage.session.get(["bootstrapAttemptId", "bootstrapRegistrationGrant"])
    ])
      .then(([local, session]) => sendResponse({ ...local, ...session, extensionMeta }))
      .catch((error) => sendResponse({ error: error?.message || String(error) }));
    return true;
  }
  if (message?.type === "agentos-config-changed") {
    resetOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message?.type !== "agentos-command") return false;
  command(message.request.method, message.request.params)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (port?.name !== "agentos-transport") return;
  transportPorts.add(port);
  port.onDisconnect?.addListener(() => {
    transportPorts.delete(port);
    ensureOffscreen().catch(console.error);
    ensureHostPage().catch(console.error);
  });
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  const sequence = (eventSequences.get(source.tabId) || 0) + 1;
  eventSequences.set(source.tabId, sequence);
  const events = cdpEvents.get(source.tabId) || [];
  events.push({ sequence, method, params, source });
  if (events.length > 5000) events.splice(0, events.length - 5000);
  cdpEvents.set(source.tabId, events);
  if (method === "Network.responseReceived" && params?.requestId) {
    const responses = networkResponses.get(source.tabId) || new Map();
    const mimeType = String(params.response?.mimeType || "").toLowerCase();
    responses.set(params.requestId, {
      capture: ["XHR", "Fetch"].includes(params.type) && mimeType.includes("json"),
      receivedAt: Date.now()
    });
    while (responses.size > 2000) responses.delete(responses.keys().next().value);
    networkResponses.set(source.tabId, responses);
  } else if (method === "Network.loadingFinished" && params?.requestId) {
    captureJsonResponseBody(source, params.requestId);
  } else if (method === "Network.loadingFailed" && params?.requestId) {
    networkResponses.get(source.tabId)?.delete(params.requestId);
  }
  if (method === "Target.attachedToTarget" && params?.sessionId) {
    callChrome(
      chrome.debugger.sendCommand,
      { tabId: source.tabId, sessionId: params.sessionId },
      "Network.enable",
      NETWORK_ENABLE_PARAMS
    ).catch(() => {});
  }
  if (!["Runtime.consoleAPICalled", "Log.entryAdded"].includes(method)) return;
  const entries = consoleLogs.get(source.tabId) || [];
  entries.push({ method, params, timestamp: new Date().toISOString() });
  if (entries.length > 1000) entries.splice(0, entries.length - 1000);
  consoleLogs.set(source.tabId, entries);
});
chrome.debugger.onDetach.addListener((source) => {
  attached.delete(source.tabId);
  networkResponses.delete(source.tabId);
  responseBodies.delete(source.tabId);
});
chrome.tabs.onRemoved.addListener((tabId) => {
  disposeTabSession(tabId).catch(() => {});
});
chrome.downloads.onCreated.addListener((item) => {
  recordBrowserDownload(item);
});
chrome.downloads.onChanged.addListener((delta) => {
  updateBrowserDownload(delta);
});
chrome.runtime.onInstalled.addListener(() => ensureOffscreen().catch(console.error));
chrome.runtime.onStartup.addListener(() => {
  ensureOffscreen().catch(console.error);
  ensureHostPage().catch(console.error);
});
chrome.alarms.create("agentos-offscreen", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(({ name }) => {
  if (name === "agentos-offscreen") {
    ensureOffscreen().catch(console.error);
    ensureHostPage().catch(console.error);
  }
});
ensureOffscreen().catch(console.error);
