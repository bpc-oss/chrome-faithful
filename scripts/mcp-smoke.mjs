import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { defaultConfigPath } from "../src/config.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expectedProfiles = JSON.parse(process.env.AGENTOS_ACCEPTANCE_PROFILES || "[]");
if (
  !Array.isArray(expectedProfiles)
  || expectedProfiles.length < 1
  || expectedProfiles.some((name) => typeof name !== "string" || !name.trim())
) {
  throw new Error(
    "AGENTOS_ACCEPTANCE_PROFILES must be a JSON array of exact profile names"
  );
}
const targetProfile = expectedProfiles[0];
const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agentos-chrome-cdp-smoke-"));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src", "mcp-server.mjs")],
  env: {
    ...process.env,
    AGENTOS_CHROME_CONFIG: process.env.AGENTOS_CHROME_CONFIG || defaultConfigPath()
  },
  stderr: "pipe"
});
const client = new Client({ name: "agentos-chrome-cdp-smoke", version: "1.0.0" });

function text(result) {
  const block = result.content?.find((entry) => entry.type === "text");
  if (!block) throw new Error("MCP result has no text block");
  return JSON.parse(block.text);
}

await client.connect(transport);
let tabId;
let previousClipboard = "";
let clipboardCaptured = false;
try {
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name).sort();
  for (const expected of [
    "chrome_cdp", "chrome_clipboard", "chrome_cua", "chrome_file_inject",
    "chrome_history", "chrome_locator", "chrome_profile_catalog",
    "chrome_profile_start", "chrome_profiles", "chrome_screenshot",
    "chrome_selftest", "chrome_tabs"
  ]) assert(names.includes(expected), `missing MCP tool ${expected}`);

  const profiles = text(await client.callTool({ name: "chrome_profiles", arguments: {} }));
  const connectedNames = profiles.map((profile) => profile.metadata.profileName);
  assert(expectedProfiles.every((name) => connectedNames.includes(name)));

  const created = text(await client.callTool({
    name: "chrome_tabs",
    arguments: {
      profileName: targetProfile,
      action: "new",
      url: "http://127.0.0.1:18755/fixture"
    }
  }));
  tabId = created.id;
  const selftest = text(await client.callTool({
    name: "chrome_selftest",
    arguments: { profileName: targetProfile, tabId }
  }));
  assert(selftest.tabCount > 0);

  const evaluation = text(await client.callTool({
    name: "chrome_cdp",
    arguments: {
      profileName: targetProfile,
      tabId,
      action: "send",
      method: "Runtime.evaluate",
      params: { expression: "document.title", returnByValue: true }
    }
  }));
  assert.equal(evaluation.result.value, "Agent OS Chrome CDP Fixture");

  const count = text(await client.callTool({
    name: "chrome_locator",
    arguments: {
      profileName: targetProfile,
      tabId,
      selector: "#file",
      action: "count"
    }
  }));
  assert.equal(count, 1);

  const secondInputId = text(await client.callTool({
    name: "chrome_locator",
    arguments: {
      profileName: targetProfile,
      tabId,
      selector: "input",
      index: 1,
      action: "getAttribute",
      value: "id"
    }
  }));
  assert.equal(secondInputId, "file");

  const injected = text(await client.callTool({
    name: "chrome_file_inject",
    arguments: {
      profileName: targetProfile,
      tabId,
      inputSelector: "#file",
      filePaths: [path.join(root, "test", "fixtures", "upload.txt")]
    }
  }));
  assert.deepEqual(injected.names, ["upload.txt"]);

  const screenshot = await client.callTool({
    name: "chrome_screenshot",
    arguments: {
      profileName: targetProfile,
      tabId,
      savePath: path.join(tmpDir, "mcp-screenshot.png")
    }
  });
  assert(screenshot.content?.some((entry) => entry.type === "image" && entry.mimeType === "image/png"));
  const screenshotMeta = text(screenshot);
  assert.equal(screenshotMeta.savedPath, path.join(tmpDir, "mcp-screenshot.png"));
  assert(screenshotMeta.bytes > 100);
  assert((await fs.stat(screenshotMeta.savedPath)).size === screenshotMeta.bytes);

  previousClipboard = text(await client.callTool({
    name: "chrome_clipboard",
    arguments: { profileName: targetProfile, action: "read" }
  })).result.value;
  clipboardCaptured = true;
  await client.callTool({
    name: "chrome_clipboard",
    arguments: { profileName: targetProfile, action: "write", text: "agentos-mcp-smoke" }
  });
  const clipboard = text(await client.callTool({
    name: "chrome_clipboard",
    arguments: { profileName: targetProfile, action: "read" }
  }));
  assert.equal(clipboard.result.value, "agentos-mcp-smoke");

  process.stdout.write(JSON.stringify({
    ok: true,
    toolCount: names.length,
    profiles: profiles.map((profile) => profile.metadata.profileName).sort(),
    selftestTabCount: selftest.tabCount,
    locatorNth: true,
    screenshot: true,
    fileInjection: true,
    clipboard: true
  }) + "\n");
} finally {
  if (clipboardCaptured) {
    await client.callTool({
      name: "chrome_clipboard",
      arguments: { profileName: targetProfile, action: "write", text: previousClipboard }
    }).catch(() => {});
  }
  if (tabId) {
    await client.callTool({
      name: "chrome_tabs",
      arguments: { profileName: targetProfile, action: "close", tabId }
    }).catch(() => {});
  }
  await fs.rm(tmpDir, { recursive: true, force: true });
  await client.close();
}
