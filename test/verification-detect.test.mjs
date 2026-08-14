import test from "node:test";
import assert from "node:assert/strict";
import { classifyChallenges, detectChallenge, DETECT_EXPRESSION, CHALLENGE_TEXT_SIGNALS, PROVIDER_PATTERNS } from "../src/verification/detect.mjs";
import { WIDGET_CONTAINER_SELECTOR, STATIC_MARKER_PATTERN } from "../src/verification/expr.mjs";

test("visible recaptcha v2 iframe is detected with high confidence", () => {
  const result = classifyChallenges({
    visibleFrames: ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=sitekey"],
    allFrames: ["https://www.google.com/recaptcha/api2/anchor?ar=1&k=sitekey"],
    textSample: "",
    title: "sign in"
  });
  assert.equal(result.detected, true);
  assert.equal(result.challenges[0].type, "recaptcha-v2");
  assert.equal(result.challenges[0].confidence, 0.95);
  assert.equal(result.challenges[0].interactive, true);
});

test("turnstile iframe is detected as turnstile", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/orchestrate/jsch/v1"],
    textSample: "Submitting form",
    title: ""
  });
  assert.equal(result.detected, true);
  assert.equal(result.challenges[0].type, "turnstile");
  assert.equal(result.challenges[0].confidence, 0.7);
});

test("text signals alone yield a generic medium-confidence challenge", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "请完成人机验证 拖动滑块",
    title: ""
  });
  assert.equal(result.detected, true);
  assert.equal(result.challenges[0].type, "generic");
  assert.equal(result.challenges[0].confidence, 0.55);
});

test("populated token without a challenge frame means resolved, not blocked", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "",
    title: "",
    tokenPresent: true,
    tokenPopulated: true,
    tokenLength: 90,
    pendingWidgets: []
  });
  assert.equal(result.detected, false);
  assert.equal(result.resolved, true);
});

test("widget rendered but no iframe and no token is a pending-render challenge", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "",
    title: "",
    tokenPresent: true,
    tokenPopulated: false,
    tokenLength: 0,
    pendingWidgets: ["cf-turnstile"]
  });
  assert.equal(result.detected, true);
  assert.equal(result.challenges[0].type, "turnstile");
  assert.equal(result.challenges[0].pendingRender, true);
  assert.equal(result.challenges[0].confidence, 0.6);
});

test("pending reCAPTCHA widget class is classified as recaptcha-v2", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "",
    title: "",
    tokenPresent: false,
    tokenPopulated: false,
    tokenLength: 0,
    pendingWidgets: ["g-recaptcha"]
  });
  assert.equal(result.challenges[0].type, "recaptcha-v2");
  assert.equal(result.challenges[0].pendingRender, true);
});

test("a populated token suppresses the text-signal path even when challenge words appear", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "turnstile widget on this page",
    title: "Turnstile",
    tokenPresent: true,
    tokenPopulated: true,
    tokenLength: 21,
    pendingWidgets: []
  });
  assert.equal(result.detected, false);
  assert.equal(result.resolved, true);
});

test("pending widget is classified ahead of a text signal", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "please complete the turnstile verification",
    title: "",
    tokenPresent: true,
    tokenPopulated: false,
    tokenLength: 0,
    pendingWidgets: ["cf-turnstile"]
  });
  assert.equal(result.detected, true);
  assert.equal(result.challenges[0].type, "turnstile");
  assert.equal(result.challenges[0].pendingRender, true);
});

test("the reCAPTCHA badge is never treated as a pending widget", () => {
  assert.ok(STATIC_MARKER_PATTERN.test("grecaptcha-badge"), "badge class must be recognized as a static marker");
  assert.ok(!WIDGET_CONTAINER_SELECTOR.includes("[class*=captcha]"), "widget selector must not match the badge by substring");
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "",
    title: "",
    tokenPresent: false,
    tokenPopulated: false,
    tokenLength: 0,
    pendingWidgets: ["grecaptcha-badge"]
  });
  assert.equal(result.detected, false);
  assert.equal(result.challenges.length, 0);
});

test("a badge-only page with a populated token is resolved, not detected", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "",
    title: "",
    tokenPresent: true,
    tokenPopulated: true,
    tokenLength: 21,
    pendingWidgets: ["grecaptcha-badge"]
  });
  assert.equal(result.detected, false);
  assert.equal(result.resolved, true);
});

test("clean page is not detected", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "DashboardEngagements",
    title: "Dashboard",
    pendingWidgets: []
  });
  assert.equal(result.detected, false);
});

test("detectChallenge runs the detection expression through evaluate", async () => {
  let capturedExpression = null;
  const evaluate = async (expression) => {
    capturedExpression = expression;
    return {
      visibleFrames: ["https://challenges.cloudflare.com/x"],
      allFrames: ["https://challenges.cloudflare.com/x"],
      textSample: "",
      title: "",
      tokenPresent: false,
      tokenPopulated: false,
      tokenLength: 0
    };
  };
  const result = await detectChallenge({ evaluate });
  assert.equal(capturedExpression, DETECT_EXPRESSION);
  assert.equal(result.detected, true);
  assert.equal(result.challenges[0].type, "turnstile");
});

test("challenge text signal list is non-empty and provider patterns cover the major widgets", () => {
  assert.ok(CHALLENGE_TEXT_SIGNALS.length > 5);
  const providers = PROVIDER_PATTERNS.map((p) => p.provider);
  for (const expected of ["recaptcha-v2", "hcaptcha", "turnstile", "geetest"]) {
    assert.ok(providers.includes(expected), `missing provider ${expected}`);
  }
});
