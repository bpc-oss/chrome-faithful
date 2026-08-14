export const MAX_VISUAL_PIXELS = 40_000_000;

const PNG_SIGNATURE = "89504e470d0a1a0a";

export function readPngDimensions(bytes) {
  const png = Buffer.from(bytes);
  if (
    png.length < 24
    || png.subarray(0, 8).toString("hex") !== PNG_SIGNATURE
    || png.readUInt32BE(8) !== 13
    || png.subarray(12, 16).toString("ascii") !== "IHDR"
  ) {
    throw new Error("visual capture did not return a valid PNG");
  }

  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (
    width < 1
    || height < 1
    || width > Math.floor(MAX_VISUAL_PIXELS / height)
  ) {
    throw new Error("visual capture exceeds the supported pixel limit");
  }
  return { width, height };
}
