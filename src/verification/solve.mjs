// Verification solve orchestrator: pick a strategy per detected challenge
// type and run it. Interaction is done through injected primitives
// (evaluate/click/drag/screenshot) so the same pipeline works for MCP tools
// and JavaScript agents. External recognition (OCR/ASR/gap) is optional via a
// backend.

import { solveCheckbox } from "./solvers/checkbox.mjs";
import { clickChallengeControl } from "./solvers/controls.mjs";
import { solveSlider, SLIDER_VERIFY_DEFAULT } from "./solvers/slider.mjs";
import { captureChallengeAssets } from "./solvers/capture.mjs";
import { waitForChallengeCleared, pollUntil } from "./wait.mjs";

const CHECKBOX_TYPES = new Set(["recaptcha-v2", "hcaptcha", "turnstile"]);
const SLIDER_TYPES = new Set(["geetest", "slider", "vaptcha"]);
const TOKEN_AFTER_CLICK_MIN = 10;

const TOKEN_READ = `(() => {
  const inputs = [...document.querySelectorAll("input[name*='-response'], textarea.g-recaptcha-response, input[name*='captcha']")];
  const values = inputs.map((el) => el.value || "").filter((v) => v.length > 0);
  return values[0] || "";
})()`;

export async function runSolvePipeline({
  challenge,
  evaluate,
  click,
  drag,
  screenshot,
  savePath,
  backend = null,
  verifyCleared = false,
  timeoutMs = 20000
}) {
  const type = challenge?.type || "generic";
  const interactive = challenge?.interactive !== false;
  const steps = [];
  let outcome;

  if (!interactive) {
    // recaptcha-v3 style invisible scoring: nothing to click; wait and re-detect.
    return { solved: false, reason: "non_interactive_challenge", type, steps: [{ action: "none", reason: "invisible scoring; wait and re-detect" }] };
  }

  if (CHECKBOX_TYPES.has(type)) {
    outcome = await solveCheckbox({ evaluate, click, timeoutMs });
    steps.push({ action: "solve_checkbox", ...outcome });
  } else if (SLIDER_TYPES.has(type)) {
    let gap = null;
    if (backend && typeof backend.locateGap === "function" && challenge.frameUrl == null) {
      // Gap detection needs the puzzle image; attempt capture first.
      const capture = await captureChallengeAssets({ evaluate, screenshot, savePath });
      if (capture.image?.path) {
        try {
          const gapResult = await backend.locateGap({ imagePath: capture.image.path });
          if (Number.isFinite(Number(gapResult?.x))) gap = Number(gapResult.x);
        } catch {
          gap = null;
        }
      }
    }
    outcome = await solveSlider({
      evaluate,
      drag,
      gap,
      verifyExpression: SLIDER_VERIFY_DEFAULT,
      timeoutMs
    });
    steps.push({ action: "solve_slider", gapDetected: gap, ...outcome });
  } else {
    // Generic / text-signal / unknown challenges: many pass with a single
    // click (checkbox iframe, "Verify you are human" button, challenge
    // checkbox). Try the obvious click first, wait briefly for a token, and
    // only then fall back to capture/handoff.
    const control = await clickChallengeControl({ evaluate, click });
    steps.push({ action: "click_challenge_control", ...control });
    let token = null;
    if (control.clicked) {
      try {
        token = await pollUntil({
          fn: () => evaluate(TOKEN_READ),
          predicate: (value) => typeof value === "string" && value.length >= TOKEN_AFTER_CLICK_MIN,
          timeoutMs: Math.min(15000, Number(timeoutMs) || 20000),
          intervalMs: 700,
          label: "token after control click"
        });
      } catch {
        token = null;
      }
    }
    if (token) {
      outcome = { solved: true, tokenPrefix: token.slice(0, 24), tokenLength: token.length };
    } else {
      const capture = await captureChallengeAssets({ evaluate, screenshot, savePath });
      let answer = null;
      if (backend && capture.image?.path && typeof backend.solveImage === "function") {
        try {
          const result = await backend.solveImage({ imagePath: capture.image.path });
          answer = result?.text ?? result?.answer ?? null;
        } catch {
          answer = null;
        }
      }
      steps.push({ action: "capture", capture: { image: capture.image?.path ?? null, audioUrl: capture.audioSrc ?? capture.audioLink ?? null }, answer });
      outcome = { solved: false, reason: answer ? "captured_for_backend" : "requires_handoff", answer };
    }
  }

  let cleared = null;
  if (verifyCleared && outcome?.solved) {
    try {
      const result = await waitForChallengeCleared(
        () => evaluate(`(() => { const text = document.body ? document.body.innerText : ""; const hasWidget = !!document.querySelector("[class*=captcha], [class*=challenge], iframe[src*='recaptcha'], iframe[src*='turnstile'], iframe[src*='hcaptcha']"); return { detected: hasWidget || /captcha|验证码|验证失败|请完成验证/i.test(text) }; })()`),
        { timeoutMs: Math.min(60000, timeoutMs + 10000), label: "challenge clear" }
      );
      cleared = result.detected === false;
    } catch {
      cleared = false;
    }
  }

  return { ...outcome, type, steps, cleared };
}
