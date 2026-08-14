// Generic "click the challenge control" solver. Many verifications pass with
// a single click: a checkbox iframe, a "Verify you are human" button, or a
// checkbox inside a challenge container. Resolution order (highest specificity
// first): visible provider iframe > verify button by text/aria > challenge
// checkbox > widget container. The first match is clicked at its exact center
// in page coordinates.

import { VISIBLE_FN } from "../expr.mjs";

export const CLICKABLE_CONTROL_EXPRESSION = `(() => {
  ${VISIBLE_FN}
  const candidates = [];
  const push = (x, y, kind, score) => candidates.push({ x, y, kind, score });
  for (const frame of document.querySelectorAll("iframe")) {
    const src = frame.src || "";
    if (/recaptcha|hcaptcha|turnstile|challenges\\.cloudflare|geetest/.test(src) && visible(frame)) {
      const r = frame.getBoundingClientRect();
      push(r.left + r.width / 2, r.top + r.height / 2, "provider-frame", 100);
    }
  }
  for (const el of document.querySelectorAll("button, [role=button], a, div[onclick], span[onclick]")) {
    const text = (el.innerText || el.textContent || "").trim().toLowerCase();
    const aria = (el.getAttribute("aria-label") || "").toLowerCase();
    if (!visible(el) || text.length > 60) continue;
    if (/verify you are human|i'?m not a robot|please verify|human verification|验证|人机验证|点击验证|继续|开始验证/.test(text + " " + aria)) {
      const r = el.getBoundingClientRect();
      push(r.left + r.width / 2, r.top + r.height / 2, "verify-button", 90);
    }
  }
  for (const el of document.querySelectorAll("[class*=challenge] input[type=checkbox], [class*=captcha] input[type=checkbox], #challenge-stage input[type=checkbox]")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    push(r.left + r.width / 2, r.top + r.height / 2, "challenge-checkbox", 80);
  }
  for (const el of document.querySelectorAll(".cf-turnstile, #cf-turnstile, .g-recaptcha, #g-recaptcha")) {
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    push(r.left + r.width / 2, r.top + r.height / 2, "widget-container", 60);
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
})()`;

export async function clickChallengeControl({ evaluate, click }) {
  const control = await evaluate(CLICKABLE_CONTROL_EXPRESSION);
  if (!control) return { clicked: false, reason: "no_clickable_control" };
  await click({ x: control.x, y: control.y });
  return { clicked: true, kind: control.kind, x: control.x, y: control.y };
}
