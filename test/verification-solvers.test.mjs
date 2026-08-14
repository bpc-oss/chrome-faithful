import test from "node:test";
import assert from "node:assert/strict";
import { solveSlider } from "../src/verification/solvers/slider.mjs";
import { solveCheckbox, CHECKBOX_LOCATE_EXPRESSION, TOKEN_READ_EXPRESSION } from "../src/verification/solvers/checkbox.mjs";
import { clickChallengeControl } from "../src/verification/solvers/controls.mjs";
import { captureChallengeAssets } from "../src/verification/solvers/capture.mjs";
import { runSolvePipeline } from "../src/verification/solve.mjs";

const SLIDER_PAGE = {
  handleCenter: { x: 40, y: 100 },
  handleWidth: 20,
  track: { left: 20, right: 200, top: 90, bottom: 110 }
};

test("solveSlider drags a monotonic humanized path to the track end", async () => {
  const drags = [];
  const result = await solveSlider({
    evaluate: async () => SLIDER_PAGE,
    drag: async ({ path, delays }) => { drags.push({ path, delays }); },
    selector: ".handle"
  });
  assert.equal(result.solved, true);
  assert.equal(result.to.x, 190);
  assert.ok(result.points >= 2);
  const path = drags[0].path;
  for (let i = 1; i < path.length; i += 1) {
    assert.ok(path[i].x >= path[i - 1].x, "slider drag must not move backwards");
  }
  assert.equal(drags[0].delays.length, path.length - 1);
});

test("solveSlider honors an explicit gap offset", async () => {
  const drags = [];
  const result = await solveSlider({
    evaluate: async () => SLIDER_PAGE,
    drag: async ({ path }) => { drags.push(path); },
    selector: ".handle",
    gap: 80
  });
  assert.equal(result.to.x, 100);
});

test("solveSlider reports not-found cleanly", async () => {
  const result = await solveSlider({
    evaluate: async () => null,
    drag: async () => {},
    selector: ".missing"
  });
  assert.equal(result.solved, false);
  assert.equal(result.reason, "slider_not_found");
});

test("solveCheckbox clicks the challenge control and polls for a token", async () => {
  let tokenValue = "";
  const clicks = [];
  const result = await solveCheckbox({
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("input[name")) return tokenValue; // TOKEN_READ_EXPRESSION
      if (source.includes("provider-frame")) return { x: 300, y: 200, kind: "provider-frame" }; // CLICKABLE_CONTROL_EXPRESSION
      return null;
    },
    click: async ({ x, y }) => {
      clicks.push({ x, y });
      tokenValue = "x".repeat(60);
    },
    timeoutMs: 3000
  });
  assert.equal(result.solved, true);
  assert.equal(clicks.length, 1);
  assert.deepEqual(clicks[0], { x: 300, y: 200 });
  assert.equal(result.tokenLength, 60);
  assert.equal(result.widget, "provider-frame");
});

test("solveCheckbox reports widget_pending_render when the challenge frame never appears", async () => {
  const result = await solveCheckbox({
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("hasIframe")) return { hasIframe: false, tokenPopulated: false, widgetClass: "cf-turnstile" }; // WIDGET_STATE_EXPRESSION
      if (source.includes("input[name")) return ""; // TOKEN_READ_EXPRESSION
      if (source.includes("provider-frame")) return { x: 1, y: 1, kind: "widget-container" }; // CLICKABLE_CONTROL_EXPRESSION
      return null;
    },
    click: async () => {},
    timeoutMs: 1200
  });
  assert.equal(result.solved, false);
  assert.equal(result.reason, "widget_pending_render");
  assert.equal(result.widgetClass, "cf-turnstile");
});

test("solveCheckbox times out when no token appears and the widget state is unknown", async () => {
  const result = await solveCheckbox({
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("input[name")) return "";
      if (source.includes("provider-frame")) return { x: 1, y: 1, kind: "provider-frame" };
      return null; // WIDGET_STATE_EXPRESSION -> unknown state
    },
    click: async () => {},
    timeoutMs: 1200
  });
  assert.equal(result.solved, false);
  assert.equal(result.reason, "token_timeout");
});

test("clickChallengeControl returns no_clickable_control when nothing matches", async () => {
  const result = await clickChallengeControl({ evaluate: async () => null, click: async () => {} });
  assert.equal(result.clicked, false);
  assert.equal(result.reason, "no_clickable_control");
});

test("captureChallengeAssets returns image path and audio URL", async () => {
  const result = await captureChallengeAssets({
    evaluate: async () => ({
      audioSrc: "https://example.test/audio.mp3",
      audioLink: null,
      hasImageChallenge: true,
      containerRect: { x: 0, y: 0, width: 300, height: 200 },
      pageHasChallenge: true
    }),
    screenshot: async ({ clip, savePath }) => ({ savedPath: savePath, bytes: 123 }),
    savePath: "C:\\tmp\\captcha.png"
  });
  assert.equal(result.captured, true);
  assert.equal(result.image.path, "C:\\tmp\\captcha.png");
  assert.equal(result.audioSrc, "https://example.test/audio.mp3");
});

test("runSolvePipeline solves a checkbox challenge and clears the hold state", async () => {
  let token = "";
  const challenge = { type: "turnstile", provider: "turnstile", interactive: true };
  const result = await runSolvePipeline({
    challenge,
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("input[name")) return token; // TOKEN_READ_EXPRESSION
      if (source.includes("provider-frame")) return { x: 300, y: 200, kind: "provider-frame" }; // CLICKABLE_CONTROL_EXPRESSION
      return null;
    },
    click: async () => { token = "t".repeat(40); },
    drag: async () => {},
    screenshot: async () => ({ savedPath: null, bytes: 0 }),
    timeoutMs: 2000,
    verifyCleared: false
  });
  assert.equal(result.solved, true);
  assert.equal(result.type, "turnstile");
});

test("runSolvePipeline clicks a generic verify button and solves click-to-pass challenges", async () => {
  let token = "";
  const challenge = { type: "generic", provider: "text-signal", interactive: true };
  const result = await runSolvePipeline({
    challenge,
    evaluate: async (expression) => {
      const source = String(expression);
      if (source.includes("input[name")) return token;
      if (source.includes("provider-frame")) return { x: 200, y: 150, kind: "verify-button" };
      return null;
    },
    click: async () => { token = "TOKENSIM-1234567890"; },
    drag: async () => {},
    screenshot: async () => ({ savedPath: null, bytes: 0 }),
    timeoutMs: 5000,
    verifyCleared: false
  });
  assert.equal(result.solved, true);
  assert.equal(result.steps[0].action, "click_challenge_control");
  assert.equal(result.steps[0].kind, "verify-button");
  assert.equal(result.tokenLength, 19);
});

test("runSolvePipeline captures generic challenges for a backend answer", async () => {
  const challenge = { type: "image-select", provider: "generic", interactive: true };
  const backend = {
    solveImage: async ({ imagePath }) => ({ text: "58321" })
  };
  const result = await runSolvePipeline({
    challenge,
    evaluate: async (expression) => {
      if (String(expression).includes("provider-frame")) return null; // no clickable control
      return {
        audioSrc: null,
        audioLink: null,
        hasImageChallenge: true,
        containerRect: { x: 0, y: 0, width: 200, height: 150 },
        pageHasChallenge: true
      };
    },
    click: async () => {},
    drag: async () => {},
    screenshot: async ({ savePath }) => ({ savedPath: savePath, bytes: 55 }),
    savePath: "C:\\tmp\\challenge.png",
    backend,
    timeoutMs: 2000
  });
  assert.equal(result.answer, "58321");
  assert.ok(result.steps.some((step) => step.action === "capture"));
});
