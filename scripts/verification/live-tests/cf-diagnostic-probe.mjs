// Diagnostic probe for the "widget rendered but challenge iframe missing"
// state (a known Cloudflare Turnstile stall in some networks/profiles).
//
//   python -m http.server 18999 --directory scripts/verification/live-tests
//   node scripts/verification/live-tests/cf-diagnostic-probe.mjs [profileName]

import { createAgent } from "../../src/agent-browser.mjs";
import { createResilientBridgeRouter } from "../../src/resilient-bridge.mjs";
import { loadConfig } from "../../src/config.mjs";
import { createTabWithNavigation } from "../../src/agent-browser.mjs";
import { sleep } from "../../src/verification/index.mjs";

const URL = "http://127.0.0.1:18999/fixtures/cf-interactive-test.html";
const WANTED_PROFILE = process.argv[2] || "";

const config = await loadConfig();
const router = await createResilientBridgeRouter(config);
const agent = createAgent(router);
const targets = await agent.browsers.list();
const target = targets.find((t) => WANTED_PROFILE && t.metadata?.profileName === WANTED_PROFILE) || targets[0];
const profileName = target.metadata.profileName;
console.log("PROFILE:", profileName);

const browser = await agent.browsers.get(`extension:${profileName}`);
const tab = await createTabWithNavigation(browser, URL);
await sleep(6000);

const dump = await tab.playwright.evaluate(`(() => {
  const out = { url: location.href, title: document.title };
  out.apiScripts = [...document.scripts].map(s => s.src).filter(s => /turnstile|challenges/.test(s));
  out.turnstileApi = typeof window.turnstile;
  out.turnstileKeys = window.turnstile ? Object.keys(window.turnstile) : [];
  out.allFrames = [...document.querySelectorAll("iframe")].map(f => ({ src: f.src, cls: f.className }));
  const widget = document.querySelector(".cf-turnstile");
  out.widgetFound = !!widget;
  out.widgetHtml = widget ? widget.outerHTML.slice(0, 400) : null;
  out.widgetChildren = widget ? [...widget.children].map(c => c.tagName + ":" + (c.className || "") + ":" + (c.src || "").slice(0, 80)) : [];
  out.shadowRoots = widget && widget.shadowRoot ? "widget-has-shadow" : "no-shadow";
  return out;
})()`);
console.log(JSON.stringify(dump, null, 2));

try { await tab.close(); } catch {}
await router.close();
