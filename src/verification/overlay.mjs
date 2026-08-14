// Benign overlay dismissal: cookie banners, onboarding tooltips, "got it"
// popups. Conservative allowlist only — never clicks anything that looks like
// a challenge, and never more than `maxDismissals` elements per call.

export const BENIGN_DISMISS_TEXT = [
  "accept", "accept all", "accept all cookies", "同意", "接受", "全部接受",
  "got it", "知道了", "skip", "跳过", "skip tour", "no thanks", "不用了",
  "dismiss", "忽略", "close", "关闭", "ok", "好的", "开始使用", "开始"
];

export const DISMISS_EXPRESSION = `(() => {
  const allow = new Set(${JSON.stringify(BENIGN_DISMISS_TEXT)});
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && s.opacity !== "0";
  };
  const candidates = [];
  for (const el of document.querySelectorAll("button, [role=button], a, [onclick]")) {
    const text = (el.innerText || el.textContent || "").trim().toLowerCase();
    if (!text || text.length > 40) continue;
    if (!allow.has(text)) continue;
    if (!visible(el)) continue;
    const r = el.getBoundingClientRect();
    candidates.push({ x: r.left + r.width / 2, y: r.top + r.height / 2, text });
  }
  // Keep the topmost candidate per normalized text (dedupe).
  const seen = new Set();
  const picked = [];
  for (const c of candidates) {
    if (seen.has(c.text)) continue;
    seen.add(c.text);
    picked.push(c);
    if (picked.length >= 8) break;
  }
  return picked;
})()`;

export async function dismissBenignOverlays({ evaluate, click, maxDismissals = 3 }) {
  const bounded = Math.min(8, Math.max(0, Number(maxDismissals) || 3));
  const candidates = await evaluate(DISMISS_EXPRESSION);
  const dismissed = [];
  for (const candidate of candidates.slice(0, bounded)) {
    try {
      await click({ x: candidate.x, y: candidate.y });
      dismissed.push({ text: candidate.text, x: candidate.x, y: candidate.y, dismissed: true });
    } catch (error) {
      dismissed.push({ text: candidate.text, x: candidate.x, y: candidate.y, dismissed: false, error: error.message });
    }
  }
  return { dismissed, remaining: Math.max(0, candidates.length - dismissed.length) };
}
