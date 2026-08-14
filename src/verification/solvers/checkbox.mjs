// Checkbox challenge solver (reCAPTCHA v2 / Cloudflare Turnstile visible
// checkbox): locate the visible challenge control, click it, then poll until
// the hidden response token input is populated. Mirrors a
// `_wait_for_turnstile_token` style poll.
//
// Field lesson: a widget stuck in `widget_pending_render` (container present,
// challenge iframe never rendered, token stays empty) is most often caused by
// a **stale/expired session**, not by the network or the provider. On the same
// real profile, refreshing the session (sign out → sign in, fresh
// authentication state) made the challenge render and complete normally. The
// correct escalation for pending-render is therefore: refresh session →
// trigger the page's real submit/verify button with a JS click (btn.click()
// works even when the locator times out because the button is off-screen/
// covered) → reload-and-retry → handoff. Never monkey-patch window.turnstile
// (getResponse / render-with-immediate-callback / hidden-input injection):
// backends validate the real token and patching the widget callback cannot
// fabricate one.

import { pollUntil } from "../wait.mjs";
import { clickChallengeControl } from "./controls.mjs";
import { TOKEN_INPUT_SELECTOR, WIDGET_CONTAINER_SELECTOR } from "../expr.mjs";

export const TOKEN_READ_EXPRESSION = `(() => {
  const inputs = [...document.querySelectorAll(${JSON.stringify(TOKEN_INPUT_SELECTOR)})];
  const values = inputs.map((el) => el.value || "").filter((v) => v.length > 0);
  return values[0] || "";
})()`;

export const WIDGET_STATE_EXPRESSION = `(() => {
  const widget = document.querySelector(${JSON.stringify(WIDGET_CONTAINER_SELECTOR)});
  if (!widget) return null;
  const iframe = widget.querySelector("iframe");
  const input = widget.querySelector(${JSON.stringify(TOKEN_INPUT_SELECTOR)});
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
      return {
        solved: false,
        reason: "widget_pending_render",
        widget: control.kind,
        widgetClass: state.widgetClass,
        error: error.message,
        next: "refresh-session-then-trigger-real-submit" // stale session is the usual root cause
      };
    }
    return { solved: false, reason: "token_timeout", widget: control.kind, error: error.message };
  }
  return { solved: true, widget: control.kind, tokenPrefix: token.slice(0, 24), tokenLength: token.length };
}
