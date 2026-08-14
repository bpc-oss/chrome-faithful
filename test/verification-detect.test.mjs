import test from "node:test";
import assert from "node:assert/strict";
import { classifyChallenges, detectChallenge, DETECT_EXPRESSION, CHALLENGE_TEXT_SIGNALS, PROVIDER_PATTERNS } from "../src/verification/detect.mjs";

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
    tokenLength: 90
  });
  assert.equal(result.detected, false);
  assert.equal(result.resolved, true);
});

test("clean page is not detected", () => {
  const result = classifyChallenges({
    visibleFrames: [],
    allFrames: [],
    textSample: "DashboardEngagements",
    title: "Dashboard"
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
