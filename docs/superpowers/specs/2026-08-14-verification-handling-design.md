# Verification Handling Design (0.4.0)

Date: 2026-08-14
Status: implemented
Scope: `src/verification/` + MCP tools + `scripts/verification/captcha-backend-adapter.py`

## Context

Chrome Faithful drives the user's *real, logged-in* Chrome profiles, which is
the strongest available defense against bot detection ("real browser + real
fingerprint"). When a platform still presents a human-verification challenge,
agents need a structured way to: detect it, decide between solving it and
handing it to the human owner of the profile, and resume cleanly.

This module consolidates techniques proven in earlier automation projects:

- **Detect-and-hold**: when a captcha popup is visible, stop acting and report
  `captcha_challenge_active` instead of retrying blindly.
- **Checkbox + token wait**: click the visible challenge checkbox and poll the
  hidden response token until it is populated.
- **Humanized input**: bezier trajectories, jitter, monotonic-x slider drags,
  ease-in-out timing — plausible interaction that also reduces false triggers.
- **Recognition backends**: audio transcription (faster-whisper), image OCR
  (baidu/Unlimited-OCR, tesseract, ddddocr), slider gap detection (opencv) —
  all external to this repository and reachable through a small JSON protocol.

## Architecture

```
MCP tool (chrome_verification_*) or JS agent
        │  evaluate / click / drag / screenshot primitives
        ▼
src/verification/
  detect.mjs     multi-signal detection & classification (iframe providers,
                 DOM text signals, hidden token inputs, challenge URLs)
  hold.mjs       per-profile hold state machine (idle → challenge_detected →
                 waiting_for_human → cleared) with bounded transition log
  handoff.mjs    structured human guidance per challenge type
  overlay.mjs    conservative benign-overlay dismissal (cookie/onboarding)
  input.mjs      seeded bezier paths, jitter, monotonic-x, drag delays
  wait.mjs       bounded polling / challenge-clear waits
  solve.mjs      strategy orchestrator (checkbox | slider | capture+backend)
  solvers/
    checkbox.mjs click widget + poll hidden token
    slider.mjs   locate handle, humanized drag to track end or gap offset
    capture.mjs  screenshot challenge region / audio URL for external brains
    backends.mjs CliBackend / HttpBackend + env parsing
scripts/verification/captcha-backend-adapter.py
                 reference JSON adapter for the Python recognition stack
```

## Detection

`DETECT_EXPRESSION` runs inside the tab and returns iframe sources, visible
widgets, a bounded text sample, and hidden token-input state.
`classifyChallenges()` maps iframe sources to providers:

| Provider | Confidence (visible) | Confidence (loaded) | Interactive |
|---|---|---|---|
| recaptcha-v2 | 0.95 | 0.7 | yes |
| recaptcha-v3 | 0.95 | 0.7 | no (invisible scoring) |
| hcaptcha | 0.95 | 0.7 | yes |
| turnstile | 0.95 | 0.7 | yes |
| geetest | 0.95 | 0.7 | yes |
| vaptcha | 0.95 | 0.7 | yes |
| generic (text signals only) | 0.55 | — | yes |

A populated challenge token with no challenge frame is reported as
`resolved` — the invisible challenge already completed.

## Solve strategies

| Challenge type | Strategy |
|---|---|
| recaptcha-v2 / hcaptcha / turnstile | checkbox click + token wait (`solveCheckbox`) |
| geetest / vaptcha / slider | humanized drag (`solveSlider`), optional gap from backend |
| image-select / generic | capture image/audio, submit to backend (OCR/ASR), else handoff |
| recaptcha-v3 | non-interactive: report and wait/re-detect |

## Backend protocol

Recognition brains are optional. Enable via
`AGENTOS_VERIFICATION_BACKEND` (e.g.
`cli:python scripts/verification/captcha-backend-adapter.py` or an
`http://127.0.0.1:18001` endpoint). The adapter speaks JSON over stdin/stdout:

```json
{"action": "status"}
{"action": "solve-audio", "audioPath": "..."}
{"action": "solve-audio", "audioUrl": "..."}
{"action": "solve-image", "imagePath": "..."}
{"action": "locate-gap", "imagePath": "..."}
```

Responses are JSON (`{"text": "12345"}`, `{"x": 123.0}`) on stdout; failures
are JSON errors on stderr with a non-zero exit.

## Hold state machine

`VerificationHold` keeps one state per profile. `chrome_verification_detect`
optionally records a hold; `chrome_verification_solve` clears it on success and
promotes to `waiting_for_human` on handoff; `chrome_verification_resume`
clears explicitly. The transition log (bounded at 50, newest first) makes the
sequence auditable.

## Security & safety notes

- Everything operates inside the user's own exact profile; no copied data, no
  debug port, no UI automation.
- Benign overlay dismissal uses a strict text allowlist and never touches
  challenge widgets.
- Captured assets are saved through the standard screenshot path; cookies and
  signed URLs are never returned through MCP.
- Solver backends are opt-in; without one, detection/hold/handoff/overlay/
  humanized interaction still work.

## Live verification results (2026-08-14)

Driven through the compliant bridge channel against the real `Baoping` Chrome
profile (`scripts/verification/live-tests/`):

| Scenario | Outcome |
|---|---|
| Cloudflare Turnstile demo (`demo.turnstile.workers.dev`) | Widget found and clicked; token read (`XXXX.DUMMY.TOKEN.XXXX` — the documented dummy token). No challenge iframe ever appears in the main document on this profile. |
| Local page, always-pass test sitekey `1x00000000000000000000AA` | **`resolved: true`** — the populated token is correctly recognized as a completed widget, not a blocker. |
| Local page, forced-interactive sitekey `3x00000000000000000000FF` | **`widget_pending_render`** — api.js loaded, `window.turnstile` API present, but the challenge iframe never renders and the token stays empty. The solver now reports this precise diagnosis instead of a misleading timeout. |
| Diagnostic probe | `.cf-turnstile` container exists (70 px tall) with only an empty hidden `cf-turnstile-response` input; `frames: []`; no shadow root. Matches the earlier documented finding that Cloudflare's handshake stalls in this environment/profile. |

Live findings drove three fixes: (1) detection now distinguishes *resolved* /
*pending-render* / *active provider iframe* states (pending-widget classified
before text signals, text signals suppressed when a token is populated);
(2) `solveCheckbox` reports `widget_pending_render` when the challenge frame
never appears; (3) handoff carries reload-and-retry guidance for the
pending-render state.

## Known limits and follow-ups

- Cross-origin challenge iframes (hCaptcha/Turnstile run as OOPIFs) cannot be
  reached by page-context evaluation; visible-widget interaction (checkbox
  click) works because the widget is in the top document, while in-iframe
  content solving requires frame-targeted CDP evaluation (follow-up).
- Extension event-channel integration (`verification.challenge_detected` in
  `chrome_page_event_v2`) is a follow-up; today the state is readable through
  `chrome_verification_status`.
- The Python adapter degrades gracefully: with the Agent OS captcha stack
  importable it uses it; otherwise standalone faster-whisper/ddddocr/opencv
  fallbacks are attempted and `status` reports exactly what is available.
