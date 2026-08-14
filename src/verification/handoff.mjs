// Human handoff guidance: when a challenge cannot (or should not) be solved
// automatically, produce a structured, actionable message for the user who owns
// the real Chrome profile. chrome-faithful drives the user's own logged-in
// browser, so a human can simply complete the challenge in the visible window.

export const CHALLENGE_GUIDANCE = {
  "recaptcha-v2": [
    "Click the \"I'm not a robot\" checkbox in the visible widget.",
    "If an image grid appears, click all images matching the prompt.",
    "If audio is offered, the challenge audio URL can be transcribed by the solve backend (faster-whisper)."
  ],
  "recaptcha-v3": [
    "Invisible scoring challenge; no visible widget. Wait for the page to finish scoring or reload once.",
    "If this repeats, the session may need a fresh visit or a different network egress."
  ],
  hcaptcha: [
    "Click the checkbox in the hCaptcha frame, then complete the image task if one appears."
  ],
  turnstile: [
    "Click the Cloudflare Turnstile checkbox if visible.",
    "If the widget is silent (invisible mode), trigger the page's real submit/verify action so turnstile.execute() runs the actual challenge — a JS click on the submit button works even when the button is off-screen or covered.",
    "If no token arrives after the challenge flow, the session is the usual culprit: sign out and back in (refresh the authentication state), then retry. Field data shows the same profile in a stale session never renders the challenge frame, while a fresh session completes it normally."
  ],
  "turnstile-pending": [
    "The Turnstile widget loaded but its challenge frame did not render — in field data the root cause is a stale/expired session, not a network handshake stall.",
    "Fix order: (1) refresh the session — sign out and sign back in on the same profile (fresh authentication state made the challenge complete normally); (2) trigger the page's real submit/verify button with a JS click so turnstile.execute() starts the actual challenge; (3) reload the page once and retry; (4) only then complete the challenge manually in the visible browser window.",
    "Never monkey-patch window.turnstile (getResponse / render-with-immediate-callback / injecting the hidden input): the backend validates the real token (fake/empty tokens are rejected, e.g. HTTP 422), and patching the widget callback cannot produce one."
  ],
  "recaptcha-v2-pending": [
    "A reCAPTCHA widget is present but its challenge frame did not render — first refresh the session (sign out/in) and trigger the page's real submit action; only if that fails treat it as a network/Google stall.",
    "Reload the page once and retry, or complete the challenge manually in the visible browser window."
  ],
  geetest: [
    "Drag the slider to align the gap in the puzzle image.",
    "The gap position can be located automatically by the opencv backend if configured."
  ],
  "image-select": [
    "Click every image that matches the prompt text shown above the grid."
  ],
  slider: [
    "Drag the slider to the target position (usually the right end)."
  ],
  generic: [
    "A verification challenge is active. Complete it in the visible browser window, then resume."
  ]
};

export function buildHandoffMessage({ profileName, challenge, note = null }) {
  let type = challenge?.type || "generic";
  if (challenge?.pendingRender === true && (type === "turnstile" || type === "recaptcha-v2")) {
    type = `${type}-pending`;
  }
  const guidance = CHALLENGE_GUIDANCE[type] || CHALLENGE_GUIDANCE.generic;
  return {
    profileName,
    action: "solve_manually",
    challenge: {
      type: challenge?.type || "generic",
      provider: challenge?.provider || null,
      confidence: challenge?.confidence ?? null,
      frameUrl: challenge?.frameUrl || null,
      pendingRender: challenge?.pendingRender === true
    },
    guidance,
    ...(note ? { note } : {}),
    resumeWith: "chrome_verification_resume"
  };
}
