// Challenge detection for one exact profile tab. Multi-signal: visible
// challenge iframes by provider domain, DOM text signals, hidden token inputs,
// and known challenge page patterns. Classification is heuristic; `confidence`
// lets callers choose between auto-solve, handoff, or ignore.

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
  "verify you are human", "security check", "captcha", "i'm not a robot",
  "无法验证", "验证失败", "正在进行安全验证", "cf-chl", "turnstile",
  "not a robot", "are you human"
];

// Runs inside the tab; returns raw signals for classifyChallenges().
export const DETECT_EXPRESSION = `(() => {
  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const allFrames = [...document.querySelectorAll("iframe")].map((f) => f.src || "").filter(Boolean);
  const visibleFrames = [...document.querySelectorAll("iframe")].filter(visible).map((f) => f.src || "").filter(Boolean);
  const text = [document.title, document.body ? document.body.innerText.slice(0, 3000) : ""].join("\\n");
  const tokenInputs = [...document.querySelectorAll("input[name*='-response'], input[name*='captcha'], textarea.g-recaptcha-response")];
  const tokenValues = tokenInputs.map((el) => el.value || "").filter((v) => v.length > 0);
  const checkboxFrames = [...document.querySelectorAll("iframe")].filter(visible).map((f) => f.src || "");
  return {
    url: location.href,
    title: document.title,
    allFrames,
    visibleFrames,
    checkboxFrames,
    textSample: text.slice(0, 1500),
    tokenPresent: tokenInputs.length > 0,
    tokenPopulated: tokenValues.length > 0,
    tokenLength: tokenValues.reduce((n, v) => n + v.length, 0)
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
  if (textHits.length > 0 && challenges.length === 0) {
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
      tokenPopulated: page.tokenPopulated === true
    }
  };
}

export async function detectChallenge({ evaluate, tabId }) {
  const page = await evaluate(DETECT_EXPRESSION);
  return classifyChallenges(page);
}
