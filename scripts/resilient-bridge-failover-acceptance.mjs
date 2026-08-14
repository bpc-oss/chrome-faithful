import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import WebSocket from "ws";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-bridge-failover-"));
const profileName = "Acceptance Profile";
const tabId = "acceptance-tab";
const secret = crypto.randomBytes(24).toString("hex");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

const port = await availablePort();
const configPath = path.join(tmpDir, "local.json");
await fs.writeFile(configPath, JSON.stringify({
  host: "127.0.0.1",
  port,
  secret,
  commandTimeoutMs: 5000,
  bridgeElectionTimeoutMs: 3000,
  profileReconnectTimeoutMs: 5000
}), "utf8");

function createClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "mcp-server.mjs")],
    env: { ...process.env, AGENTOS_CHROME_CONFIG: configPath },
    stderr: "pipe"
  });
  return {
    client: new Client({ name, version: "1.0.0" }),
    transport
  };
}

function parseText(result) {
  const block = result.content?.find((entry) => entry.type === "text");
  if (!block) throw new Error("MCP result has no text block");
  return JSON.parse(block.text);
}

async function call(client, name, args = {}) {
  return parseText(await client.callTool({ name, arguments: args }));
}

let stopped = false;
let socket;
let reconnects = 0;
function connectFakeExtension() {
  if (stopped) return;
  socket = new WebSocket(`ws://127.0.0.1:${port}/extension?secret=${secret}`);
  socket.on("open", () => {
    reconnects += 1;
    socket.send(JSON.stringify({
      kind: "register",
      profileName,
      extensionId: "acceptance-extension",
      version: "acceptance"
    }));
  });
  socket.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    if (message.kind === "ping") {
      socket.send(JSON.stringify({ kind: "pong", at: Date.now() }));
      return;
    }
    if (message.kind !== "request") return;
    const result = message.method === "tabs.list"
      ? [{ id: tabId, title: "Acceptance", url: "about:blank", active: true }]
      : message.method === "selftest"
        ? { platform: { os: "win" }, tabCount: 1, cdp: { title: "Acceptance" } }
        : null;
    socket.send(JSON.stringify({
      kind: "response",
      id: message.id,
      ok: true,
      result
    }));
  });
  socket.on("close", () => {
    if (!stopped) setTimeout(connectFakeExtension, 50);
  });
  socket.on("error", () => socket.close());
}

async function waitForProfile(client, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let profiles = [];
  while (Date.now() < deadline) {
    profiles = await call(client, "chrome_profiles");
    if (profiles.some((profile) => profile.metadata.profileName === profileName)) {
      return profiles;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Fake extension did not register");
}

const owner = createClient("bridge-owner");
const survivor = createClient("bridge-survivor");
try {
  await owner.client.connect(owner.transport);
  connectFakeExtension();
  await waitForProfile(owner.client);
  await survivor.client.connect(survivor.transport);
  const before = await call(survivor.client, "chrome_selftest", {
    profileName,
    tabId
  });
  assert.equal(before.tabCount, 1);

  await owner.client.close();
  const afterProfiles = await waitForProfile(survivor.client);
  const after = await call(survivor.client, "chrome_selftest", {
    profileName,
    tabId
  });
  assert.equal(after.tabCount, 1);
  assert(reconnects >= 2, `Expected extension reconnect, observed ${reconnects}`);

  process.stdout.write(JSON.stringify({
    ok: true,
    port,
    profileName,
    reconnects,
    profilesAfterFailover: afterProfiles.map((profile) => profile.metadata.profileName),
    selftestBefore: before.tabCount,
    selftestAfter: after.tabCount
  }) + "\n");
} finally {
  stopped = true;
  socket?.close();
  await survivor.client.close().catch(() => {});
  await owner.client.close().catch(() => {});
  await fs.rm(tmpDir, { recursive: true, force: true });
}
