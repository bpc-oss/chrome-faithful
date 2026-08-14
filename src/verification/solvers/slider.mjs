// Slider challenge solver: locate the handle, compute the target x (track end
// or an optional gap position from a backend such as opencv gap detection),
// drag with a humanized bezier trajectory (monotonic x, jitter, ease-in-out
// delays), then optionally poll a verification expression.

import { humanizeDrag } from "../input.mjs";
import { pollUntil } from "../wait.mjs";
import { VISIBLE_FN } from "../expr.mjs";

export const SLIDER_LOCATE_EXPRESSION = (selector) => `(() => {
  ${VISIBLE_FN}
  const handle = ${selector ? `document.querySelector(${JSON.stringify(selector)})` : `[...document.querySelectorAll("div, span, img, button")].find((el) => {
    const cls = (el.className || "").toString();
    const label = (el.getAttribute("aria-label") || "").toLowerCase();
    const text = (el.innerText || "").trim().toLowerCase();
    return visible(el) && (/slider|drag|slide|handle|btn_slide|secsdk-captcha-drag/i.test(cls + " " + label + " " + text));
  })`};
  if (!handle) return null;
  const hr = handle.getBoundingClientRect();
  const track = handle.parentElement ? handle.parentElement.getBoundingClientRect() : null;
  return {
    handleCenter: { x: hr.left + hr.width / 2, y: hr.top + hr.height / 2 },
    handleWidth: hr.width,
    track: track ? { left: track.left, right: track.right, top: track.top, bottom: track.bottom } : null,
    tag: handle.tagName,
    className: (handle.className || "").toString().slice(0, 80)
  };
})()`;

export const SLIDER_VERIFY_DEFAULT = `(() => {
  // Common success signals: the widget disappears or the page reports ok.
  const text = document.body ? document.body.innerText : "";
  const gone = !document.querySelector("[class*=slider], [class*=captcha], [class*=secsdk]");
  const ok = /success|验证通过|solved/i.test(text);
  return gone || ok;
})()`;

export async function solveSlider({
  evaluate,
  drag,
  selector = null,
  gap = null,
  verifyExpression = null,
  timeoutMs = 15000,
  seed = null
}) {
  const located = await evaluate(SLIDER_LOCATE_EXPRESSION(selector));
  if (!located) return { solved: false, reason: "slider_not_found" };
  if (!located.track) return { solved: false, reason: "slider_track_not_found" };

  let targetX = located.track.right - located.handleWidth / 2;
  if (gap != null && Number.isFinite(gap)) {
    targetX = located.track.left + Number(gap);
  }
  const from = { x: located.handleCenter.x, y: located.handleCenter.y };
  const to = { x: targetX, y: located.handleCenter.y };
  // A gap behind the handle is a degenerate configuration (e.g. a gap offset
  // measured against the wrong coordinate space); fail closed instead of
  // dragging backwards or producing a zero-distance drag.
  if (to.x < from.x) {
    return { solved: false, reason: "slider_target_behind_handle", from, to };
  }
  const effectiveSeed = seed ?? (Date.now() & 0x7fffffff) >>> 0;
  const { points, delays } = humanizeDrag(from, to, { seed: effectiveSeed });

  const moveResults = await drag({ path: points, delays });
  const attempted = { from, to, points: points.length, moved: moveResults ?? true };

  let verified = null;
  if (verifyExpression) {
    try {
      const outcome = await pollUntil({
        fn: () => evaluate(verifyExpression),
        predicate: (value) => value === true,
        timeoutMs,
        intervalMs: 600,
        label: "slider verification"
      });
      verified = outcome === true;
    } catch (error) {
      verified = false;
    }
  }
  return { solved: verifyExpression ? verified === true : true, ...attempted, verified };
}
