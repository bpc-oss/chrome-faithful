// Challenge detection for one exact profile tab. Multi-signal: visible
// challenge iframes by provider domain, DOM text signals, hidden token inputs,
// and known challenge page patterns. Classification is heuristic; `confidence`
// lets callers choose between auto-solve, handoff, or ignore.

import { VISIBLE_FN, TOKEN_INPUT_SELECTOR, WIDGET_CONTAINER_SELECTOR, STATIC_MARKER_PATTERN } from "./expr.mjs";

export const PROVIDER_PATTERNS = [
  { provider: "recaptcha-v2", interactive: true, patterns: [/^https:\/\/www\.google\.com\/recaptcha\/api2\//, /^https:\/\/recaptcha\.google\.com\//] },
  { provider: "recaptcha-v3", interactive: false, patterns: [/recaptcha\/api3\//] },
  { provider: "hcaptcha", interactive: true, patterns: [/^https:\/\/newassets\.hcaptcha\.com\//, /hcaptcha\.com\/captcha/] },
  { provider: "turnstile", interactive: true, patterns: [/challenges\.cloudflare\.com/] },
  { provider: "geetest", interactive: true, patterns: [/geetest\.com/, /gt4\.geetest\.com/] },
  { provider: "vaptcha", interactive: true, patterns: [/vaptcha\.net/, /vaptcha\.com/] },
  { provider: "generic", interactive: true, patterns: [/captcha/i, /\/verify\//i, /security-check/i, /human-verification/i] }
];

export const CHALLENGE_TEXT_SIGNALS = [
  "验证码", "人机验证", "请完成验证", "拖动滑块", "滑动验证", "点击完成验证",
  "verify you are human", "security check", "i'm not a robot",
  "enter the captcha", "captcha code", "captcha required", "captcha verification",
  "无法验证", "验证失败", "正在进行安全验证", "cf-chl", "turnstile",
  "not a robot", "are you human"
];

// Runs inside the tab; returns raw signals for classifyChallenges().
export const DETECT_EXPRESSION = `(() => {
  ${VISIBLE_FN}
  const allFrames = [...document.querySelectorAll("iframe")].map((f) => f.src || "").filter(Boolean);
  const visibleFrames = [...document.querySelectorAll("iframe")].filter(visible).map((f) => f.src || "").filter(Boolean);
  const text = [document.title, document.body ? document.body.innerText.slice(0, 3000) : ""].join("\\n");
  const tokenInputs = [...document.querySelectorAll(${JSON.stringify(TOKEN_INPUT_SELECTOR)})];
  const tokenValues = tokenInputs.map((el) => el.value || "").filter((v) => v.length > 0);
  // Real challenge widgets only. The ubiquitous reCAPTCHA badge
  // (grecaptcha-badge) is a static marker and must never count as a widget.
  const widgetContainers = [...document.querySelectorAll(${JSON.stringify(WIDGET_CONTAINER_SELECTOR)})]
    .filter((w) => !new RegExp(${JSON.stringify(STATIC_MARKER_PATTERN.source)}, "i").test((w.className || "").toString()))
    .filter(visible);
  const pendingWidgets = widgetContainers.filter((w) => {
    const hasIframe = !!w.querySelector("iframe");
    const input = w.querySelector(${JSON.stringify(TOKEN_INPUT_SELECTOR)});
    return !hasIframe && !(input && input.value);
  }).map((w) => (w.className || "").toString()).filter(Boolean);
  return {
    url: location.href,
    title: document.title,
    allFrames,
    visibleFrames,
    textSample: text.slice(0, 1500),
    tokenPresent: tokenInputs.length > 0,
    tokenPopulated: tokenValues.length > 0,
    tokenLength: tokenValues.reduce((n, v) => n + v.length, 0),
    pendingWidgets
  };
})()`;

export function classifyChallenges(page) {
  const challenges = [];
  const seen = new Set();
  const push = (entry) => {
    const key = `${entry.type}|${entry.frameUrl || ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    challenges.push(entry);
  };
  for (const frameUrl of page.visibleFrames || []) {
    for (const { provider, interactive, patterns } of PROVIDER_PATTERNS) {
      if (patterns.some((pattern) => pattern.test(frameUrl))) {
        push({ type: provider, provider, confidence: 0.95, interactive, frameUrl });
        break;
      }
    }
  }
  for (const frameUrl of page.allFrames || []) {
    const already = challenges.some((c) => c.frameUrl === frameUrl);
    if (already) continue;
    for (const { provider, interactive, patterns } of PROVIDER_PATTERNS) {
      if (patterns.some((pattern) => pattern.test(frameUrl))) {
        push({ type: provider, provider, confidence: 0.7, interactive, frameUrl });
        break;
      }
    }
  }
  const text = ((page.textSample || "") + " " + (page.title || "")).toLowerCase();
  const textHits = CHALLENGE_TEXT_SIGNALS.filter((signal) => text.includes(signal.toLowerCase()));
  // Widget rendered but no provider iframe and no token: stuck pre-render.
  // Field data shows the usual cause is a stale/expired session rather than
  // flaky networks — see handoff guidance "refresh session → trigger real
  // submit". More specific than a bare text signal, so it is classified first.
  // Static provider markers (e.g. the reCAPTCHA badge) are filtered again here
  // as defense in depth.
  const pendingClasses = (page.pendingWidgets || []).filter((c) => !STATIC_MARKER_PATTERN.test(c));
  if (challenges.length === 0 && pendingClasses.length > 0) {
    const joined = pendingClasses.join(" ").toLowerCase();
    const type = /turnstile|cf-/.test(joined) ? "turnstile"
      : /recaptcha|g-recaptcha/.test(joined) ? "recaptcha-v2"
      : "generic";
    push({ type, provider: "widget-pending", confidence: 0.6, interactive: true, frameUrl: null, pendingRender: true, widgetClasses: pendingClasses });
  }
  // Text signals alone are weak evidence; a populated token means the widget
  // already completed, so suppress the text-signal path in that case.
  if (textHits.length > 0 && challenges.length === 0 && page.tokenPopulated !== true) {
    push({ type: "generic", provider: "text-signal", confidence: 0.55, interactive: true, frameUrl: null, textHits });
  }
  // A populated challenge token input strongly suggests an active invisible
  // challenge already completed; not a blocker.
  const resolved = (page.tokenPopulated === true && challenges.length === 0);
  return {
    detected: challenges.length > 0,
    resolved,
    challenges,
    signals: {
      frames: (page.allFrames || []).length,
      visibleFrames: (page.visibleFrames || []).length,
      textHits,
      tokenPresent: page.tokenPresent === true,
      tokenPopulated: page.tokenPopulated === true,
      pendingWidgets: (page.pendingWidgets || []).length
    }
  };
}

export async function detectChallenge({ evaluate, tabId }) {
  const page = await evaluate(DETECT_EXPRESSION);
  return classifyChallenges(page);
}
