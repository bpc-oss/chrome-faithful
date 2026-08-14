import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BridgeClient } from "../src/bridge-client.mjs";
import { loadConfig } from "../src/config.mjs";
import { createAgent } from "../src/agent-browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixtureUrl = process.env.AGENTOS_PARITY_FIXTURE || "http://127.0.0.1:18991/index.html";
const outputPath = process.env.AGENTOS_PARITY_REPORT ||
  path.join(root, "reports", "parity", "live-acceptance-0.3.0.json");
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
const chooserFile = path.join(root, "test", "fixtures", "browser-parity", "download.txt");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function sourceEvidence() {
  const files = [
    "src/agent-browser.mjs",
    "src/extension-runtime/entry.mjs",
    "extension/generated/puppeteer-runtime.js",
    "extension/manifest.json",
    "src/mcp-server.mjs",
    "src/chrome-profile-launcher.mjs",
    "src/resilient-bridge.mjs"
  ];
  return Object.fromEntries(await Promise.all(files.map(async (name) => [
    name,
    sha256(await readFile(path.join(root, name)))
  ])));
}

async function runProfile(agent, router, profileName) {
  const browser = await agent.browsers.get(`extension:${profileName}`);
  const tab = await browser.tabs.new();
  const rows = [];
  const record = async (name, operation) => {
    const startedAt = new Date().toISOString();
    process.stderr.write(`[${profileName}] ${name} ...\n`);
    try {
      const value = await operation();
      rows.push({ name, status: "pass", startedAt, finishedAt: new Date().toISOString(), value });
      process.stderr.write(`[${profileName}] ${name} PASS\n`);
      return value;
    } catch (error) {
      rows.push({ name, status: "fail", startedAt, finishedAt: new Date().toISOString(), error: error?.message || String(error) });
      process.stderr.write(`[${profileName}] ${name} FAIL: ${error?.message || error}\n`);
      throw error;
    }
  };

  try {
    await record("navigate-fixture", async () => {
      await tab.goto(fixtureUrl);
      return { url: await tab.url(), title: await tab.title() };
    });
    await record("selftest", () => router.request(profileName, "selftest", { tabId: tab.id }));
    await record("puppeteer-session", () => tab.transport.session(tab.id, "info", {}));
    await record("locator-read-write", async () => {
      const input = tab.playwright.getByTestId("fixture-input");
      await input.fill(`${profileName}-fixture`);
      const value = await input.evaluate((element) => element.value);
      await tab.playwright.getByRole("button", { name: "Save fixture", exact: true }).filter({ visible: true }).click();
      const clicks = await tab.playwright.evaluate(() => window.fixtureClicks);
      if (value !== `${profileName}-fixture` || clicks !== 1) throw new Error("Locator fill/click roundtrip did not match");
      return { value, clicks };
    });
    await record("locator-state", async () => {
      await tab.playwright.locator("#check").setChecked(true);
      await tab.playwright.locator("#choice").selectOption("b");
      const state = await tab.playwright.evaluate(() => ({
        checked: document.querySelector("#check").checked,
        selected: document.querySelector("#choice").value
      }));
      if (!state.checked || state.selected !== "b") throw new Error("Checkbox/select state did not match");
      return state;
    });
    await record("frame-locator", async () => {
      const locator = tab.playwright.frameLocator("#fixture-frame").getByTestId("frame-button");
      await locator.click();
      const text = await locator.innerText();
      if (text !== "Frame action") throw new Error("Frame locator text did not match");
      return text;
    });
    await record("dom-cua", async () => {
      const visible = await tab.dom_cua.get_visible_dom();
      const save = visible.find((node) => node.name.includes("Save"));
      if (!save) throw new Error("DOM CUA did not expose the save button");
      await tab.dom_cua.click({ node_id: save.node_id });
      return { nodeCount: visible.length, clickedNode: save.node_id };
    });
    await record("element-info", async () => {
      const info = await tab.playwright.elementInfo({ x: 40, y: 40, includeNonInteractable: true });
      if (!info.length) throw new Error("Element info returned no matching nodes");
      return { elementCount: info.length };
    });
    await record("element-screenshot", async () => {
      const image = await tab.playwright.elementScreenshot({ x: 40, y: 40, includeNonInteractable: true });
      return { screenshotBytes: image.length, screenshotSha256: sha256(image) };
    });
    await record("dialog-event", async () => {
      const pending = tab.transport.session(tab.id, "waitForEvent", { name: "dialog", afterSequence: 0, timeoutMs: 5000 });
      const click = tab.playwright.locator("#prompt").click();
      const event = await pending;
      await tab.transport.session(tab.id, "dialogAct", { resourceId: event.resourceId, action: "accept", text: profileName });
      await click;
      return { type: event.payload.type, resourceId: event.resourceId };
    });
    await record("filechooser-event", async () => {
      const pending = tab.transport.session(tab.id, "waitForEvent", { name: "filechooser", afterSequence: 0, timeoutMs: 5000 });
      await tab.playwright.locator("#files").click();
      const event = await pending;
      await tab.transport.session(tab.id, "fileChooserSetFiles", { resourceId: event.resourceId, files: [chooserFile], timeoutMs: 5000 });
      return tab.playwright.evaluate(() => ({
        count: document.querySelector("#files").files.length,
        name: document.querySelector("#files").files[0]?.name
      })).then((value) => {
        if (value.count !== 1 || value.name !== "download.txt") throw new Error("File chooser did not receive the expected file");
        return value;
      });
    });
    await record("download-event", async () => {
      const pending = tab.transport.session(tab.id, "waitForEvent", { name: "download", afterSequence: 0, timeoutMs: 10000 });
      await tab.playwright.locator("#download").click();
      const event = await pending;
      const result = await tab.transport.session(tab.id, "downloadPath", { resourceId: event.resourceId, timeoutMs: 10000 });
      return { resourceId: event.resourceId, pathAvailable: typeof result.path === "string" && result.path.length > 0 };
    });
    await record("clipboard-roundtrip", async () => {
      const before = await tab.clipboard.readText().catch(() => "");
      const marker = `agentos-parity-${profileName}-${Date.now()}`;
      await tab.clipboard.writeText(marker);
      const actual = await tab.clipboard.readText();
      await tab.clipboard.writeText(before);
      if (actual !== marker) throw new Error("Clipboard roundtrip did not match");
      return { roundTrip: actual === marker, restored: true };
    });
    await record("console-logs", async () => {
      await tab.playwright.evaluate(() => console.info("agentos-parity-console"));
      const logs = await tab.dev.logs({ filter: "agentos-parity-console", levels: ["info"], limit: 10 });
      if (!logs.length || !logs.every((entry) => entry.level && entry.message && entry.timestamp)) throw new Error("Console logs were not normalized");
      return { count: logs.length, normalized: logs.every((entry) => entry.level && entry.message && entry.timestamp) };
    });
    await record("expect-navigation", async () => {
      await tab.playwright.expectNavigation(() => tab.playwright.locator("#navigate").click(), {
        url: "http://127.0.0.1:18991/next.html",
        waitUntil: "domcontentloaded",
        timeoutMs: 10000
      });
      const title = await tab.title();
      if (title !== "Parity next page") throw new Error("Navigation title did not match");
      await tab.back();
      await tab.waitForURL(fixtureUrl, { timeoutMs: 10000 });
      return { title };
    });
    await record("content-export", async () => {
      const exported = await tab.content.export();
      const temporary = await browser.tabs.content({ urls: [fixtureUrl], contentType: "text", timeoutMs: 10000 });
      if (!temporary[0]?.content?.includes("Browser parity fixture")) throw new Error("Temporary tab content extraction failed");
      return { exported, extracted: temporary[0]?.content?.includes("Browser parity fixture") === true };
    });
    return { profileName, tabId: tab.id, status: rows.every((row) => row.status === "pass") ? "pass" : "fail", rows };
  } finally {
    await tab.close().catch(() => {});
  }
}

const config = await loadConfig();
const implementationVersion = JSON.parse(
  await readFile(path.join(root, ".codex-plugin", "plugin.json"), "utf8")
).version;
const router = new BridgeClient(config);
await router.health();
const agent = createAgent(router);
const registrations = await router.list();
const exact = registrations.filter((entry) => expectedProfiles.includes(entry.profileName));
if (exact.length !== 2 || !expectedProfiles.every((name) => exact.some((entry) => entry.profileName === name && entry.version === "0.3.0"))) {
  throw new Error(`Expected exact 0.3.0 registrations for ${expectedProfiles.join(", ")}`);
}

const profiles = [];
for (const profileName of expectedProfiles) profiles.push(await runProfile(agent, router, profileName));
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  fixtureUrl,
  implementationVersion,
  baselineVersion: "26.721.41059",
  sourceSha256: await sourceEvidence(),
  registrations: exact.map(({ profileName, extensionId, version, capabilities }) => ({ profileName, extensionId, version, capabilities })),
  profiles,
  status: profiles.every((profile) => profile.status === "pass") ? "pass" : "fail"
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({ status: report.status, outputPath, profiles: profiles.map((profile) => ({ profileName: profile.profileName, status: profile.status, checks: profile.rows.length })) }, null, 2)}\n`);
if (report.status !== "pass") process.exitCode = 1;
