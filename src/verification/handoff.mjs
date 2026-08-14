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
    "If the checkbox never renders, the challenge is silent (invisible mode); wait for it to clear or reload."
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
  const type = challenge?.type || "generic";
  const guidance = CHALLENGE_GUIDANCE[type] || CHALLENGE_GUIDANCE.generic;
  return {
    profileName,
    action: "solve_manually",
    challenge: {
      type,
      provider: challenge?.provider || null,
      confidence: challenge?.confidence ?? null,
      frameUrl: challenge?.frameUrl || null
    },
    guidance,
    ...(note ? { note } : {}),
    resumeWith: "chrome_verification_resume"
  };
}
