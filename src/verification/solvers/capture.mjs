// Capture challenge assets so an external recognition backend (OCR / ASR /
// gap detection) can solve them: the challenge image region as a file, and the
// audio challenge URL. Captured assets are written through the existing
// screenshot path with integrity metadata; nothing is returned to MCP except
// paths, hashes, and the backend's textual answer.

export const CHALLENGE_ASSET_EXPRESSION = `(() => {
  const audio = document.querySelector("audio");
  const audioLinks = [...document.querySelectorAll("a[href*='audio'], a[onclick*='audio'], .rc-audiochallenge-tdownload-link")];
  const recaptchaImage = document.querySelector(".rc-image-tile-wrapper, .rc-imageselect-desc-wrapper, img[src*='captcha']");
  const challengeContainer = document.querySelector(".rc-anchor, .rc-inline-block, [class*=captcha], [class*=challenge], [class*=secsdk]");
  const rect = challengeContainer ? challengeContainer.getBoundingClientRect() : null;
  return {
    audioSrc: audio ? (audio.currentSrc || audio.src) : null,
    audioLink: audioLinks.map((a) => a.href || a.getAttribute("onclick") || "").filter(Boolean)[0] || null,
    hasImageChallenge: !!recaptchaImage,
    containerRect: rect ? { x: rect.left, y: rect.top, width: rect.width, height: rect.height } : null,
    pageHasChallenge: !!(audio || audioLinks.length || recaptchaImage || challengeContainer)
  };
})()`;

export async function captureChallengeAssets({ evaluate, screenshot, savePath }) {
  const assets = await evaluate(CHALLENGE_ASSET_EXPRESSION);
  if (!assets.pageHasChallenge) {
    return { captured: false, reason: "no_challenge_assets" };
  }
  let image = null;
  if (assets.containerRect && typeof screenshot === "function") {
    try {
      const shot = await screenshot({
        clip: {
          x: Math.max(0, Math.floor(assets.containerRect.x)),
          y: Math.max(0, Math.floor(assets.containerRect.y)),
          width: Math.max(1, Math.ceil(assets.containerRect.width)),
          height: Math.max(1, Math.ceil(assets.containerRect.height))
        },
        savePath
      });
      image = {
        path: shot.savedPath || savePath,
        bytes: shot.bytes ?? null,
        sha256: shot.sha256 ?? null
      };
    } catch (error) {
      image = { error: error.message };
    }
  }
  return {
    captured: true,
    image,
    audioSrc: assets.audioSrc,
    audioLink: assets.audioLink,
    hasImageChallenge: assets.hasImageChallenge
  };
}
