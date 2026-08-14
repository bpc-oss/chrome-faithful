import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { WebSocketServer } from "ws";
import { loadConfig } from "./config.mjs";

function sameSecret(actual, expected) {
  const left = Buffer.from(actual || "");
  const right = Buffer.from(expected || "");
  return left.length === right.length && timingSafeEqual(left, right);
}

const CHROME_EXTENSION_ID = /^[a-p]{32}$/;

function safeProfileDirectory(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 256
    && value !== "."
    && value !== ".."
    && !value.includes("/")
    && !value.includes("\\")
    && !value.includes("\0");
}

async function readBoundedBody(request, maxBytes) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

export class ProfileRouter {
  constructor({ commandTimeoutMs = 60000 } = {}) {
    this.commandTimeoutMs = commandTimeoutMs;
    this.profiles = new Map();
    this.pending = new Map();
  }

  register(socket, metadata, trustedBinding = {}) {
    const profileName = String(metadata.profileName || "").trim();
    if (!profileName) throw new Error("Extension registration requires profileName");
    const extensionId = String(metadata.extensionId || "").trim();
    if (!CHROME_EXTENSION_ID.test(extensionId)) {
      throw new Error("Extension registration requires a valid extensionId");
    }
    const buildId = String(metadata.buildId || "").trim();
    if (!buildId || buildId.length > 128) {
      throw new Error("Extension registration requires a valid buildId");
    }
    const existing = this.profiles.get(profileName);
    if (existing && existing.socket.readyState === existing.socket.OPEN) {
      if (
        trustedBinding.bindingVerified === true
        && existing.extensionId === extensionId
        && existing.buildId === buildId
      ) {
        this.unregister(existing);
        existing.socket.close(1000, "superseded by verified profile bootstrap");
      } else {
        throw new Error(`Duplicate live Chrome profile registration: ${profileName}`);
      }
    }
    const bindingVerified = trustedBinding.bindingVerified === true;
    const verifiedProfileDirectory = bindingVerified
      && safeProfileDirectory(trustedBinding.verifiedProfileDirectory)
      ? trustedBinding.verifiedProfileDirectory
      : null;
    if (bindingVerified && !verifiedProfileDirectory) {
      throw new Error("Verified Chrome profile registration requires a trusted profile directory");
    }
    const profile = {
      profileName,
      extensionId,
      buildId,
      bindingVerified,
      verifiedProfileDirectory,
      version: typeof metadata.version === "string" ? metadata.version.slice(0, 128) : "",
      capabilities: Array.isArray(metadata.capabilities)
        ? metadata.capabilities.filter((item) => typeof item === "string").slice(0, 64)
        : [],
      socket,
      connectedAt: new Date().toISOString(),
      lastSeenAt: Date.now()
    };
    this.profiles.set(profileName, profile);
    socket.on("message", (bytes) => this.onMessage(profile, bytes));
    socket.on("close", (code, reason) => {
      this.unregister(profile);
    });
    socket.on("error", (error) => {
      this.unregister(profile);
    });
    return profile;
  }

  unregister(profile) {
    if (this.profiles.get(profile.profileName)?.socket === profile.socket) {
      this.profiles.delete(profile.profileName);
    }
    for (const [id, pending] of this.pending) {
      if (pending.profile === profile) {
        clearTimeout(pending.timer);
        pending.reject(new Error(`Chrome profile disconnected: ${profile.profileName}`));
        this.pending.delete(id);
      }
    }
  }

  onMessage(profile, bytes) {
    let message;
    try { message = JSON.parse(bytes.toString()); } catch { return; }
    profile.lastSeenAt = Date.now();
    if (message.kind === "pong") return;
    if (message.kind !== "response" || !message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending || pending.profile !== profile) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id);
    if (message.ok) pending.resolve(message.result);
    else pending.reject(new Error(message.error || "Chrome extension command failed"));
  }

  list() {
    return [...this.profiles.values()]
      .filter((profile) => profile.socket.readyState === profile.socket.OPEN)
      .map(({ socket: _socket, ...profile }) => ({
        ...profile,
        lastSeenAt: new Date(profile.lastSeenAt).toISOString()
      }));
  }

  async request(profileName, method, params = {}, timeoutMs = this.commandTimeoutMs) {
    const profile = this.profiles.get(profileName);
    if (!profile || profile.socket.readyState !== profile.socket.OPEN) {
      throw new Error(`Chrome profile is not connected: ${profileName}`);
    }
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome command timed out: ${profileName} ${method}`));
      }, timeoutMs);
      this.pending.set(id, { profile, resolve, reject, timer });
      profile.socket.send(JSON.stringify({ kind: "request", id, method, params }));
    });
  }
}

export async function startBridge(config, dependencies = {}) {
  config ||= await loadConfig();
  const router = new ProfileRouter(config);
  const now = dependencies.now || Date.now;
  const bootstrapTtlMs = Math.min(
    5 * 60 * 1000,
    Math.max(1000, Number(dependencies.bootstrapTtlMs) || 5 * 60 * 1000)
  );
  const bootstrapTokens = new Map();
  const bootstrapRegistrationGrants = new Map();
  const bootstrapAttempts = new Map();

  const publicBootstrapReceipt = (record) => ({
    attemptId: record.attemptId,
    state: record.state,
    profileName: record.profileName,
    extensionId: record.extensionId,
    buildId: record.buildId,
    bindingVerified: record.bindingVerified === true,
    verifiedProfileDirectory: record.bindingVerified === true
      ? record.verifiedProfileDirectory
      : null,
    ...(record.registeredAt ? { registeredAt: record.registeredAt } : {}),
    ...(record.failureCode ? { failureCode: record.failureCode } : {})
  });

  const removeAttemptSecrets = (attemptId) => {
    for (const [token, candidate] of bootstrapTokens) {
      if (candidate === attemptId) bootstrapTokens.delete(token);
    }
    for (const [grant, candidate] of bootstrapRegistrationGrants) {
      if (candidate === attemptId) bootstrapRegistrationGrants.delete(grant);
    }
  };

  const finishAttempt = (record, state, failureCode = "") => {
    removeAttemptSecrets(record.attemptId);
    record.state = state;
    record.failureCode = failureCode || undefined;
    record.retireAt = now() + bootstrapTtlMs;
  };

  const refreshAttemptExpiry = (record) => {
    if (!record) return null;
    if (
      ["TOKEN_ISSUED", "GRANT_ISSUED"].includes(record.state)
      && record.expiresAt < now()
    ) {
      finishAttempt(record, "EXPIRED", "BOOTSTRAP_EXPIRED");
    }
    return record;
  };
  const httpServer = createServer(async (request, response) => {
    const requestUrl = new URL(request.url, `http://${config.host}:${config.port}`);
    if (requestUrl.pathname === "/fixture" && request.method === "GET") {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(`<!doctype html>
<meta charset="utf-8">
<title>Agent OS Chrome CDP Fixture</title>
<button id="clicker">Click me</button>
<input id="text" aria-label="Fixture text">
<input id="file" type="file">
<output id="result">ready</output>
<script>
clicker.addEventListener("click", () => result.textContent = "clicked");
text.addEventListener("input", () => result.dataset.text = text.value);
file.addEventListener("change", () => {
  const item = file.files[0];
  result.dataset.file = item ? item.name + ":" + item.size : "none";
});
</script>`);
      return;
    }
    if (requestUrl.pathname === "/bootstrap" && request.method === "POST") {
      let token = "";
      try {
        token = (await readBoundedBody(request, 128)).trim();
      } catch {
        response.writeHead(413, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ ok: false, error: "invalid bootstrap request" }));
        return;
      }
      const attemptId = bootstrapTokens.get(token);
      const record = refreshAttemptExpiry(bootstrapAttempts.get(attemptId));
      if (!record || record.state !== "TOKEN_ISSUED") {
        if (attemptId) bootstrapTokens.delete(token);
        response.writeHead(403, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ ok: false, error: "invalid or expired bootstrap token" }));
        return;
      }
      const expectedOrigin = `chrome-extension://${record.extensionId}`;
      if (request.headers.origin !== expectedOrigin) {
        response.writeHead(403, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ ok: false, error: "bootstrap origin mismatch" }));
        return;
      }
      bootstrapTokens.delete(token);
      const registrationGrant = randomBytes(32).toString("base64url");
      bootstrapRegistrationGrants.set(registrationGrant, record.attemptId);
      record.state = "GRANT_ISSUED";
      record.expiresAt = now() + bootstrapTtlMs;
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "access-control-allow-origin": expectedOrigin,
        "vary": "origin",
        "cache-control": "no-store"
      });
      response.end(JSON.stringify({
        ok: true,
        attemptId: record.attemptId,
        registrationGrant,
        profileName: record.profileName,
        bridgeUrl: `ws://${config.host}:${config.port}/extension`,
        secret: config.secret
      }));
      return;
    }
    const authorization = request.headers.authorization || "";
    if (!sameSecret(authorization.replace(/^Bearer\s+/i, ""), config.secret)) {
      response.writeHead(403, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return;
    }
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ ok: true, profiles: router.list() }));
      return;
    }
    if (requestUrl.pathname === "/bootstrap-token" && request.method === "POST") {
      try {
        const body = await readBoundedBody(request, 4096);
        const parsed = JSON.parse(body);
        const profileName = String(parsed.profileName || "").trim();
        const extensionId = String(parsed.extensionId || "").trim();
        const buildId = String(parsed.buildId || "").trim();
        const profileDirectory = String(parsed.profileDirectory || "").trim();
        if (!profileName || profileName.length > 256) throw new Error("profileName is invalid");
        if (!CHROME_EXTENSION_ID.test(extensionId)) throw new Error("extensionId is invalid");
        if (!buildId || buildId.length > 128) throw new Error("buildId is invalid");
        if (!safeProfileDirectory(profileDirectory)) throw new Error("profileDirectory is invalid");
        const attemptId = randomUUID();
        const token = randomBytes(32).toString("base64url");
        bootstrapAttempts.set(attemptId, {
          attemptId,
          profileName,
          extensionId,
          buildId,
          profileDirectory,
          bindingVerified: false,
          verifiedProfileDirectory: null,
          state: "TOKEN_ISSUED",
          createdAt: now(),
          expiresAt: now() + bootstrapTtlMs
        });
        bootstrapTokens.set(token, attemptId);
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ ok: true, attemptId, token }));
      } catch (error) {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }
    if (requestUrl.pathname === "/bootstrap-status" && request.method === "POST") {
      try {
        const body = await readBoundedBody(request, 1024);
        const attemptId = String(JSON.parse(body).attemptId || "").trim();
        const record = refreshAttemptExpiry(bootstrapAttempts.get(attemptId));
        if (!record) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: false, error: "bootstrap attempt is unavailable" }));
          return;
        }
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ ok: true, receipt: publicBootstrapReceipt(record) }));
      } catch {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: "invalid bootstrap status request" }));
      }
      return;
    }
    if (requestUrl.pathname === "/bootstrap-cancel" && request.method === "POST") {
      try {
        const body = await readBoundedBody(request, 1024);
        const attemptId = String(JSON.parse(body).attemptId || "").trim();
        const record = refreshAttemptExpiry(bootstrapAttempts.get(attemptId));
        if (!record) {
          response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: false, error: "bootstrap attempt is unavailable" }));
          return;
        }
        if (!["TOKEN_ISSUED", "GRANT_ISSUED"].includes(record.state)) {
          response.writeHead(409, { "content-type": "application/json; charset=utf-8" });
          response.end(JSON.stringify({ ok: false, error: "bootstrap attempt cannot be cancelled" }));
          return;
        }
        finishAttempt(record, "CANCELLED", "BOOTSTRAP_CANCELLED");
        response.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ ok: true, receipt: publicBootstrapReceipt(record) }));
      } catch {
        response.writeHead(400, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: "invalid bootstrap cancel request" }));
      }
      return;
    }
    if (request.url === "/command" && request.method === "POST") {
      try {
        const body = await readBoundedBody(request, 4 * 1024 * 1024);
        const { profileName, method, params, timeoutMs } = JSON.parse(body);
        const result = await router.request(profileName, method, params || {}, timeoutMs);
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: true, result }));
      } catch (error) {
        response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({ ok: false, error: error?.message || String(error) }));
      }
      return;
    }
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url, `http://${config.host}:${config.port}`);
    if (url.pathname !== "/extension" || !sameSecret(url.searchParams.get("secret"), config.secret)) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      const registrationTimer = setTimeout(() => ws.close(1008, "registration timeout"), 5000);
      ws.once("message", (bytes) => {
        clearTimeout(registrationTimer);
        let registration;
        try { registration = JSON.parse(bytes.toString()); } catch { ws.close(1008, "invalid registration"); return; }
        if (registration.kind !== "register") { ws.close(1008, "registration required"); return; }
        const profileName = String(registration.profileName || "").trim();
        const registrationGrant = String(registration.registrationGrant || "");
        let bootstrapAttempt;
        if (registrationGrant) {
          const attemptId = bootstrapRegistrationGrants.get(registrationGrant);
          bootstrapRegistrationGrants.delete(registrationGrant);
          bootstrapAttempt = refreshAttemptExpiry(bootstrapAttempts.get(attemptId));
          if (!bootstrapAttempt || bootstrapAttempt.state !== "GRANT_ISSUED") {
            ws.close(1008, "bootstrap registration grant is invalid or expired");
            return;
          }
          bootstrapAttempt.state = "REGISTERING";
          if (
            registration.attemptId !== bootstrapAttempt.attemptId
            || profileName !== bootstrapAttempt.profileName
            || registration.extensionId !== bootstrapAttempt.extensionId
            || registration.buildId !== bootstrapAttempt.buildId
          ) {
            finishAttempt(bootstrapAttempt, "REJECTED", "BOOTSTRAP_BINDING_MISMATCH");
            ws.close(1008, "bootstrap registration binding mismatch");
            return;
          }
        } else {
          const pendingForProfile = [...bootstrapAttempts.values()].find((record) =>
            record.profileName === profileName
            && ["TOKEN_ISSUED", "GRANT_ISSUED", "REGISTERING"].includes(record.state)
            && record.expiresAt >= now()
          );
          if (registration.attemptId || pendingForProfile) {
            ws.close(1008, "bootstrap registration grant is required");
            return;
          }
        }
        try {
          const profile = router.register(
            ws,
            registration,
            bootstrapAttempt
              ? {
                  bindingVerified: true,
                  verifiedProfileDirectory: bootstrapAttempt.profileDirectory
                }
              : {}
          );
          if (bootstrapAttempt) {
            for (const candidate of bootstrapAttempts.values()) {
              if (
                candidate !== bootstrapAttempt
                && candidate.profileName === bootstrapAttempt.profileName
                && ["TOKEN_ISSUED", "GRANT_ISSUED", "REGISTERING"].includes(candidate.state)
              ) {
                finishAttempt(candidate, "FAILED", "BOOTSTRAP_SUPERSEDED");
              }
            }
            bootstrapAttempt.state = "REGISTERED";
            bootstrapAttempt.bindingVerified = true;
            bootstrapAttempt.verifiedProfileDirectory = bootstrapAttempt.profileDirectory;
            bootstrapAttempt.registeredAt = new Date(now()).toISOString();
            bootstrapAttempt.retireAt = now() + bootstrapTtlMs;
          }
          ws.send(JSON.stringify({
            kind: "registered",
            profileName: profile.profileName,
            extensionId: profile.extensionId,
            buildId: profile.buildId,
            bindingVerified: profile.bindingVerified,
            verifiedProfileDirectory: profile.verifiedProfileDirectory,
            ...(bootstrapAttempt ? { attemptId: bootstrapAttempt.attemptId } : {})
          }));
        } catch (error) {
          if (bootstrapAttempt) {
            finishAttempt(bootstrapAttempt, "FAILED", "BOOTSTRAP_ROUTER_REJECTED");
          }
          ws.close(1008, error.message);
        }
      });
    });
  });
  const heartbeat = setInterval(() => {
    const timestamp = now();
    for (const [token, record] of bootstrapTokens) {
      const attempt = bootstrapAttempts.get(record);
      if (!attempt || attempt.expiresAt < timestamp) bootstrapTokens.delete(token);
    }
    for (const [grant, attemptId] of bootstrapRegistrationGrants) {
      const attempt = bootstrapAttempts.get(attemptId);
      if (!attempt || attempt.expiresAt < timestamp) bootstrapRegistrationGrants.delete(grant);
    }
    for (const [attemptId, record] of bootstrapAttempts) {
      refreshAttemptExpiry(record);
      if (record.retireAt && record.retireAt < timestamp) bootstrapAttempts.delete(attemptId);
    }
    for (const profile of router.profiles.values()) {
      if (timestamp - profile.lastSeenAt > 45000) {
        profile.socket.terminate();
      } else {
        profile.socket.send(JSON.stringify({ kind: "ping", at: Date.now() }));
      }
    }
  }, 15000);
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, config.host, resolve);
  });
  return {
    config,
    router,
    httpServer,
    close: async () => {
      clearInterval(heartbeat);
      bootstrapTokens.clear();
      bootstrapRegistrationGrants.clear();
      bootstrapAttempts.clear();
      for (const profile of router.profiles.values()) profile.socket.close(1001, "bridge shutdown");
      await new Promise((resolve) => httpServer.close(resolve));
      wss.close();
    }
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname || process.argv[1]?.replaceAll("\\", "/") === new URL(import.meta.url).pathname.slice(1)) {
  const bridge = await startBridge();
  process.stderr.write(`Agent OS Chrome CDP bridge listening on ${bridge.config.host}:${bridge.config.port}\n`);
}
