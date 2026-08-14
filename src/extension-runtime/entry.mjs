const { connect, ExtensionTransport } = globalThis.__agentOsPuppeteer;
if (typeof connect !== "function" || typeof ExtensionTransport?.connectTab !== "function") {
  throw new Error("Bundled Puppeteer browser runtime is unavailable");
}

import { EventRegistry } from "./event-registry.mjs";

const sessions = new Map();
const rawDownloads = new Map();

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== "Page.downloadProgress") return;
  const resource = rawDownloads.get(params.guid);
  if (!resource || resource.tabId !== source.tabId) return;
  resource.state = params.state;
  resource.receivedBytes = params.receivedBytes;
  resource.totalBytes = params.totalBytes;
  if (params.state === "canceled") resource.error = "canceled";
});

async function inspectPoint(page, { x, y, includeNonInteractable = false }) {
  return page.evaluate(({ x, y, includeNonInteractable }) => {
    const nodes = document.elementsFromPoint(x, y);
    const interactable = (element) =>
      element.matches("a,button,input,textarea,select,summary,[role],[contenteditable='true'],[tabindex]");
    return nodes.filter((element) => includeNonInteractable || interactable(element)).map((element) => {
      const rect = element.getBoundingClientRect();
      const testId = element.getAttribute("data-testid");
      const id = element.id ? `#${CSS.escape(element.id)}` : null;
      const tag = element.tagName.toLowerCase();
      const primary = id || (testId ? `[data-testid="${CSS.escape(testId)}"]` : tag);
      return {
        ariaName: element.getAttribute("aria-label"),
        boundingBox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        nodeId: null,
        preview: element.outerHTML.slice(0, 300),
        role: element.getAttribute("role"),
        selector: { candidates: [primary, tag], primary },
        tagName: tag,
        testId,
        visibleText: element.innerText || ("value" in element ? element.value : null)
      };
    });
  }, { x: Number(x), y: Number(y), includeNonInteractable: !!includeNonInteractable });
}

async function activateForCapture(tabId) {
  await chrome.tabs.update(tabId, { active: true });
}

async function capturePage(session, { fullPage = false, clip } = {}) {
  const client = session.page._client();
  let resolvedClip = clip ? { ...clip, scale: 1 } : undefined;
  if (fullPage && !resolvedClip) {
    const metrics = await client.send("Page.getLayoutMetrics");
    resolvedClip = {
      x: 0,
      y: 0,
      width: metrics.cssContentSize?.width || metrics.contentSize.width,
      height: metrics.cssContentSize?.height || metrics.contentSize.height,
      scale: 1
    };
  }
  return client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: !!resolvedClip,
    ...(resolvedClip ? { clip: resolvedClip } : {})
  });
}

async function waitForRawFileChooser(session, timeoutMs) {
  await chrome.debugger.sendCommand(
    { tabId: session.tabId },
    "Page.setInterceptFileChooserDialog",
    { enabled: true }
  );
  return new Promise((resolve, reject) => {
    const boundedTimeout = Math.min(120000, Math.max(1, Number(timeoutMs) || 30000));
    const cleanup = () => {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(onEvent);
    };
    const onEvent = (source, method, params) => {
      if (source.tabId !== session.tabId || method !== "Page.fileChooserOpened") return;
      cleanup();
      resolve(session.events.emit("filechooser", {
        multiple: params.mode === "selectMultiple"
      }, {
        kind: "raw-filechooser",
        backendNodeId: params.backendNodeId,
        mode: params.mode
      }));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Waiting for FileChooser failed: ${boundedTimeout}ms exceeded`));
    }, boundedTimeout);
    chrome.debugger.onEvent.addListener(onEvent);
  });
}

async function waitForRawDownload(session, timeoutMs) {
  return new Promise((resolve, reject) => {
    const boundedTimeout = Math.min(120000, Math.max(1, Number(timeoutMs) || 30000));
    const cleanup = () => {
      clearTimeout(timer);
      chrome.debugger.onEvent.removeListener(onEvent);
    };
    const onEvent = (source, method, params) => {
      if (source.tabId !== session.tabId || method !== "Page.downloadWillBegin") return;
      cleanup();
      const resource = {
        kind: "raw-download",
        tabId: session.tabId,
        guid: params.guid,
        suggestedFilename: params.suggestedFilename,
        url: params.url,
        state: "inProgress"
      };
      rawDownloads.set(params.guid, resource);
      resolve(session.events.emit("download", {
        guid: params.guid,
        suggestedFilename: params.suggestedFilename
      }, resource));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timed out waiting for tab event download after ${boundedTimeout}ms`));
    }, boundedTimeout);
    chrome.debugger.onEvent.addListener(onEvent);
  });
}

function numericTabId(tabId) {
  const value = Number(tabId);
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`Invalid Chrome tab id: ${tabId}`);
  }
  return value;
}

export async function getTabSession(tabId) {
  const id = numericTabId(tabId);
  const current = sessions.get(id);
  if (current) return current;

  let transport;
  try {
    transport = await ExtensionTransport.connectTab(id);
  } catch (error) {
    if (!/already attached|debugger is already attached/i.test(error?.message || "")) throw error;
    transport = new ExtensionTransport(id);
  }
  const browser = await connect({ transport });
  const pages = await browser.pages();
  if (pages.length !== 1) {
    await browser.disconnect();
    throw new Error(`ExtensionTransport expected one page for tab ${id}; found ${pages.length}`);
  }
  const session = {
    tabId: id,
    transport,
    browser,
    page: pages[0],
    events: new EventRegistry(),
    createdAt: new Date().toISOString()
  };
  const page = session.page;
  page.on("dialog", (dialog) => session.events.emit("dialog", {
    type: dialog.type(),
    message: dialog.message(),
    defaultValue: dialog.defaultValue()
  }, dialog));
  page.on("console", (message) => session.events.emit("console", {
    type: message.type(),
    text: message.text(),
    location: message.location()
  }));
  page.on("framenavigated", (frame) => session.events.emit("framenavigated", {
    url: frame.url(),
    name: frame.name()
  }));
  page.on("frameattached", (frame) => session.events.emit("frameattached", {
    url: frame.url(),
    name: frame.name()
  }));
  page.on("framedetached", (frame) => session.events.emit("framedetached", {
    url: frame.url(),
    name: frame.name()
  }));
  page.on("filechooser", (chooser) => session.events.emit("filechooser", {
    multiple: chooser.isMultiple()
  }, chooser));
  page.on("download", (download) => session.events.emit("download", {
    suggestedFilename: typeof download.suggestedFilename === "function" ? download.suggestedFilename() : undefined
  }, download));
  page.on("error", (error) => session.events.emit("pageerror", {
    name: error?.name || "Error",
    message: error?.message || String(error)
  }));
  page.on("close", () => {
    session.events.emit("close", {});
    session.events.close(new Error(`Tab session ${id} closed`));
  });
  sessions.set(id, session);
  browser.on("disconnected", () => {
    if (sessions.get(id) === session) {
      sessions.delete(id);
      session.events.close(new Error(`Tab session ${id} disconnected`));
    }
  });
  return session;
}

export async function disposeTabSession(tabId) {
  const id = numericTabId(tabId);
  const session = sessions.get(id);
  if (!session) return false;
  sessions.delete(id);
  session.events.close(new Error(`Tab session ${id} disposed`));
  await session.browser.disconnect();
  return true;
}

export async function disposeAllTabSessions() {
  const active = [...sessions.values()];
  sessions.clear();
  await Promise.allSettled(active.map((session) => session.browser.disconnect()));
}

export function listTabSessions() {
  return [...sessions.values()].map(({ tabId, createdAt }) => ({ tabId, createdAt }));
}

export function recordBrowserDownload(downloadItem) {
  const session = sessions.get(Number(downloadItem?.tabId));
  if (!session) return false;
  session.events.emit("download", {
    id: downloadItem.id,
    filename: downloadItem.filename,
    mime: downloadItem.mime,
    url: downloadItem.url,
    state: downloadItem.state
  }, { ...downloadItem });
  return true;
}

export function updateBrowserDownload(downloadDelta) {
  for (const session of sessions.values()) {
    const events = session.events.read({ names: ["download"], limit: 1000 }).events;
    for (const event of events) {
      const resource = event.resourceId && session.events.getResource(event.resourceId);
      if (!resource || resource.id !== downloadDelta?.id) continue;
      if (downloadDelta.filename?.current) resource.filename = downloadDelta.filename.current;
      if (downloadDelta.state?.current) resource.state = downloadDelta.state.current;
      if (downloadDelta.error?.current) resource.error = downloadDelta.error.current;
      return true;
    }
  }
  return false;
}

function requireResource(session, resourceId, kind) {
  const resource = session.events.getResource(resourceId);
  if (!resource) throw new Error(`${kind} resource is no longer available: ${resourceId}`);
  return resource;
}

async function waitForDownloadPath(resource, timeoutMs) {
  if (typeof resource.path === "function") return resource.path();
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (resource.error) throw new Error(`Download failed: ${resource.error}`);
    if (resource.state === "complete" || resource.state === "completed") {
      if (resource.kind === "raw-download") {
        const items = await chrome.downloads.search({
          query: [resource.suggestedFilename],
          orderBy: ["-startTime"],
          limit: 50
        });
        const match = items.find((item) =>
          item.state === "complete" &&
          (item.url === resource.url || item.finalUrl === resource.url) &&
          item.filename?.replaceAll("\\", "/").endsWith(`/${resource.suggestedFilename}`)
        );
        rawDownloads.delete(resource.guid);
        return match?.filename || null;
      }
      return resource.filename || null;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

export async function callTabSession(tabId, action, params = {}) {
  if (action === "list") return listTabSessions();
  if (action === "dispose") return { disposed: await disposeTabSession(tabId) };
  const session = await getTabSession(tabId);
  if (action === "info") {
    return {
      tabId: session.tabId,
      createdAt: session.createdAt,
      url: session.page.url(),
      title: await session.page.title(),
      frames: session.page.frames().map((frame) => ({
        url: frame.url(),
        name: frame.name()
      }))
    };
  }
  if (action === "screenshot") {
    await activateForCapture(session.tabId);
    return capturePage(session, params);
  }
  if (action === "elementInfo") return inspectPoint(session.page, params);
  if (action === "elementScreenshot") {
    await activateForCapture(session.tabId);
    const info = await inspectPoint(session.page, params);
    const token = `agentos-overlay-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    await session.page.evaluate(({ boxes, token, x, y }) => {
      for (const box of boxes) {
        const overlay = document.createElement("div");
        overlay.dataset.agentosOverlay = token;
        Object.assign(overlay.style, {
          position: "fixed", pointerEvents: "none", zIndex: "2147483647",
          left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px`,
          border: "3px solid #ff2d55", boxSizing: "border-box"
        });
        document.documentElement.append(overlay);
      }
      const point = document.createElement("div");
      point.dataset.agentosOverlay = token;
      Object.assign(point.style, {
        position: "fixed", pointerEvents: "none", zIndex: "2147483647",
        left: `${x - 6}px`, top: `${y - 6}px`, width: "12px", height: "12px",
        borderRadius: "50%", background: "#00d4ff", border: "2px solid white", boxSizing: "border-box"
      });
      document.documentElement.append(point);
    }, { boxes: info.map((entry) => entry.boundingBox).filter(Boolean), token, x: Number(params.x), y: Number(params.y) });
    try {
      return { ...(await capturePage(session)), info };
    } finally {
      await session.page.evaluate((token) => {
        document.querySelectorAll(`[data-agentos-overlay="${CSS.escape(token)}"]`).forEach((element) => element.remove());
      }, token).catch(() => {});
    }
  }
  if (action === "readEvents") return session.events.read(params);
  if (action === "waitForEvent") {
    if (typeof params.name !== "string" || !params.name) {
      throw new TypeError("waitForEvent requires a non-empty event name");
    }
    if (params.name === "filechooser") {
      return waitForRawFileChooser(session, params.timeoutMs);
    }
    if (params.name === "download") {
      return waitForRawDownload(session, params.timeoutMs);
    }
    return session.events.wait(params.name, params);
  }
  if (action === "currentDialog") {
    const dialogs = session.events.read({ names: ["dialog"], limit: 1000 }).events;
    const event = [...dialogs].reverse().find((entry) => entry.resourceId && session.events.getResource(entry.resourceId));
    return { event };
  }
  if (action === "dialogAct") {
    const dialog = requireResource(session, params.resourceId, "Dialog");
    if (params.action === "accept") await dialog.accept(params.text);
    else if (params.action === "dismiss") await dialog.dismiss();
    else throw new Error(`Unsupported dialog action: ${params.action}`);
    session.events.releaseResource(params.resourceId);
    return { ok: true };
  }
  if (action === "fileChooserSetFiles") {
    const chooser = requireResource(session, params.resourceId, "File chooser");
    const files = Array.isArray(params.files) ? params.files : [params.files];
    if (chooser.kind === "raw-filechooser") {
      await chrome.debugger.sendCommand(
        { tabId: session.tabId },
        "DOM.setFileInputFiles",
        { backendNodeId: chooser.backendNodeId, files }
      );
      await chrome.debugger.sendCommand(
        { tabId: session.tabId },
        "Page.setInterceptFileChooserDialog",
        { enabled: false }
      ).catch(() => {});
    } else {
      await chooser.accept(files);
    }
    session.events.releaseResource(params.resourceId);
    return { ok: true };
  }
  if (action === "downloadPath") {
    const download = requireResource(session, params.resourceId, "Download");
    return { path: await waitForDownloadPath(download, Math.min(120000, Math.max(1, Number(params.timeoutMs) || 30000))) };
  }
  if (action === "clipboardRead") {
    return session.page.evaluate(async () => {
      const items = await navigator.clipboard.read();
      return Promise.all(items.map(async (item) => ({
        presentationStyle: item.presentationStyle || "unspecified",
        entries: await Promise.all(item.types.map(async (mimeType) => {
          const blob = await item.getType(mimeType);
          const bytes = new Uint8Array(await blob.arrayBuffer());
          let binary = "";
          for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
          }
          return {
            mimeType,
            ...(mimeType.startsWith("text/") ? { text: await blob.text() } : { base64: btoa(binary) })
          };
        }))
      })));
    });
  }
  if (action === "clipboardWrite") {
    await session.page.evaluate(async (items) => {
      const decoded = items.map((item) => new ClipboardItem(Object.fromEntries(item.entries.map((entry) => {
        if (typeof entry.text === "string") return [entry.mimeType, new Blob([entry.text], { type: entry.mimeType })];
        const binary = atob(entry.base64 || "");
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        return [entry.mimeType, new Blob([bytes], { type: entry.mimeType })];
      })), { presentationStyle: item.presentationStyle }));
      await navigator.clipboard.write(decoded);
    }, params.items || []);
    return { ok: true };
  }
  if (action === "exportGsuite") {
    const pending = session.events.wait("download", { afterSequence: session.events.sequence, timeoutMs: params.timeoutMs || 120000 });
    await session.page.evaluate(({ url, type }) => {
      const parsed = new URL(url);
      const match = parsed.pathname.match(/^\/(?:document|spreadsheets|presentation)\/d\/([^/]+)/);
      if (!match) throw new Error("Unsupported Google Workspace URL");
      const base = parsed.pathname.startsWith("/document/") ? "document"
        : parsed.pathname.startsWith("/spreadsheets/") ? "spreadsheets"
          : "presentation";
      const format = type === "md" ? "txt" : type;
      const exportUrl = `https://docs.google.com/${base}/d/${match[1]}/export?format=${encodeURIComponent(format)}`;
      const anchor = document.createElement("a");
      anchor.href = exportUrl;
      anchor.download = "";
      anchor.hidden = true;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    }, { url: params.url, type: params.type });
    const event = await pending;
    const download = requireResource(session, event.resourceId, "Download");
    return { path: await waitForDownloadPath(download, params.timeoutMs || 120000) };
  }
  throw new Error(`Unsupported Puppeteer tab-session action: ${action}`);
}
