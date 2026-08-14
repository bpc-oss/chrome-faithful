import { createHash } from "node:crypto";

import { readPngDimensions } from "./png.mjs";
import { MAX_VISUAL_RESULT_BYTES, normalizeVisualResult } from "./result.mjs";

export const MAX_VISUAL_PROMPT_TEXT = 1_000;
export const MAX_VISUAL_SCREENSHOT_BYTES = 50_331_648;

const MODES = new Set(["ocr", "semantic", "both"]);
const SAFE_BACKEND_KIND = /^[a-z0-9][a-z0-9-]{0,63}$/;

function backendKind(backend) {
  return SAFE_BACKEND_KIND.test(backend?.kind || "") ? backend.kind : "local-backend";
}

function validateClip(clip) {
  if (clip === undefined) return;
  if (
    clip === null
    || typeof clip !== "object"
    || Array.isArray(clip)
    || Object.keys(clip).some((key) => !["x", "y", "width", "height"].includes(key))
    || ![clip.x, clip.y, clip.width, clip.height].every(Number.isFinite)
    || clip.x < 0
    || clip.y < 0
    || clip.width <= 0
    || clip.height <= 0
  ) {
    throw new Error("visual clip must contain finite non-negative coordinates and positive dimensions");
  }
}

function validatePrompt(prompt, mode) {
  if (prompt === undefined) return;
  if (mode === "ocr") throw new Error("visual prompt is available only in semantic or both mode");
  if (typeof prompt !== "string" || prompt.length > MAX_VISUAL_PROMPT_TEXT) {
    throw new Error("visual prompt exceeds the supported limit");
  }
}

function assertBackendResponse(raw, stage) {
  if (raw?.error && stage === "ocr") {
    const code = raw.error?.code;
    if (code === "PPOCR_LOCAL_MODELS_REQUIRED") {
      throw new Error("local OCR backend requires configured PP-OCRv5 model directories");
    }
    if (code === "PPOCR_RUNTIME_UNAVAILABLE") {
      throw new Error("local OCR backend requires Python and the PaddleOCR runtime");
    }
    throw new Error("local OCR backend failed");
  }
  if (raw?.error) throw new Error("local semantic backend failed");
  return raw;
}

function enforceFinalResult(result) {
  serializeVisualResult(result);
  return result;
}

export function serializeVisualResult(result) {
  const text = JSON.stringify(result);
  if (Buffer.byteLength(text, "utf8") > MAX_VISUAL_RESULT_BYTES) {
    throw new Error("visual result exceeds the supported output limit");
  }
  return text;
}

export async function runVisualExtract({
  screenshot,
  mode = "ocr",
  clip,
  fullPage = false,
  prompt,
  ocrBackend,
  vlmBackend
}) {
  if (typeof screenshot !== "function") throw new Error("visual screenshot source is unavailable");
  if (!MODES.has(mode)) throw new Error("unsupported visual extraction mode");
  if (typeof fullPage !== "boolean") throw new Error("visual fullPage must be a boolean");
  validateClip(clip);
  if (fullPage && clip !== undefined) {
    throw new Error("visual clip and fullPage are mutually exclusive");
  }
  validatePrompt(prompt, mode);
  if ((mode === "ocr" || mode === "both") && !ocrBackend) {
    throw new Error("local OCR backend is not configured");
  }
  if (mode === "semantic" && !vlmBackend) {
    throw new Error("local semantic backend is not configured");
  }

  let bytes;
  try {
    bytes = Buffer.from(await screenshot({ fullPage, clip }));
  } catch {
    throw new Error("visual screenshot capture failed");
  }
  if (bytes.length > MAX_VISUAL_SCREENSHOT_BYTES) {
    throw new Error("visual screenshot exceeds the supported byte limit");
  }
  const { width, height } = readPngDimensions(bytes);
  const payload = {
    imageBase64: bytes.toString("base64"),
    mimeType: "image/png",
    width,
    height
  };
  const result = {
    image: {
      width,
      height,
      sha256: createHash("sha256").update(bytes).digest("hex")
    }
  };

  if (mode === "ocr" || mode === "both") {
    const raw = assertBackendResponse(await ocrBackend.request({
      ...payload,
      action: "ocr"
    }), "ocr");
    const normalized = normalizeVisualResult(raw, { width, height, mode: "ocr" });
    result.ocr = {
      backend: backendKind(ocrBackend),
      ...normalized.ocr
    };
  }

  if (mode === "semantic" || mode === "both") {
    try {
      const raw = assertBackendResponse(await vlmBackend.request({
        ...payload,
        action: "semantic",
        ...(prompt === undefined ? {} : { prompt })
      }), "semantic");
      const normalized = normalizeVisualResult(raw, { width, height, mode: "semantic" });
      result.semantic = {
        backend: backendKind(vlmBackend),
        ...normalized.semantic
      };
    } catch (error) {
      if (mode === "semantic") {
        if (error?.message === "invalid visual backend output") throw error;
        throw new Error("local semantic backend failed");
      }
      result.partial = {
        stage: "semantic",
        error: "local semantic backend failed"
      };
    }
  }

  return enforceFinalResult(result);
}
