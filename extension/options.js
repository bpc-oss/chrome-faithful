const fields = ["profileName", "bridgeUrl", "secret"];
const RELOAD_MARKER_KEY = "agentosExtensionReloadMarker";
const RELOAD_MARKER_MAX_AGE_MS = 60_000;
function strictBridgeUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value || "").trim());
  } catch {
    throw new Error("invalid local bridge URL");
  }
  const port = Number(parsed.port);
  if (
    parsed.protocol !== "ws:"
    || parsed.hostname !== "127.0.0.1"
    || parsed.username
    || parsed.password
    || !parsed.port
    || !Number.isInteger(port)
    || port < 1024
    || port > 65535
    || parsed.pathname !== "/extension"
    || parsed.search
    || parsed.hash
  ) {
    throw new Error("invalid local bridge URL");
  }
  return `ws://127.0.0.1:${port}/extension`;
}
if (new URLSearchParams(location.search).get("reload") === "1") {
  const current = await chrome.tabs.getCurrent().catch(() => null);
  if (!Number.isInteger(current?.id) || current.id < 0) {
    throw new Error("extension reload requires its own valid options tab");
  }
  await chrome.storage.local.set({
    [RELOAD_MARKER_KEY]: { tabId: current.id, requestedAt: Date.now() }
  });
  history.replaceState(null, "", location.pathname);
  chrome.runtime.reload();
  await new Promise(() => {});
}
const reloadMarkerState = await chrome.storage.local.get([RELOAD_MARKER_KEY]);
const reloadMarker = reloadMarkerState[RELOAD_MARKER_KEY];
if (reloadMarker != null) {
  const markerTabId = reloadMarker?.tabId;
  const markerRequestedAt = reloadMarker?.requestedAt;
  const markerAgeMs = Date.now() - markerRequestedAt;
  const markerValid = Number.isInteger(markerTabId)
    && markerTabId >= 0
    && Number.isFinite(markerRequestedAt)
    && markerAgeMs >= 0
    && markerAgeMs <= RELOAD_MARKER_MAX_AGE_MS;
  if (!markerValid) {
    await chrome.storage.local.remove([RELOAD_MARKER_KEY]);
  } else {
    const current = await chrome.tabs.getCurrent().catch(() => null);
    if (current?.id === markerTabId) {
      await chrome.storage.local.remove([RELOAD_MARKER_KEY]);
      await chrome.tabs.remove(current.id).catch(() => {});
      await new Promise(() => {});
    }
  }
}
const bootstrapParams = new URLSearchParams(location.hash.replace(/^#/, ""));
const bootstrapToken = bootstrapParams.get("bootstrap") || "";
const bootstrapPort = Number(bootstrapParams.get("port"));
let bootstrapSucceeded = false;
let bootstrapStage = "validate-input";
if (bootstrapToken && (!chrome.storage?.local || !chrome.storage?.session)) {
  chrome.runtime.reload();
  await new Promise(() => {});
}
if (bootstrapToken) {
  const status = document.getElementById("status");
  history.replaceState(null, "", location.pathname);
  try {
    if (!/^[A-Za-z0-9_-]{43}$/.test(bootstrapToken)) throw new Error("invalid bootstrap token");
    if (!Number.isInteger(bootstrapPort) || bootstrapPort < 1024 || bootstrapPort > 65535) {
      throw new Error("invalid bootstrap port");
    }
    bootstrapStage = "fetch-grant";
    const response = await fetch(`http://127.0.0.1:${bootstrapPort}/bootstrap`, {
      method: "POST",
      body: bootstrapToken,
      cache: "no-store",
      credentials: "omit",
      referrerPolicy: "no-referrer"
    });
    const bootstrap = await response.json();
    if (!response.ok || !bootstrap.ok) throw new Error(bootstrap.error || `HTTP ${response.status}`);
    const next = Object.fromEntries(fields.map((key) => [key, String(bootstrap[key] || "").trim()]));
    const attemptId = String(bootstrap.attemptId || "").trim();
    const registrationGrant = String(bootstrap.registrationGrant || "").trim();
    bootstrapStage = "validate-binding";
    if (!next.profileName || !next.secret) {
      throw new Error("invalid bootstrap response");
    }
    next.bridgeUrl = strictBridgeUrl(next.bridgeUrl);
    if (!/^[0-9a-f-]{36}$/i.test(attemptId) || !/^[A-Za-z0-9_-]{43}$/.test(registrationGrant)) {
      throw new Error("invalid bootstrap registration binding");
    }
    bootstrapStage = "persist-binding";
    await chrome.storage.local.set(next);
    await chrome.storage.session.remove([
      "bootstrapRegisteredAttemptId",
      "bootstrapRegisteredAt",
      "agentosBootstrapTransportStage"
    ]);
    await chrome.storage.session.set({
      bootstrapAttemptId: attemptId,
      bootstrapRegistrationGrant: registrationGrant
    });
    bootstrapStage = "offscreen-reset";
    const diagnostic = await chrome.runtime.sendMessage({ type: "agentos-config-changed" })
      .catch((error) => ({ ok: false, error: error.message }));
    if (!diagnostic?.ok) throw new Error(diagnostic?.error || "extension reconnect failed");
    bootstrapStage = "registration-ack";
    const registrationDeadline = Date.now() + 10_000;
    let registered = false;
    let transportStage = "";
    while (Date.now() < registrationDeadline) {
      const acknowledgement = await chrome.storage.session.get([
        "bootstrapRegisteredAttemptId",
        "agentosBootstrapTransportStage"
      ]);
      transportStage = String(acknowledgement.agentosBootstrapTransportStage || "");
      if (acknowledgement.bootstrapRegisteredAttemptId === attemptId) {
        registered = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (!registered) {
      const boundedStage = /^(?:settings-read|settings-invalid|build-id-invalid|socket-created|socket-open|register-sent|socket-error|socket-close|registered)$/.test(transportStage)
        ? transportStage
        : "unknown";
      bootstrapStage = `registration-ack-${boundedStage}`;
      throw new Error("extension registration acknowledgement timed out");
    }
    await chrome.storage.session.remove([
      "bootstrapRegisteredAttemptId",
      "bootstrapRegisteredAt",
      "agentosBootstrapTransportStage"
    ]);
    bootstrapSucceeded = true;
    document.title = "Chrome Faithful - connected";
    status.textContent = `已安全连接：${next.profileName}（这是插件的常驻宿主页，请保持打开）`;
  } catch (error) {
    await chrome.storage.session?.remove([
      "bootstrapAttemptId",
      "bootstrapRegistrationGrant",
      "bootstrapRegisteredAttemptId",
      "bootstrapRegisteredAt",
      "agentosBootstrapTransportStage"
    ]).catch(() => {});
    document.title = `Chrome Faithful - bootstrap-error:${bootstrapStage}`;
    status.textContent = `连接失败：${error.message}`;
  }
}
const values = await chrome.storage.local.get(fields);
for (const key of fields) if (values[key]) document.getElementById(key).value = values[key];
if (!bootstrapToken && !bootstrapSucceeded && values.profileName && values.bridgeUrl && values.secret) {
  const diagnostic = await chrome.runtime.sendMessage({ type: "agentos-config-changed" })
    .catch((error) => ({ ok: false, error: error.message }));
  document.title = diagnostic?.ok
    ? "Chrome Faithful - connected"
    : "Chrome Faithful - error";
}
document.getElementById("save").addEventListener("click", async () => {
  const next = Object.fromEntries(fields.map((key) => [key, document.getElementById(key).value.trim()]));
  const status = document.getElementById("status");
  if (!next.profileName || !next.secret) {
    status.textContent = "请填写 Profile、密钥和本机 ws 地址";
    return;
  }
  try {
    next.bridgeUrl = strictBridgeUrl(next.bridgeUrl);
  } catch {
    status.textContent = "本机 bridge 地址无效";
    return;
  }
  await chrome.storage.local.set(next);
  await chrome.runtime.sendMessage({ type: "agentos-config-changed" }).catch(() => {});
  status.textContent = "已保存";
});
