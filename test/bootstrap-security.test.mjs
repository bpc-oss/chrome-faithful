import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { WebSocket } from "ws";
import { BridgeClient } from "../src/bridge-client.mjs";
import { startBridge } from "../src/bridge-server.mjs";

const extensionId = "abcdefghijklmnopabcdefghijklmnop";
const otherExtensionId = "ponmlkjihgfedcbaponmlkjihgfedcba";
const buildId = "test-build";
const profileDirectory = "Profile 1";

async function reservePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("bridge client enforces a hard total deadline for hanging and continuously streaming responses", async () => {
  const port = await reservePort();
  const server = createHttpServer((request, response) => {
    if (request.url === "/drip") {
      response.writeHead(200, { "content-type": "application/json" });
      const timer = setInterval(() => response.write(" "), 5);
      response.on("close", () => clearInterval(timer));
      return;
    }
    request.on("close", () => response.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  try {
    const client = new BridgeClient({
      host: "127.0.0.1",
      port,
      secret: Buffer.alloc(32, 14).toString("base64"),
      commandTimeoutMs: 1000
    });
    const dripStartedAt = Date.now();
    await assert.rejects(
      () => client.http("/drip", { timeoutMs: 40 }),
      /total deadline expired/
    );
    assert.ok(Date.now() - dripStartedAt < 500);
    const hangStartedAt = Date.now();
    await assert.rejects(
      () => client.http("/hang", { timeoutMs: 30 }),
      /(?:timed out|total deadline expired)/
    );
    assert.ok(Date.now() - hangStartedAt < 500);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

function consumeBootstrap(config, token, origin) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: config.host,
      port: config.port,
      path: "/bootstrap",
      method: "POST",
      headers: {
        origin,
        "content-type": "text/plain;charset=UTF-8",
        "content-length": Buffer.byteLength(token)
      }
    }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        payload: JSON.parse(body)
      }));
    });
    request.on("error", reject);
    request.end(token);
  });
}

function register(config, metadata) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(
      `ws://${config.host}:${config.port}/extension?secret=${encodeURIComponent(config.secret)}`
    );
    socket.once("error", reject);
    socket.once("open", () => socket.send(JSON.stringify({ kind: "register", ...metadata })));
    socket.once("message", (data) => resolve({ socket, message: JSON.parse(data.toString()) }));
    socket.once("close", (code, reason) => resolve({ socket, close: { code, reason: reason.toString() } }));
  });
}

test("bootstrap is authenticated, extension-origin-bound, one-use, and expiry-bounded", async () => {
  const config = {
    host: "127.0.0.1",
    port: await reservePort(),
    secret: Buffer.alloc(32, 7).toString("base64"),
    commandTimeoutMs: 1000
  };
  let now = 1000;
  const bridge = await startBridge(config, { now: () => now, bootstrapTtlMs: 1000 });
  try {
    const badClient = new BridgeClient({ ...config, secret: Buffer.alloc(32, 8).toString("base64") });
    await assert.rejects(
      () => badClient.issueBootstrapToken({ profileName: "Profile A", extensionId, buildId, profileDirectory }),
      /forbidden/
    );

    const client = new BridgeClient(config);
    await assert.rejects(
      () => client.issueBootstrapToken({ profileName: "Profile A", extensionId, profileDirectory }),
      /buildId is invalid/
    );
    await assert.rejects(
      () => client.issueBootstrapToken({ profileName: "Profile A", extensionId, buildId }),
      /profileDirectory is invalid/
    );
    const issued = await client.issueBootstrapToken({ profileName: "Profile A", extensionId, buildId, profileDirectory });
    assert.match(issued.attemptId, /^[0-9a-f-]{36}$/i);
    assert.match(issued.token, /^[A-Za-z0-9_-]{43}$/);
    const wrongOrigin = await consumeBootstrap(config, issued.token, `chrome-extension://${otherExtensionId}`);
    assert.equal(wrongOrigin.status, 403);

    const accepted = await consumeBootstrap(config, issued.token, `chrome-extension://${extensionId}`);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers["access-control-allow-origin"], `chrome-extension://${extensionId}`);
    assert.equal(accepted.payload.profileName, "Profile A");
    assert.equal(accepted.payload.secret, config.secret);
    assert.equal(accepted.payload.attemptId, issued.attemptId);
    assert.match(accepted.payload.registrationGrant, /^[A-Za-z0-9_-]{43}$/);
    assert.equal((await client.bootstrapStatus(issued.attemptId)).state, "GRANT_ISSUED");
    await assert.rejects(() => badClient.bootstrapStatus(issued.attemptId), /forbidden/);

    const replay = await consumeBootstrap(config, issued.token, `chrome-extension://${extensionId}`);
    assert.equal(replay.status, 403);

    const expiring = await client.issueBootstrapToken({ profileName: "Profile B", extensionId, buildId, profileDirectory });
    now += 1001;
    const expired = await consumeBootstrap(config, expiring.token, `chrome-extension://${extensionId}`);
    assert.equal(expired.status, 403);
    assert.equal((await client.bootstrapStatus(expiring.attemptId)).state, "EXPIRED");

    const cancellable = await client.issueBootstrapToken({ profileName: "Profile C", extensionId, buildId, profileDirectory });
    assert.equal((await client.cancelBootstrap(cancellable.attemptId)).state, "CANCELLED");
    assert.equal(
      (await consumeBootstrap(config, cancellable.token, `chrome-extension://${extensionId}`)).status,
      403
    );
  } finally {
    await bridge.close();
  }
});

test("bootstrap registration rejects the wrong extension ID and accepts the exact binding", async () => {
  const config = {
    host: "127.0.0.1",
    port: await reservePort(),
    secret: Buffer.alloc(32, 9).toString("base64"),
    commandTimeoutMs: 1000
  };
  const bridge = await startBridge(config);
  let acceptedSocket;
  try {
    const client = new BridgeClient(config);
    const rejectedIssue = await client.issueBootstrapToken({ profileName: "Profile A", extensionId, buildId, profileDirectory });
    const rejectedBootstrap = await consumeBootstrap(
      config,
      rejectedIssue.token,
      `chrome-extension://${extensionId}`
    );
    assert.equal(rejectedBootstrap.status, 200);

    const rejected = await register(config, {
      profileName: "Wrong Profile",
      extensionId: otherExtensionId,
      buildId,
      attemptId: rejectedIssue.attemptId,
      registrationGrant: rejectedBootstrap.payload.registrationGrant,
      version: "test"
    });
    assert.equal(rejected.close.code, 1008);
    assert.match(rejected.close.reason, /binding mismatch/);
    assert.equal((await client.bootstrapStatus(rejectedIssue.attemptId)).state, "REJECTED");

    const rejectedBuildIssue = await client.issueBootstrapToken({ profileName: "Profile A", extensionId, buildId, profileDirectory });
    const rejectedBuildBootstrap = await consumeBootstrap(
      config,
      rejectedBuildIssue.token,
      `chrome-extension://${extensionId}`
    );
    const rejectedBuild = await register(config, {
      profileName: "Profile A",
      extensionId,
      buildId: "other-build",
      attemptId: rejectedBuildIssue.attemptId,
      registrationGrant: rejectedBuildBootstrap.payload.registrationGrant,
      version: "test"
    });
    assert.equal(rejectedBuild.close.code, 1008);
    assert.match(rejectedBuild.close.reason, /binding mismatch/);
    assert.equal((await client.bootstrapStatus(rejectedBuildIssue.attemptId)).state, "REJECTED");

    const acceptedIssue = await client.issueBootstrapToken({ profileName: "Profile A", extensionId, buildId, profileDirectory });
    const acceptedBootstrap = await consumeBootstrap(
      config,
      acceptedIssue.token,
      `chrome-extension://${extensionId}`
    );

    const accepted = await register(config, {
      profileName: "Profile A",
      extensionId,
      buildId,
      attemptId: acceptedIssue.attemptId,
      registrationGrant: acceptedBootstrap.payload.registrationGrant,
      version: "test"
    });
    acceptedSocket = accepted.socket;
    assert.deepEqual(accepted.message, {
      kind: "registered",
      profileName: "Profile A",
      extensionId,
      buildId,
      bindingVerified: true,
      verifiedProfileDirectory: profileDirectory,
      attemptId: acceptedIssue.attemptId
    });
    const acceptedReceipt = await client.bootstrapStatus(acceptedIssue.attemptId);
    assert.equal(acceptedReceipt.state, "REGISTERED");
    assert.equal(acceptedReceipt.buildId, buildId);
    assert.equal(acceptedReceipt.bindingVerified, true);
    assert.equal(acceptedReceipt.verifiedProfileDirectory, profileDirectory);
    assert.deepEqual((await client.list()).map((profile) => ({
      profileName: profile.profileName,
      extensionId: profile.extensionId,
      buildId: profile.buildId,
      bindingVerified: profile.bindingVerified,
      verifiedProfileDirectory: profile.verifiedProfileDirectory
    })), [
      {
        profileName: "Profile A",
        extensionId,
        buildId,
        bindingVerified: true,
        verifiedProfileDirectory: profileDirectory
      }
    ]);
    assert.equal(
      JSON.stringify(await client.health()).includes(acceptedBootstrap.payload.registrationGrant),
      false
    );
    assert.equal(JSON.stringify(await client.health()).includes(config.secret), false);

    const replay = await register(config, {
      profileName: "Replay Profile",
      extensionId,
      buildId,
      attemptId: acceptedIssue.attemptId,
      registrationGrant: acceptedBootstrap.payload.registrationGrant,
      version: "test"
    });
    assert.equal(replay.close.code, 1008);
    assert.match(replay.close.reason, /invalid or expired/);

    await new Promise((resolve) => {
      acceptedSocket.once("close", resolve);
      acceptedSocket.close();
    });
    acceptedSocket = undefined;
    assert.equal((await client.bootstrapStatus(acceptedIssue.attemptId)).state, "REGISTERED");
    assert.deepEqual(await client.list(), []);
  } finally {
    if (acceptedSocket && acceptedSocket.readyState === acceptedSocket.OPEN) {
      await new Promise((resolve) => {
        acceptedSocket.once("close", resolve);
        acceptedSocket.close();
      });
    }
    await bridge.close();
  }
});

test("generic registration is explicitly unverified and has no verified directory", async () => {
  const config = {
    host: "127.0.0.1",
    port: await reservePort(),
    secret: Buffer.alloc(32, 12).toString("base64"),
    commandTimeoutMs: 1000
  };
  const bridge = await startBridge(config);
  let socket;
  try {
    const registered = await register(config, {
      profileName: "Generic Profile",
      extensionId,
      buildId,
      verifiedProfileDirectory: "must-not-be-trusted",
      bindingVerified: true,
      version: "test"
    });
    socket = registered.socket;
    assert.equal(registered.message.bindingVerified, false);
    assert.equal(registered.message.verifiedProfileDirectory, null);
    const [live] = await new BridgeClient(config).list();
    assert.equal(live.bindingVerified, false);
    assert.equal(live.verifiedProfileDirectory, null);
  } finally {
    if (socket && socket.readyState === socket.OPEN) {
      await new Promise((resolve) => {
        socket.once("close", resolve);
        socket.close();
      });
    }
    await bridge.close();
  }
});

test("verified bootstrap atomically supersedes a same-binding unverified live profile", async () => {
  const config = {
    host: "127.0.0.1",
    port: await reservePort(),
    secret: Buffer.alloc(32, 13).toString("base64"),
    commandTimeoutMs: 1000
  };
  const bridge = await startBridge(config);
  let exactSocket;
  try {
    const placeholder = await register(config, {
      profileName: "Alice",
      extensionId,
      buildId,
      version: "test"
    });
    const client = new BridgeClient(config);
    const issued = await client.issueBootstrapToken({
      profileName: "Alice",
      extensionId,
      buildId,
      profileDirectory: "Profile 3"
    });
    const bootstrap = await consumeBootstrap(
      config,
      issued.token,
      `chrome-extension://${extensionId}`
    );
    const exact = await register(config, {
      profileName: "Alice",
      extensionId,
      buildId,
      attemptId: issued.attemptId,
      registrationGrant: bootstrap.payload.registrationGrant,
      version: "test"
    });
    exactSocket = exact.socket;
    assert.equal(exact.message.bindingVerified, true);
    assert.equal(exact.message.verifiedProfileDirectory, "Profile 3");
    assert.notEqual(exact.socket, placeholder.socket);
    const [live] = await client.list();
    assert.equal(live.bindingVerified, true);
    assert.equal(live.verifiedProfileDirectory, "Profile 3");
    assert.equal((await client.bootstrapStatus(issued.attemptId)).bindingVerified, true);
  } finally {
    if (exactSocket && exactSocket.readyState === exactSocket.OPEN) {
      await new Promise((resolve) => {
        exactSocket.once("close", resolve);
        exactSocket.close();
      });
    }
    await bridge.close();
  }
});

test("an unconsumed bootstrap token blocks generic registration until its exact grant is used", async () => {
  const config = {
    host: "127.0.0.1",
    port: await reservePort(),
    secret: Buffer.alloc(32, 11).toString("base64"),
    commandTimeoutMs: 1000
  };
  const bridge = await startBridge(config);
  let acceptedSocket;
  try {
    const client = new BridgeClient(config);
    const issued = await client.issueBootstrapToken({
      profileName: "Profile Token Pending",
      extensionId,
      buildId,
      profileDirectory
    });
    const generic = await register(config, {
      profileName: "Profile Token Pending",
      extensionId,
      buildId,
      version: "test"
    });
    assert.equal(generic.close.code, 1008);
    assert.match(generic.close.reason, /grant is required/);
    assert.equal((await client.bootstrapStatus(issued.attemptId)).state, "TOKEN_ISSUED");

    const bootstrap = await consumeBootstrap(
      config,
      issued.token,
      `chrome-extension://${extensionId}`
    );
    assert.equal(bootstrap.status, 200);
    const accepted = await register(config, {
      profileName: "Profile Token Pending",
      extensionId,
      buildId,
      attemptId: issued.attemptId,
      registrationGrant: bootstrap.payload.registrationGrant,
      version: "test"
    });
    acceptedSocket = accepted.socket;
    assert.equal(accepted.message.kind, "registered");
    assert.equal(accepted.message.attemptId, issued.attemptId);
    assert.equal((await client.bootstrapStatus(issued.attemptId)).state, "REGISTERED");
  } finally {
    if (acceptedSocket && acceptedSocket.readyState === acceptedSocket.OPEN) {
      await new Promise((resolve) => {
        acceptedSocket.once("close", resolve);
        acceptedSocket.close();
      });
    }
    await bridge.close();
  }
});

test("pending bootstrap requires its grant and concurrent same-profile attempts cannot both win", async () => {
  const config = {
    host: "127.0.0.1",
    port: await reservePort(),
    secret: Buffer.alloc(32, 10).toString("base64"),
    commandTimeoutMs: 1000
  };
  const bridge = await startBridge(config);
  let winningSocket;
  try {
    const client = new BridgeClient(config);
    const missingGrantIssue = await client.issueBootstrapToken({ profileName: "Profile G", extensionId, buildId, profileDirectory });
    await consumeBootstrap(config, missingGrantIssue.token, `chrome-extension://${extensionId}`);
    const missingGrant = await register(config, {
      profileName: "Profile G",
      extensionId,
      buildId,
      version: "test"
    });
    assert.equal(missingGrant.close.code, 1008);
    assert.match(missingGrant.close.reason, /grant is required/);

    const firstIssue = await client.issueBootstrapToken({ profileName: "Profile H", extensionId, buildId, profileDirectory });
    const secondIssue = await client.issueBootstrapToken({ profileName: "Profile H", extensionId, buildId, profileDirectory });
    const firstBootstrap = await consumeBootstrap(
      config,
      firstIssue.token,
      `chrome-extension://${extensionId}`
    );
    const secondBootstrap = await consumeBootstrap(
      config,
      secondIssue.token,
      `chrome-extension://${extensionId}`
    );
    const first = await register(config, {
      profileName: "Profile H",
      extensionId,
      buildId,
      attemptId: firstIssue.attemptId,
      registrationGrant: firstBootstrap.payload.registrationGrant,
      version: "test",
      secret: "must-not-appear",
      arbitrary: "must-not-appear"
    });
    winningSocket = first.socket;
    assert.equal(first.message.kind, "registered");
    const second = await register(config, {
      profileName: "Profile H",
      extensionId,
      buildId,
      attemptId: secondIssue.attemptId,
      registrationGrant: secondBootstrap.payload.registrationGrant,
      version: "test"
    });
    assert.equal(second.close.code, 1008);
    assert.equal((await client.bootstrapStatus(firstIssue.attemptId)).state, "REGISTERED");
    assert.equal((await client.bootstrapStatus(secondIssue.attemptId)).state, "FAILED");
    const health = JSON.stringify(await client.health());
    assert.equal(health.includes("must-not-appear"), false);
  } finally {
    if (winningSocket?.readyState === winningSocket.OPEN) {
      await new Promise((resolve) => {
        winningSocket.once("close", resolve);
        winningSocket.close();
      });
    }
    await bridge.close();
  }
});

test("extension bootstrap clears the fragment, honors the configured port, and closes only its own tab", async () => {
  const source = await readFile(new URL("../extension/options.js", import.meta.url), "utf8");
  assert.match(source, /location\.hash/);
  assert.ok(source.indexOf("history.replaceState") < source.indexOf("fetch(`http://127.0.0.1:${bootstrapPort}/bootstrap`"));
  assert.match(source, /method: "POST"/);
  assert.match(source, /chrome\.storage\.session/);
  assert.match(source, /bootstrapRegistrationGrant/);
  assert.match(source, /bootstrapRegisteredAttemptId/);
  assert.match(source, /get\("reload"\) === "1"/);
  assert.match(source, /RELOAD_MARKER_MAX_AGE_MS = 60_000/);
  assert.match(source, /current\?\.id === markerTabId/);
  assert.ok(source.indexOf("history.replaceState") < source.indexOf("chrome.runtime.reload"));
  assert.match(source, /chrome\.tabs\.getCurrent/);
  assert.match(source, /chrome\.tabs\.remove/);
  assert.doesNotMatch(source, /get\("tabId"\)/);
  assert.doesNotMatch(source, /127\.0\.0\.1:18755\/bootstrap/);
});
