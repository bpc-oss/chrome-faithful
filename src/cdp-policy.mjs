export function publicCdpEventOptions(options = {}) {
  const { includeSensitive: _ignored, ...safeOptions } = options || {};
  return { ...safeOptions, includeSensitive: false };
}
