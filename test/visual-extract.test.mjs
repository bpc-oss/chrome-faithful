import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { MAX_VISUAL_PROMPT_TEXT, runVisualExtract } from "../src/visual/extract.mjs";

function pngFixture(width = 200, height = 100) {
  const bytes = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

const image = pngFixture();
const imageSha256 = createHash("sha256").update(image).digest("hex");
const fakeOcrBackend = {
  kind: "fake-ocr",
  async request(payload) {
    assert.equal(payload.action, "ocr");
    assert.equal(payload.mimeType, "image/png");
    assert.equal(payload.width, 200);
    assert.equal(payload.height, 100);
    assert.equal(Buffer.from(payload.imageBase64, "base64").equals(image), true);
    return {
      blocks: [{ text: "登录", confidence: 0.98, box: [20, 10, 120, 40] }]
    };
  }
};

test("defaults to viewport OCR and returns normalized text-only output", async () => {
  const result = await runVisualExtract({
    screenshot: async (options) => {
      assert.deepEqual(options, { fullPage: false, clip: undefined });
      return image;
    },
    ocrBackend: fakeOcrBackend
  });

  assert.deepEqual(result, {
    image: { width: 200, height: 100, sha256: imageSha256 },
    ocr: {
      backend: "fake-ocr",
      blocks: [{
        text: "登录",
        confidence: 0.98,
        bounds: { x: 0.1, y: 0.1, width: 0.5, height: 0.3 }
      }]
    }
  });
  assert.doesNotMatch(JSON.stringify(result), /imageBase64|AA==|localPath|savedPath/);
});

test("rejects clip plus fullPage before capturing", async () => {
  let captured = false;
  await assert.rejects(() => runVisualExtract({
    screenshot: async () => { captured = true; },
    mode: "ocr",
    clip: { x: 0, y: 0, width: 10, height: 10 },
    fullPage: true,
    ocrBackend: fakeOcrBackend
  }), /mutually exclusive/);
  assert.equal(captured, false);
});

test("rejects malformed clip bounds before capturing", async () => {
  let captured = false;
  await assert.rejects(() => runVisualExtract({
    screenshot: async () => { captured = true; },
    clip: { x: 0, y: 0, width: -1, height: 10 },
    ocrBackend: fakeOcrBackend
  }), /clip/);
  assert.equal(captured, false);
});

test("semantic mode fails before capture when no VLM is configured", async () => {
  let captured = false;
  await assert.rejects(() => runVisualExtract({
    screenshot: async () => { captured = true; },
    mode: "semantic"
  }), /semantic backend is not configured/);
  assert.equal(captured, false);
});

test("both mode preserves OCR and returns a bounded partial VLM failure", async () => {
  const result = await runVisualExtract({
    screenshot: async () => image,
    mode: "both",
    prompt: "Describe the form",
    ocrBackend: fakeOcrBackend,
    vlmBackend: {
      kind: "fake-vlm",
      async request() {
        throw new Error("secret backend diagnostics and local path C:\\models");
      }
    }
  });

  assert.equal(result.ocr.blocks[0].text, "登录");
  assert.deepEqual(result.partial, {
    stage: "semantic",
    error: "local semantic backend failed"
  });
  assert.doesNotMatch(JSON.stringify(result), /secret|models/);
});

test("semantic mode returns a bounded description", async () => {
  const result = await runVisualExtract({
    screenshot: async () => image,
    mode: "semantic",
    prompt: "Describe the form",
    vlmBackend: {
      kind: "fake-vlm",
      async request(payload) {
        assert.equal(payload.action, "semantic");
        assert.equal(payload.prompt, "Describe the form");
        return { description: "A login form with two fields." };
      }
    }
  });
  assert.deepEqual(result.semantic, {
    backend: "fake-vlm",
    description: "A login form with two fields."
  });
});

test("prompt is forbidden for OCR and bounded for semantic modes", async () => {
  for (const input of [
    { mode: "ocr", prompt: "describe" },
    { mode: "semantic", prompt: "x".repeat(MAX_VISUAL_PROMPT_TEXT + 1) }
  ]) {
    await assert.rejects(() => runVisualExtract({
      screenshot: async () => image,
      ...input,
      ocrBackend: fakeOcrBackend,
      vlmBackend: { kind: "fake-vlm", request: async () => ({ description: "ok" }) }
    }), /prompt/);
  }
});

test("known PP-OCR setup errors are actionable without reflecting raw output", async () => {
  await assert.rejects(() => runVisualExtract({
    screenshot: async () => image,
    ocrBackend: {
      kind: "ppocrv5-mobile",
      async request() {
        return {
          error: {
            code: "PPOCR_LOCAL_MODELS_REQUIRED",
            message: "private path must not escape"
          }
        };
      }
    }
  }), (error) => {
    assert.match(error.message, /model directories/);
    assert.doesNotMatch(error.message, /private path/);
    return true;
  });
});
