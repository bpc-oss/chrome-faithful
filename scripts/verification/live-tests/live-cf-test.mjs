// Live Cloudflare Turnstile integration test with real CF test sitekeys:
//   1x00000000000000000000AA  always-pass widget  (full detect -> solve -> resolved)
//   3x00000000000000000000FF  forced interactive challenge (checkbox -> puzzle)
// Fixtures are served from a local HTTP server on port 18999:
//
//   python -m http.server 18999 --directory scripts/verification/live-tests
//   node scripts/verification/live-tests/live-cf-test.mjs [profileName]

import { createAgent } from "../../src/agent-browser.mjs";
import { createResilientBridgeRouter } from "../../src/resilient-bridge.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createTabWithNavigation } from "../../src/agent-browser.mjs";
import { detectChallenge, solveCheckbox, captureChallengeAssets, runSolvePipeline, sleep } from "../../src/verification/index.mjs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const BASE = "http://127.0.0.1:18999";
const PASS_PAGE = `${BASE}/fixtures/cf-pass-test.html`;
const INTERACTIVE_PAGE = `${BASE}/fixtures/cf-interactive-test.html`;
const WANTED_PROFILE = process.argv[2] || "";
const EVIDENCE_ROOT = resolve("scripts", "verification", "live-tests", "evidence");

function log(step, value) {
  console.log(`\n=== ${step} ===\n${typeof value === "string" ? value : JSON.stringify(value, null, 2)}`);
}

const config = await loadConfig();
const router = await createResilientBridgeRouter(config);
const agent = createAgent(router);
const targets = await agent.browsers.list();
log("PROFILES", targets.map((t) => ({ profileName: t.metadata?.profileName, bindingVerified: t.metadata?.bindingVerified })));
const target = targets.find((t) => WANTED_PROFILE && t.metadata?.profileName === WANTED_PROFILE) || targets[0];
if (!target) { console.error("NO_PROFILE_ONLINE"); process.exit(2); }
const profileName = target.metadata.profileName;
log("USING_PROFILE", profileName);

const browser = await agent.browsers.get(`extension:${profileName}`);
let tab;
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

async function runPage(name, url, pathTag) {
  log(`${name}_NAVIGATE`, url);
  tab = await createTabWithNavigation(browser, url);
  await sleep(5000);
  const first = await detectChallenge({ evaluate, tabId: tab.id });
  log(`${name}_DETECT`, first);

  const pipeline = await runSolvePipeline({
    challenge: first.challenges?.[0] ?? { type: "turnstile", interactive: true },
    evaluate, click, drag, screenshot,
    savePath: resolve(EVIDENCE_ROOT, `${pathTag}-challenge.png`),
    backend: null,
    verifyCleared: false,
    timeoutMs: 20000
  });
  log(`${name}_PIPELINE`, pipeline);

  const checkbox = await solveCheckbox({ evaluate, click, timeoutMs: 20000 });
  log(`${name}_CHECKBOX`, checkbox);

  await sleep(4000);
  const after = await detectChallenge({ evaluate, tabId: tab.id });
  log(`${name}_DETECT_AFTER`, after);

  const capture = await captureChallengeAssets({ evaluate, screenshot, savePath: resolve(EVIDENCE_ROOT, `${pathTag}-region.png`) });
  log(`${name}_CAPTURE`, capture);

  const iframeEvidence = await evaluate(`(() => {
    const frames = [...document.querySelectorAll("iframe")].map(f => (f.src || "").slice(0, 160));
    const widget = document.querySelector(".cf-turnstile");
    const wrect = widget ? (() => { const r = widget.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })() : null;
    return { frames, widget: wrect };
  })()`);
  log(`${name}_IFRAME_EVIDENCE`, iframeEvidence);

  try { await tab.close(); log(`${name}_TAB_CLOSED`, tab.id); } catch (error) { log(`${name}_TAB_CLOSE_ERROR`, error.message); }
}

try {
  await runPage("PASS", PASS_PAGE, "pass");
  await runPage("INTERACTIVE", INTERACTIVE_PAGE, "interactive");
} finally {
  await router.close();
}
