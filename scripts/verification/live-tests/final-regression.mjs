// Final live regression after review fixes: (1) a badge-only page must NOT be
// detected as a challenge; (2) the click-to-pass page must still solve.
//
//   python -m http.server 18999 --directory scripts/verification/live-tests
//   node scripts/verification/live-tests/final-regression.mjs [profileName]

import { createAgent } from "../../../src/agent-browser.mjs";
import { createResilientBridgeRouter } from "../../../src/resilient-bridge.mjs";
import { loadConfig } from "../../../src/config.mjs";
import { createTabWithNavigation } from "../../../src/agent-browser.mjs";
import { detectChallenge, runSolvePipeline, sleep } from "../../../src/verification/index.mjs";

const BASE = "http://127.0.0.1:18999";
const WANTED_PROFILE = process.argv[2] || "";

const config = await loadConfig();
const router = await createResilientBridgeRouter(config);
const agent = createAgent(router);
const targets = await agent.browsers.list();
const target = targets.find((t) => WANTED_PROFILE && t.metadata?.profileName === WANTED_PROFILE) || targets[0];
const profileName = target.metadata.profileName;
console.log("PROFILE:", profileName);
const browser = await agent.browsers.get(`extension:${profileName}`);

async function probe(name, url) {
  const tab = await createTabWithNavigation(browser, url);
  await sleep(3000);
  const evaluate = (expression) => tab.playwright.evaluate(expression);
  const detection = await detectChallenge({ evaluate, tabId: tab.id });
  console.log(`\n=== ${name} ===\n${JSON.stringify({ detected: detection.detected, resolved: detection.resolved, challenges: detection.challenges.map((c) => ({ type: c.type, pendingRender: c.pendingRender === true })), signals: detection.signals }, null, 2)}`);
  if (name === "CLICK_PASS") {
    const pipeline = await runSolvePipeline({
      challenge: detection.challenges?.[0] ?? { type: "generic", interactive: true },
      evaluate,
      click: async ({ x, y }) => tab.cua.click({ x, y }),
      drag: async ({ path, delays }) => tab.cua.drag({ path, delays }),
      screenshot: async () => ({ savedPath: null, bytes: 0 }),
      timeoutMs: 10000,
      verifyCleared: false
    });
    console.log(`PIPELINE: ${JSON.stringify({ solved: pipeline.solved, reason: pipeline.reason ?? null, steps: pipeline.steps.map((s) => s.action) })}`);
  }
  await tab.close();
}

try {
  await probe("BADGE_ONLY", `${BASE}/fixtures/badge-only-sim.html`);
  await probe("CLICK_PASS", `${BASE}/fixtures/cf-click-pass-sim.html`);
} finally {
  await router.close();
}
