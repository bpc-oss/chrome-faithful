const INACCESSIBLE_TAB_URL = /^(?:chrome|edge|devtools):\/\//i;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAboutBlank(router, profileName, tabId, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const tab = await router.request(profileName, "tabs.get", { tabId }).catch(() => null);
    if (tab?.url === "about:blank" && tab?.status !== "loading") return tab;
    await sleep(50);
  }
  throw new Error(`Temporary self-test tab did not become ready: ${tabId}`);
}

export async function runProfileSelftest({
  router,
  getBrowser,
  profileName,
  tabId,
  implementationVersion
}) {
  const browser = await getBrowser(profileName);
  const tabs = await browser.tabs.list();
  const requestedTabId = tabId == null ? null : String(tabId);
  const requestedTab = requestedTabId == null
    ? null
    : tabs.find((entry) => String(entry.id) === requestedTabId);
  if (requestedTabId != null && !requestedTab) {
    throw new Error(`Chrome tab not found in profile ${profileName}: ${requestedTabId}`);
  }

  let effectiveTabId = requestedTabId;
  let temporaryTab = null;
  let temporaryTabClosed = false;
  const needsTemporaryTab = effectiveTabId == null || INACCESSIBLE_TAB_URL.test(requestedTab?.url || "");

  if (needsTemporaryTab) {
    temporaryTab = await browser.tabs.new();
    effectiveTabId = String(temporaryTab.id);
  }

  try {
    if (temporaryTab) {
      await router.request(profileName, "tabs.update", {
        tabId: effectiveTabId,
        updateProperties: { url: "about:blank" }
      });
      await waitForAboutBlank(router, profileName, effectiveTabId);
    }
    const result = await router.request(profileName, "selftest", { tabId: effectiveTabId });
    return {
      implementationVersion,
      profileName,
      requestedTabId,
      tabId: effectiveTabId,
      temporaryTabUsed: Boolean(temporaryTab),
      ...result,
      ok: Boolean(result?.platform && result?.tabCount > 0 && result?.cdp)
    };
  } finally {
    if (temporaryTab) {
      await router.request(profileName, "tabs.remove", { tabId: effectiveTabId });
      temporaryTabClosed = true;
    }
    if (temporaryTab && !temporaryTabClosed) {
      throw new Error(`Temporary self-test tab cleanup failed: ${effectiveTabId}`);
    }
  }
}
