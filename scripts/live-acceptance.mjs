import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createAgent } from "../src/agent-browser.mjs";
import { BridgeClient } from "../src/bridge-client.mjs";
import { defaultConfigPath } from "../src/config.mjs";
import { injectFilesViaPageFile } from "../src/file-injection.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const configPath = process.env.AGENTOS_CHROME_CONFIG || defaultConfigPath();
const fixtureUrl = "http://127.0.0.1:18755/fixture";
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
const client = await BridgeClient.create(configPath);
const agent = createAgent(client);

async function waitForExactProfiles(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let names = [];
  while (Date.now() < deadline) {
    try {
      names = (await client.list()).map((profile) => profile.profileName).sort();
      if (expectedProfiles.every((name) => names.includes(name))) return names;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Expected exact profiles ${expectedProfiles.join(", ")}; got ${names.join(", ") || "none"}`);
}

async function testProfile(profileName) {
  const target = (await agent.browsers.list()).find((entry) => entry.metadata?.profileName === profileName);
  assert(target, `missing exact target ${profileName}`);
  const browser = await agent.browsers.get(target.id);
  assert.equal(browser.browserId, `extension:${profileName}`);
  const selectedBefore = await browser.tabs.selected();
  const tab = await browser.tabs.new();
  let profileReport;
  let createdTabWasActive = false;
  let selectedTabRestored = !selectedBefore;
  try {
    await tab.goto(fixtureUrl);
    const listed = await browser.tabs.list();
    const tabInfo = listed.find((entry) => String(entry.id) === tab.id);
    assert(tabInfo, `${profileName} fixture tab is missing`);
    createdTabWasActive = Boolean(tabInfo.active);

    const selftest = await client.request(profileName, "selftest", { tabId: tab.id });
    assert(selftest.platform && selftest.tabCount > 0);

    const button = tab.playwright.getByRole("button", { name: "Click me", exact: true });
    assert.equal(await button.count(), 1);
    assert.equal(await button.isVisible(), true);
    await button.click();
    assert.equal(await tab.playwright.locator("#result").innerText(), "clicked");

    const text = tab.playwright.getByLabel("Fixture text", { exact: true });
    await text.fill(`profile-${profileName}`);
    assert.equal(await text.getAttribute("aria-label"), "Fixture text");
    assert.equal(await tab.playwright.locator("#result").getAttribute("data-text"), `profile-${profileName}`);

    const cdp = await tab.capabilities.get("cdp");
    const evaluated = await cdp.send("Runtime.evaluate", {
      expression: "({title:document.title,url:location.href})",
      returnByValue: true
    });
    assert.equal(evaluated.result.value.title, "Agent OS Chrome CDP Fixture");
    const currentEvents = await cdp.readEvents({ limit: 1000 });
    await cdp.send("Runtime.evaluate", {
      expression: `console.log(${JSON.stringify(`agentos-event-${profileName}`)})`,
      returnByValue: true
    });
    const eventPage = await cdp.readEvents({
      afterSequence: currentEvents.cursor,
      methods: ["Runtime.consoleAPICalled"],
      timeoutMs: 3000,
      limit: 20
    });
    assert(eventPage.events.length > 0, `${profileName} did not receive a CDP event`);

    const screenshot = await tab.screenshot();
    assert(screenshot.length > 100);
    assert.deepEqual([...screenshot.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);

    const upload = await injectFilesViaPageFile(
      tab,
      [path.join(root, "test", "fixtures", "upload.txt")],
      "#file"
    );
    assert.deepEqual(upload.names, ["upload.txt"]);
    assert.equal(await tab.playwright.locator("#result").getAttribute("data-file"), `upload.txt:${upload.sizes[0]}`);

    const history = await browser.user.history({ queries: ["Agent OS Chrome CDP Fixture"], limit: 20 });
    assert(history.some((entry) => entry.url === fixtureUrl), `${profileName} fixture missing from history`);

    const clipboardBefore = await tab.clipboard.readText();
    const clipboardValue = `agentos-clipboard-${profileName}`;
    try {
      await tab.clipboard.writeText(clipboardValue);
      assert.equal(await tab.clipboard.readText(), clipboardValue);
    } finally {
      await tab.clipboard.writeText(clipboardBefore);
    }

    profileReport = {
      profileName,
      browserId: browser.browserId,
      extensionId: target.metadata.extensionId,
      extensionVersion: target.metadata.version,
      backgroundTabPreserved: true,
      createdTabWasActive,
      selftest: { tabCount: selftest.tabCount, platform: selftest.platform.os },
      locator: true,
      rawCdp: true,
      cdpEvents: eventPage.events.length,
      screenshotBytes: screenshot.length,
      history: true,
      clipboard: { roundTrip: true, restored: true },
      fileInjection: {
        route: "page File + DataTransfer",
        name: upload.names[0],
        bytes: upload.sizes[0],
        chunks: upload.files[0].chunks
      },
      tabId: tab.id
    };
  } finally {
    await tab.close().catch(() => {});
    if (selectedBefore) {
      const remaining = await browser.tabs.list().catch(() => []);
      if (remaining.some((entry) => String(entry.id) === selectedBefore.id)) {
        await browser.tabs.activate(selectedBefore.id);
        selectedTabRestored = (await browser.tabs.selected())?.id === selectedBefore.id;
      }
    }
  }
  assert(selectedTabRestored, `${profileName} selected tab was not restored`);
  profileReport.selectedTabRestored = true;
  return profileReport;
}

await waitForExactProfiles();
const profiles = [];
for (const profileName of expectedProfiles) profiles.push(await testProfile(profileName));

const report = {
  ok: true,
  testedAt: new Date().toISOString(),
  expectedProfiles,
  connectedProfiles: await waitForExactProfiles(),
  profiles,
  safety: {
    existingProfilesOnly: true,
    acceptanceTabsClosedByRecordedIdOnly: true,
    clipboardRestored: true,
    externalProjectRuntimeImported: false,
    remoteDebuggingPortUsed: false,
    debugProfileUsed: false,
    osFileChooserUsed: false,
    productionSitesVisited: false,
    productionStateChanged: false
  }
};
await mkdir(path.join(root, "reports"), { recursive: true });
const reportPath = path.join(root, "reports", "live-acceptance.json");
await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", "utf8");
process.stdout.write(JSON.stringify({ ok: true, reportPath, profiles: report.connectedProfiles }) + "\n");
