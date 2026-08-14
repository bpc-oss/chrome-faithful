// Live verification-handling integration test against real Chrome profiles.
// Uses only the compliant channel: existing bridge + extension (no raw CDP
// ports, no copied profiles). Creates task-owned tabs and closes them after.
//
//   node scripts/verification/live-tests/live-verification-test.mjs [url] [profileName]
//
// Defaults: Cloudflare Turnstile demo page; first online profile.

import { createAgent } from "../../src/agent-browser.mjs";
import { createResilientBridgeRouter } from "../../src/resilient-bridge.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createTabWithNavigation } from "../../src/agent-browser.mjs";
import { detectChallenge, solveCheckbox, captureChallengeAssets, runSolvePipeline, sleep } from "../../src/verification/index.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const TARGET = process.argv[2] || "https://demo.turnstile.workers.dev/";
const WANTED_PROFILE = process.argv[3] || "";
const EVIDENCE_ROOT = resolve("scripts", "verification", "live-tests", "evidence");

function log(step, value) {
  console.log(`\n=== ${step} ===\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

const config = await loadConfig();
const router = await createResilientBridgeRouter(config);
const agent = createAgent(router);
const targets = await agent.browsers.list();
log("PROFILES", targets.map((t) => ({ id: t.id, profileName: t.metadata?.profileName, bindingVerified: t.metadata?.bindingVerified })));

const target = targets.find((t) => WANTED_PROFILE && t.metadata?.profileName === WANTED_PROFILE) || targets[0];
if (!target) {
  console.error("NO_PROFILE_ONLINE");
  process.exit(2);
}
const profileName = target.metadata.profileName;
log("USING_PROFILE", profileName);

const browser = await agent.browsers.get(`extension:${profileName}`);
const tab = await createTabWithNavigation(browser, TARGET);
log("TAB_CREATED", { tabId: tab.id, url: TARGET });

const evaluate = (expression) => tab.playwright.evaluate(expression);
const click = async ({ x, y }) => tab.cua.click({ x, y });
const drag = async ({ path, delays }) => tab.cua.drag({ path, delays });
const screenshot = async ({ clip, savePath }) => {
  const bytes = await tab.screenshot({ clip });
  if (!savePath) return { savedPath: null, bytes: bytes.length };
  await mkdir(dirname(savePath), { recursive: true });
  await writeFile(savePath, bytes);
  return { savedPath: savePath, bytes: bytes.length };
};

try {
  await sleep(4000); // let the widget render

  const first = await detectChallenge({ evaluate, tabId: tab.id });
  log("DETECT_1", first);

  const pipeline = await runSolvePipeline({
    challenge: first.challenges?.[0] ?? { type: "generic", interactive: true },
    evaluate,
    click,
    drag,
    screenshot,
    savePath: resolve(EVIDENCE_ROOT, "challenge.png"),
    backend: null,
    verifyCleared: true,
    timeoutMs: 25000
  });
  log("PIPELINE", pipeline);

  const checkbox = await solveCheckbox({ evaluate, click, timeoutMs: 25000 });
  log("CHECKBOX", checkbox);

  await sleep(3000);
  const after = await detectChallenge({ evaluate, tabId: tab.id });
  log("DETECT_AFTER", after);

  const capture = await captureChallengeAssets({ evaluate, screenshot, savePath: resolve(EVIDENCE_ROOT, "challenge-region.png") });
  log("CAPTURE", capture);

  log("FINAL_TITLE", await tab.title());
} finally {
  try {
    await tab.close();
    log("TAB_CLOSED", { tabId: tab.id });
  } catch (error) {
    log("TAB_CLOSE_ERROR", error.message);
  }
  await router.close();
}
