let socket;
let reconnectTimer;
let lastServerMessageAt = 0;
const SERVER_MESSAGE_TIMEOUT_MS = 40_000;
let transportPort;

function keepTransportAlive() {
  try {
    if (chrome.runtime?.connect) {
      transportPort = chrome.runtime.connect({ name: "agentos-transport" });
      transportPort.onDisconnect?.addListener(() => {
        transportPort = undefined;
        reconnect(0);
      });
    }
  } catch {}
}

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
  return parsed;
}

function publishTransportStage(stage) {
  chrome.runtime.sendMessage({ type: "agentos-transport-stage", stage }).catch(() => {});
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {}
  const input = document.createElement("textarea");
  input.value = text;
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  if (!copied) throw new Error("Clipboard write was rejected");
}

async function readClipboard() {
  try {
    return await navigator.clipboard.readText();
  } catch {}
  const input = document.createElement("textarea");
  document.body.append(input);
  input.focus();
  const pasted = document.execCommand("paste");
  const value = input.value;
  input.remove();
  if (!pasted) throw new Error("Clipboard read was rejected");
  return value;
}

async function settings() {
  return chrome.runtime.sendMessage({ type: "agentos-get-config" });
}

function reconnect(delay = 1000) {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, delay);
}

async function connect() {
  let profileName;
  let bridgeUrl;
  let secret;
  let bootstrapAttemptId;
  let bootstrapRegistrationGrant;
  let extensionMeta = {};
  let version = "";
  let buildId = "";
  try {
    publishTransportStage("settings-read");
    ({
      profileName,
      bridgeUrl,
      secret,
      bootstrapAttemptId,
      bootstrapRegistrationGrant,
      extensionMeta
    } = await settings());
    version = String(extensionMeta?.version || "");
    buildId = String(extensionMeta?.buildId || "").trim();
    if (!buildId || buildId.length > 128) {
      publishTransportStage("build-id-invalid");
      reconnect();
      return;
    }
    if (!profileName || !secret || !bridgeUrl) {
      publishTransportStage("settings-invalid");
      reconnect();
      return;
    }
    if (socket && socket.readyState <= WebSocket.OPEN) return;
    const url = strictBridgeUrl(bridgeUrl);
    url.searchParams.set("secret", secret);
    socket = new WebSocket(url);
    publishTransportStage("socket-created");
  } catch {
    publishTransportStage("settings-invalid");
    reconnect();
    return;
  }
  socket.onopen = () => {
    publishTransportStage("socket-open");
    lastServerMessageAt = Date.now();
    localStorage.setItem("agentosLastConnectedAt", new Date().toISOString());
    socket.send(JSON.stringify({
      kind: "register",
      profileName,
      extensionId: chrome.runtime.id,
      version,
      buildId,
      capabilities: ["cdp", "tabs", "history", "clipboard", "offscreen"],
      ...(bootstrapAttemptId && bootstrapRegistrationGrant
        ? {
            attemptId: bootstrapAttemptId,
            registrationGrant: bootstrapRegistrationGrant
          }
        : {})
    }));
    publishTransportStage("register-sent");
  };
  socket.onmessage = async ({ data }) => {
    lastServerMessageAt = Date.now();
    let request;
    try { request = JSON.parse(data); } catch { return; }
    if (request.kind === "registered") {
      if (
        request.profileName !== profileName
        || request.extensionId !== chrome.runtime.id
        || request.buildId !== buildId
      ) {
        socket?.close();
        return;
      }
      if (bootstrapAttemptId || bootstrapRegistrationGrant) {
        if (
          !bootstrapAttemptId
          || !bootstrapRegistrationGrant
          || request.attemptId !== bootstrapAttemptId
        ) {
          socket?.close();
          return;
        }
        const confirmation = await chrome.runtime.sendMessage({
          type: "agentos-bootstrap-registered",
          attemptId: bootstrapAttemptId
        }).catch((error) => ({ ok: false, error: error?.message || String(error) }));
        if (!confirmation?.ok) {
          socket?.close();
          return;
        }
      }
      localStorage.setItem("agentosRegisteredProfile", request.profileName);
      publishTransportStage("registered");
      return;
    }
    if (request.kind === "ping") {
      socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
      return;
    }
    if (request.kind !== "request" || !request.id) return;
    let response;
    try {
      if (request.method === "clipboard.readText") {
        const value = await readClipboard();
        response = { ok: true, result: { result: { value } } };
      } else if (request.method === "clipboard.writeText") {
        await writeClipboard(String(request.params?.text || ""));
        response = { ok: true, result: null };
      } else {
        response = await chrome.runtime.sendMessage({ type: "agentos-command", request });
      }
    } catch (error) {
      response = { ok: false, error: error?.message || String(error) };
    }
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ kind: "response", id: request.id, ...response }));
    }
  };
  socket.onclose = () => {
    publishTransportStage("socket-close");
    localStorage.setItem("agentosLastDisconnectedAt", new Date().toISOString());
    socket = undefined;
    lastServerMessageAt = 0;
    reconnect();
  };
  socket.onerror = () => {
    publishTransportStage("socket-error");
    socket?.close();
  };
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "agentos-reconnect") {
    socket?.close();
    reconnect(0);
  }
});

keepTransportAlive();
connect();
setInterval(() => {
  if (socket?.readyState === WebSocket.OPEN &&
      lastServerMessageAt > 0 &&
      Date.now() - lastServerMessageAt > SERVER_MESSAGE_TIMEOUT_MS) {
    localStorage.setItem("agentosHeartbeatTimedOutAt", new Date().toISOString());
    socket.close();
  } else if (!socket || socket.readyState === WebSocket.CLOSED) {
    reconnect(0);
  }
}, 5_000);
