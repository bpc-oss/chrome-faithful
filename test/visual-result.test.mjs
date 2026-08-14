import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_VISUAL_BLOCKS,
  MAX_VISUAL_BLOCK_TEXT,
  MAX_VISUAL_DESCRIPTION_TEXT,
  normalizeVisualResult
} from "../src/visual/result.mjs";
import { MAX_VISUAL_PIXELS, readPngDimensions } from "../src/visual/png.mjs";

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

test("reads dimensions from a PNG IHDR", () => {
  assert.deepEqual(readPngDimensions(pngHeader(1920, 1080)), {
    width: 1920,
    height: 1080
  });
});

test("rejects non-PNG input before invoking a visual backend", () => {
  assert.throws(() => readPngDimensions(Buffer.alloc(24)), /valid PNG/);
});

test("rejects PNG dimensions above the visual pixel budget", () => {
  assert.throws(
    () => readPngDimensions(pngHeader(MAX_VISUAL_PIXELS, 2)),
    /pixel limit/
  );
});

test("normalizes PP-OCR pixel boxes to unit coordinates", () => {
  const result = normalizeVisualResult({
    blocks: [{ text: "登录", confidence: 0.98, box: [20, 10, 120, 40] }]
  }, { width: 200, height: 100, mode: "ocr" });

  assert.deepEqual(result, {
    ocr: {
      blocks: [{
        text: "登录",
        confidence: 0.98,
        bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 }
      }]
    }
  });
});

test("clamps OCR rectangles to image bounds", () => {
  const result = normalizeVisualResult({
    blocks: [{ text: "edge", confidence: 1, box: [-10, -5, 120, 80] }]
  }, { width: 100, height: 50, mode: "ocr" });

  assert.deepEqual(result.ocr.blocks[0].bounds, {
    x: 0,
    y: 0,
    width: 1,
    height: 1
  });
});

test("rejects invalid or excessive OCR backend output", () => {
  assert.throws(() => normalizeVisualResult({
    blocks: [{ text: "x", confidence: Number.NaN, box: [0, 0, 1, 1] }]
  }, { width: 1, height: 1, mode: "ocr" }), /invalid visual backend output/);

  assert.throws(() => normalizeVisualResult({
    blocks: [{ text: "x".repeat(MAX_VISUAL_BLOCK_TEXT + 1), confidence: 1, box: [0, 0, 1, 1] }]
  }, { width: 1, height: 1, mode: "ocr" }), /invalid visual backend output/);

  assert.throws(() => normalizeVisualResult({
    blocks: Array.from({ length: MAX_VISUAL_BLOCKS + 1 }, () => ({
      text: "x", confidence: 1, box: [0, 0, 1, 1]
    }))
  }, { width: 1, height: 1, mode: "ocr" }), /invalid visual backend output/);
});

test("rejects unknown OCR fields and reversed rectangles", () => {
  assert.throws(() => normalizeVisualResult({ blocks: [], path: "secret.png" }, {
    width: 1, height: 1, mode: "ocr"
  }), /invalid visual backend output/);

  assert.throws(() => normalizeVisualResult({
    blocks: [{ text: "x", confidence: 1, box: [1, 1, 0, 0] }]
  }, { width: 1, height: 1, mode: "ocr" }), /invalid visual backend output/);
});

test("accepts only a bounded semantic description", () => {
  assert.deepEqual(
    normalizeVisualResult({ description: "A login form." }, {
      width: 100, height: 50, mode: "semantic"
    }),
    { semantic: { description: "A login form." } }
  );

  assert.throws(() => normalizeVisualResult({
    description: "x".repeat(MAX_VISUAL_DESCRIPTION_TEXT + 1)
  }, { width: 100, height: 50, mode: "semantic" }), /invalid visual backend output/);
  assert.throws(() => normalizeVisualResult({ description: "ok", imageBase64: "AA==" }, {
    width: 100, height: 50, mode: "semantic"
  }), /invalid visual backend output/);
});
