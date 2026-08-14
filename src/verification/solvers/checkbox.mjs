// Checkbox challenge solver (reCAPTCHA v2 / Cloudflare Turnstile visible
// checkbox): locate the visible widget, click it with a human-like jittered
// click, then poll until the hidden response token input is populated.
// Mirrors the revenue-trial `_wait_for_turnstile_token` approach.

import { pollUntil } from "../wait.mjs";
import { clickChallengeControl, CLICKABLE_CONTROL_EXPRESSION } from "./controls.mjs";

export { CLICKABLE_CONTROL_EXPRESSION };

export const CHECKBOX_LOCATE_EXPRESSION = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const candidates = [];
  const push = (el, kind) => {
    const r = el.getBoundingClientRect();
    candidates.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, kind, width: r.width, height: r.height });
  };
  for (const el of document.querySelectorAll(".g-recaptcha, #g-recaptcha, .cf-turnstile, #cf-turnstile, [class*=challenge-checkbox], [class*=captcha-checkbox], .rc-anchor")) {
    if (visible(el)) push(el, "widget");
  }
  for (const el of document.querySelectorAll("iframe")) {
    const src = el.src || "";
    if (/recaptcha|hcaptcha|turnstile|challenges\.cloudflare/.test(src) && visible(el)) push(el, "provider-frame");
  }
  candidates.sort((a, b) => (a.kind === "provider-frame" ? 1 : 0) - (b.kind === "provider-frame" ? 1 : 0));
  return candidates[0] || null;
})()`;

export const TOKEN_READ_EXPRESSION = `(() => {
  const inputs = [...document.querySelectorAll("input[name*='-response'], textarea.g-recaptcha-response, input[name*='captcha']")];
  const values = inputs.map((el) => el.value || "").filter((v) => v.length > 0);
  return values[0] || "";
})()`;

export const WIDGET_STATE_EXPRESSION = `(() => {
  const widget = document.querySelector(".cf-turnstile, #cf-turnstile, .g-recaptcha");
  if (!widget) return null;
  const iframe = widget.querySelector("iframe");
  const input = widget.querySelector("input[name*='-response'], input[name*='captcha']");
  return {
    hasIframe: !!iframe,
    tokenPopulated: !!(input && input.value),
    widgetClass: (widget.className || "").toString()
  };
})()`;

export async function solveCheckbox({ evaluate, click, tokenMinLength = 20, timeoutMs = 20000 }) {
  const control = await clickChallengeControl({ evaluate, click });
  if (!control.clicked) return { solved: false, reason: control.reason || "checkbox_not_found" };
  let token = null;
  try {
    token = await pollUntil({
      fn: () => evaluate(TOKEN_READ_EXPRESSION),
      predicate: (value) => typeof value === "string" && value.length >= Math.max(1, Number(tokenMinLength) || 20),
      timeoutMs,
      intervalMs: 600,
      label: "challenge token"
    });
  } catch (error) {
    // Distinguish a widget stuck in its pre-render handshake (no challenge
    // iframe ever appeared) from a real interactive challenge that simply
    // was not solved in time.
    let state = null;
    try {
      state = await evaluate(WIDGET_STATE_EXPRESSION);
    } catch {
      state = null;
    }
    if (state && !state.hasIframe && !state.tokenPopulated) {
      return { solved: false, reason: "widget_pending_render", widget: control.kind, widgetClass: state.widgetClass, error: error.message };
    }
    return { solved: false, reason: "token_timeout", widget: control.kind, error: error.message };
  }
  return { solved: true, widget: control.kind, tokenPrefix: token.slice(0, 24), tokenLength: token.length };
}
