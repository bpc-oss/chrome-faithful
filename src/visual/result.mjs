export const MAX_VISUAL_BLOCKS = 2_000;
export const MAX_VISUAL_BLOCK_TEXT = 4_096;
export const MAX_VISUAL_DESCRIPTION_TEXT = 16_384;
export const MAX_VISUAL_RESULT_BYTES = 1_048_576;

const INVALID_OUTPUT = "invalid visual backend output";

function fail() {
  throw new Error(INVALID_OUTPUT);
}

function hasOnlyKeys(value, allowed) {
  return value !== null
    && typeof value === "object"
    && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.has(key));
}

function boundedText(value, maximum) {
  if (typeof value !== "string" || value.length > maximum) fail();
  return value;
}

function unit(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function normalizeBlock(block, width, height) {
  if (!hasOnlyKeys(block, new Set(["text", "confidence", "box"]))) fail();
  const text = boundedText(block.text, MAX_VISUAL_BLOCK_TEXT);
  const confidence = block.confidence;
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) fail();
  if (!Array.isArray(block.box) || block.box.length !== 4) fail();
  const [left, top, right, bottom] = block.box;
  if (![left, top, right, bottom].every(Number.isFinite)) fail();
  if (right < left || bottom < top) fail();

  const x1 = Math.min(width, Math.max(0, left));
  const y1 = Math.min(height, Math.max(0, top));
  const x2 = Math.min(width, Math.max(0, right));
  const y2 = Math.min(height, Math.max(0, bottom));
  return {
    text,
    confidence,
    bounds: {
      x: unit(x1 / width),
      y: unit(y1 / height),
      width: unit(Math.max(0, x2 - x1) / width),
      height: unit(Math.max(0, y2 - y1) / height)
    }
  };
}

function enforceResultBytes(result) {
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > MAX_VISUAL_RESULT_BYTES) fail();
  return result;
}

export function normalizeVisualResult(raw, { width, height, mode }) {
  if (!Number.isInteger(width) || width < 1 || !Number.isInteger(height) || height < 1) fail();

  if (mode === "ocr") {
    if (!hasOnlyKeys(raw, new Set(["blocks"])) || !Array.isArray(raw.blocks)) fail();
    if (raw.blocks.length > MAX_VISUAL_BLOCKS) fail();
    return enforceResultBytes({
      ocr: { blocks: raw.blocks.map((block) => normalizeBlock(block, width, height)) }
    });
  }

  if (mode === "semantic") {
    if (!hasOnlyKeys(raw, new Set(["description"]))) fail();
    return enforceResultBytes({
      semantic: { description: boundedText(raw.description, MAX_VISUAL_DESCRIPTION_TEXT) }
    });
  }

  fail();
}
