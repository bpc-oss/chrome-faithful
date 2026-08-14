// Shared page-expression fragments, single-sourced so the token selector and
// the visibility guard cannot drift between modules. Each fragment is a plain
// JS snippet interpolated into self-contained evaluate expressions at
// definition time (no runtime injection).

export const VISIBLE_FN = `const visible = (el) => {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  const s = getComputedStyle(el);
  return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
};`;

// Hidden response-token inputs used by reCAPTCHA / Turnstile / hCaptcha.
export const TOKEN_INPUT_SELECTOR = `input[name*='-response'], textarea.g-recaptcha-response, input[name*='captcha']`;

// Real challenge widget wrappers. Deliberately excludes the ubiquitous
// reCAPTCHA badge (grecaptcha-badge), which is a static marker, not a widget.
export const WIDGET_CONTAINER_SELECTOR = `.cf-turnstile, #cf-turnstile, .g-recaptcha, #g-recaptcha, [class*=turnstile], [class*=geetest], [class*=challenge-checkbox], [class*=captcha-checkbox]`;

// Classes that are static provider markers, never challenge widgets.
export const STATIC_MARKER_PATTERN = /(?:grecaptcha-badge|grecaptcha-logo|grecaptcha-errors)/i;
