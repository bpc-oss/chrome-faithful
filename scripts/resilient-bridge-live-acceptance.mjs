import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultConfigPath } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const profileNames = String(process.env.AGENTOS_CHROME_ACCEPTANCE_PROFILES || "")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);
assert(profileNames.length > 0, "AGENTOS_CHROME_ACCEPTANCE_PROFILES is required");
const log = (message) => process.stderr.write(`[bridge-acceptance] ${message}\n`);

function createClient(name) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, "src", "mcp-server.mjs")],
    env: {
      ...process.env,
      AGENTOS_CHROME_CONFIG:
        process.env.AGENTOS_CHROME_CONFIG || defaultConfigPath()
    },
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

async function waitForProfiles(client, expected, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let profiles = [];
  while (Date.now() < deadline) {
    profiles = await call(client, "chrome_profiles");
    const names = new Set(profiles.map((profile) => profile.metadata.profileName));
    if (expected.every((name) => names.has(name))) return profiles;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Profiles did not reconnect after bridge failover: ${expected.join(", ")}; `
    + `observed=${profiles.map((profile) => profile.metadata.profileName).join(", ")}`
  );
}

async function selftestProfiles(client, expected, tabByProfile) {
  const results = [];
  for (const profileName of expected) {
    const tabId = tabByProfile.get(profileName);
    log(`running selftest for ${profileName} tab ${tabId}`);
    const result = await call(client, "chrome_selftest", {
      profileName,
      tabId
    });
    log(`selftest passed for ${profileName}`);
    assert(result.tabCount > 0, `Selftest failed for ${profileName}`);
    results.push({ profileName, tabId: String(tabId), tabCount: result.tabCount });
  }
  return results;
}

const owner = createClient("agentos-bridge-owner-acceptance");
const survivor = createClient("agentos-bridge-survivor-acceptance");
const launchedProfiles = [];
const fixtureTabs = new Map();

await owner.client.connect(owner.transport);
try {
  log("owner connected");
  await survivor.client.connect(survivor.transport);
  try {
    log("survivor connected");
    for (const profileName of profileNames) {
      log(`starting profile ${profileName}`);
      const result = await call(owner.client, "chrome_profile_start", {
        profileName,
        timeoutMs: 30000
      });
      log(`profile ${profileName} ready; alreadyConnected=${result.alreadyConnected}`);
      if (!result.alreadyConnected) launchedProfiles.push(profileName);
    }
    log("waiting for profiles before failover");
    const profiles = await waitForProfiles(owner.client, profileNames);
    for (const profileName of profileNames) {
      log(`creating fixture tab for ${profileName}`);
      const tab = await call(survivor.client, "chrome_tabs", {
        profileName,
        action: "new",
        url: "http://127.0.0.1:18755/fixture"
      });
      fixtureTabs.set(profileName, tab.id);
    }
    log("running selftests through first client");
    const firstClientSelftests = await selftestProfiles(owner.client, profileNames, fixtureTabs);
    log("running selftests through second client");
    const secondClientSelftests = await selftestProfiles(
      survivor.client,
      profileNames,
      fixtureTabs
    );

    process.stdout.write(JSON.stringify({
      ok: true,
      expectedProfiles: profileNames,
      profiles: profiles.map((profile) => profile.metadata.profileName).sort(),
      firstClientSelftests,
      secondClientSelftests,
      launchedProfiles,
      fixtureTabsClosed: true,
      twoClients: true
    }) + "\n");
  } finally {
    for (const [profileName, tabId] of fixtureTabs) {
      await call(survivor.client, "chrome_tabs", {
        profileName,
        action: "close",
        tabId
      }).catch(() => {});
    }
    await survivor.client.close().catch(() => {});
  }
} finally {
  await owner.client.close().catch(() => {});
}
